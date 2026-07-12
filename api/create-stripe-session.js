// api/create-stripe-session.js
// Handles two Stripe Checkout operations dispatched by request body shape:
//
//   POST { seats, eventName, ... }  → create a Checkout session (original behavior)
//   POST { sessionId }              → verify a session's payment status (was verify-stripe-session.js)
//
// Backward compatible: callers that already send `seats` or `sessionId`
// require no changes. An optional explicit `action` field is also supported:
//   action: 'create'  → force create path
//   action: 'verify'  → force verify path
//
// v2 (Jul 2026): SERVER-SIDE PRICE VALIDATION added to the create path. Previously
// unit_amount was built directly from the client-supplied seat.price with no check
// against the event's actual configured pricing — a modified client payload could
// charge any amount, including near-zero, on any venue. Now every seat's price is
// checked against the real prices pulled from Supabase for that event_id before a
// Stripe session is created; the request is rejected (400) if any seat's price
// isn't one of the event's own published tier/section prices, and rejected if the
// event can't be found or has no pricing configured at all (fail-closed, not
// fail-open). NOTE: `serviceFee` is still accepted as-is from the client and is
// NOT validated here — that's tracked separately as the Model C wiring gap
// (service fee % not yet set in event config on most events) and needs its own
// pass once that number exists.
//
// REQUIRES: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
// env vars in Vercel — same Supabase project used by stripe-webhook.js. Confirm
// these exact var names match whatever stripe-webhook.js already uses; if that
// file uses different names, update the two lines below to match rather than
// adding a third set of env vars.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const stripeKey = process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: 'Stripe key not configured' });

    const stripe = Stripe(stripeKey);
    const body = req.body || {};

    // ── Route: verify session ────────────────────────────────────────────────
    // Triggered by explicit action:'verify' OR presence of sessionId without seats
    const isVerify = body.action === 'verify' || (!body.action && body.sessionId && !body.seats);

    if (isVerify) {
          const { sessionId } = body;
          if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
          try {
                  const session = await stripe.checkout.sessions.retrieve(sessionId);
                  if (session.payment_status === 'paid') {
                            return res.status(200).json({
                                        success: true,
                                        paid: true,
                                        customerEmail: session.customer_email || session.customer_details?.email,
                                        amountTotal: session.amount_total,
                                        metadata: session.metadata,
                            });
                  } else {
                            return res.status(200).json({ success: true, paid: false, status: session.payment_status });
                  }
          } catch (err) {
                  console.error('Stripe verify error:', err.message);
                  return res.status(500).json({ error: 'Failed to verify session', detail: err.message });
          }
    }

    // ── Route: create session ────────────────────────────────────────────────
    const {
          seats,
          eventName,
          venueUrl,
          buyerEmail,
          serviceFee,
          venueStripeAccountId,
          holdIds,
          eventId,
          buyerName,
          buyerPhone,
          buyerZip,
          buyerAgeRange,
          buyerReferral,
          optInEmail,
          optInSms,
          payment,
          wallet,
    } = body;

    if (!seats || !seats.length) return res.status(400).json({ error: 'No seats provided' });

    // ── Server-side price validation ────────────────────────────────────────
    // Fail closed: no eventId, no Supabase config, no event found, or no
    // pricing configured on the event → refuse the checkout rather than
    // trusting whatever the client sent.
    if (!eventId) return res.status(400).json({ error: 'Missing eventId — cannot verify pricing' });
    if (!supabase) {
        console.error('create-stripe-session: Supabase not configured — refusing to trust client-supplied prices');
        return res.status(500).json({ error: 'Server price validation unavailable' });
    }

    const { data: event, error: evErr } = await supabase
        .from('events')
        .select('id, tier1_price, tier2_price, tier3_price, pricing')
        .eq('id', eventId)
        .single();

    if (evErr || !event) {
        console.error('create-stripe-session: event lookup failed for', eventId, evErr?.message);
        return res.status(400).json({ error: 'Event not found — cannot verify pricing' });
    }

    // Build the set of prices (in cents) this event actually allows, from
    // whichever pricing model it uses — flat/3-tier columns (Club Chaotic,
    // Casino By The Beach) and/or the per-section pricing jsonb (Coral
    // Springs, Center For The Arts). Both are checked so this one function
    // works across every venue's data shape without needing to duplicate
    // each venue's seat-to-tier geometry here.
    const allowedPricesCents = new Set();
    [event.tier1_price, event.tier2_price, event.tier3_price].forEach(p => {
        if (typeof p === 'number' && p > 0) allowedPricesCents.add(Math.round(p * 100));
    });
    if (event.pricing && typeof event.pricing === 'object') {
        Object.values(event.pricing).forEach(sec => {
            if (!sec || typeof sec !== 'object') return;
            if (typeof sec.price === 'number') allowedPricesCents.add(Math.round(sec.price * 100));
            ['tier1', 'tier2', 'tier3'].forEach(t => {
                if (sec[t] && typeof sec[t].price === 'number') allowedPricesCents.add(Math.round(sec[t].price * 100));
            });
        });
    }

    if (allowedPricesCents.size === 0) {
        console.error('create-stripe-session: event', eventId, 'has no configured pricing — refusing checkout');
        return res.status(400).json({ error: 'Event has no configured pricing — cannot process payment' });
    }

    for (const seat of seats) {
        const cents = Math.round((seat.price || 0) * 100);
        if (!allowedPricesCents.has(cents)) {
            console.error(
                'create-stripe-session: REJECTED seat price', seat.price,
                'for event', eventId, '(seat', seat.label || seat.key, ') — allowed prices were',
                [...allowedPricesCents].map(c => c / 100)
            );
            return res.status(400).json({
                error: `Ticket price for ${seat.label || seat.key} does not match this event's published pricing.`,
            });
        }
    }

    try {
          const lineItems = seats.map(seat => ({
                  price_data: {
                            currency: 'usd',
                            product_data: { name: `${eventName} — ${seat.label || seat.key} (${seat.tier || 'General'})` },
                            unit_amount: Math.round((seat.price + (serviceFee || 0)) * 100),
                  },
                  quantity: 1,
          }));

      const successUrl = `${venueUrl}/#stripe_success=true&session_id={CHECKOUT_SESSION_ID}`;
          const cancelUrl = `${venueUrl}/#stripe_cancel=true`;

      const metadata = {
              event_id:        (eventId      || '').slice(0, 500),
              event_name:      (eventName    || '').slice(0, 500),
              buyer_name:      (buyerName    || '').slice(0, 500),
              buyer_phone:     (buyerPhone   || '').slice(0, 500),
              buyer_zip:       (buyerZip     || '').slice(0, 500),
              buyer_age_range: (buyerAgeRange|| '').slice(0, 500),
              buyer_referral:  (buyerReferral|| '').slice(0, 500),
              opt_in_email:    optInEmail ? 'true' : 'false',
              opt_in_sms:      optInSms   ? 'true' : 'false',
              payment:         (payment    || 'Card').slice(0, 500),
              wallet:          (wallet     || '').slice(0, 500),
              service_fee:     String(serviceFee || 0),
              hold_ids:        (holdIds    || []).join(',').slice(0, 500),
              seats_json:      JSON.stringify(seats).slice(0, 500),
      };

      const sessionParams = {
              payment_method_types: ['card'],
              line_items: lineItems,
              mode: 'payment',
              success_url: successUrl,
              cancel_url: cancelUrl,
              customer_email: buyerEmail || undefined,
              metadata,
      };

      if (venueStripeAccountId) {
              // 90/10 split on net after Stripe processing
            // Gross = sum of (face value + service fee) per seat
            // Net = gross − (2.9% × gross + $0.30)
            // Platform application fee = 10% of net (venue receives 90%)
            const gross = seats.reduce((s, seat) => s + seat.price + (serviceFee || 0), 0);
              const stripeProcessing = gross * 0.029 + 0.30;
              const net = gross - stripeProcessing;
              const applicationFee = Math.max(0, Math.round(net * 0.10 * 100)); // cents, floor at 0
            sessionParams.payment_intent_data = {
                      application_fee_amount: applicationFee,
                      transfer_data: { destination: venueStripeAccountId },
            };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
          return res.status(200).json({ url: session.url });

    } catch (err) {
          console.error('Stripe session error:', err.message);
          return res.status(500).json({ error: err.message });
    }
};
