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

const Stripe = require('stripe');

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
