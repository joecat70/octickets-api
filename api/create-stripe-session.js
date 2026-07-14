// api/create-stripe-session.js
// Handles two Stripe Checkout operations dispatched by request body shape:
//
//   POST { seats, eventName, ... }  → create a Checkout session
//   POST { sessionId }              → verify a session's payment status
//
// Backward compatible: callers that already send `seats` or `sessionId` require no
// changes. An optional explicit `action` field is also supported ('create'/'verify').
//
// ─────────────────────────────────────────────────────────────────────────────
// v4 (Jul 14 2026) — RESALE (TICKET EXCHANGE) PRICE VALIDATION.
// The v2 price check validates every seat price against the event's PUBLISHED tier
// prices. That is right for a primary sale and wrong for a resale, where the price is
// the seller's ask and by definition will not match a published tier — so the exchange
// path 400'd on every venue ("does not match this event's published pricing"), and on
// Live Demo it failed even earlier because the exchange payload never sent eventId.
// v4 adds an isExchange branch that validates the ask against the LISTING ROW instead:
// tickets.listed_price, on a ticket that is genuinely status='listed' and genuinely
// belongs to this event. Same fail-closed principle, correct source of truth. Callers
// must send { isExchange: true, eventId, ticketId } and exactly one seat.
// NOTE the flagged OPEN QUESTION on resale economics near application_fee_amount below.
//
// v3 (Jul 13 2026) — MODEL C SPLIT. Two changes, both about money:
//
// 1. LINE ITEMS. Was: unit_amount = seat.price + serviceFee. Under Model C the seat
//    price IS the all-in amount the fan pays — face value and service fee are DERIVED
//    from it, never added on top. `serviceFee` is now IGNORED for charging (a stale
//    client sending serviceFee > 0 would otherwise overcharge the fan on top of an
//    all-in price). It is logged if non-zero so a stale venue file surfaces loudly.
//
// 2. APPLICATION FEE. Was: 10% of net after Stripe processing (the old 90/10 model).
//    Now: the platform fee is exactly OCTL's take as computed by calcOCTLFees() —
//    summed per seat, in cents. Everything else transfers to the venue's connected
//    account, so the venue automatically receives:
//
//        allIn − stripeFee − octlTake  ===  faceValue + venueNet
//
//    which is precisely the Model C settlement. Note this means the venue's rebate
//    (venueNet) is delivered BY STRIPE, per transaction, with no separate payout to
//    reconcile — it is simply money Stripe never took out of the transfer.
//
//    Below ~$4.93 (card) the service fee cannot cover Stripe's own fee. octlTake
//    floors at $0, application_fee_amount floors at 0, and the venue's transfer is
//    allIn − stripeFee, i.e. slightly less than face value. That is deliberate and
//    accepted (Joe, Jul 13 2026: "If there is an event at prices that low, that is
//    on the venue, not OCTL").
//
//    calcOCTLFees is ALWAYS called with 'card' here: this endpoint only ever creates
//    Stripe Checkout sessions, and crypto purchases never touch Stripe. Passing the
//    buyer's `payment` string through would let a spoofed 'Crypto Wallet' value zero
//    out the Stripe deduction and under-fee the platform.
//
// SINGLE SOURCE OF TRUTH: this file REQUIRES ../lib/calcOCTLFees.js. Do not inline a
// copy of the fee math here. If the split ever looks wrong, run `node lib/calcOCTLFees.test.js`.
//
// v2 (Jul 2026): SERVER-SIDE PRICE VALIDATION on the create path — every seat's price
// is checked against the event's real published prices from Supabase before a session
// is created. Fails closed (400) if eventId is missing, the event isn't found, or the
// event has no pricing configured. Retained below, unchanged. The v2 note about
// `serviceFee` being unvalidated is now MOOT: serviceFee is no longer used to charge.
//
// REQUIRES: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY).
// ─────────────────────────────────────────────────────────────────────────────

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { calcOCTLFees } = require('../lib/calcOCTLFees');

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
        serviceFee,          // Model C: accepted for back-compat, NOT used to charge. See v3 note.
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
        isExchange,          // v4: resale purchase from the Ticket Exchange
        ticketId,            // v4: REQUIRED when isExchange — the listing being bought
    } = body;

    if (!seats || !seats.length) return res.status(400).json({ error: 'No seats provided' });

    // ── Server-side price validation (v2, retained) ─────────────────────────
    if (!eventId) return res.status(400).json({ error: 'Missing eventId — cannot verify pricing' });
    if (!supabase) {
        console.error('create-stripe-session: Supabase not configured — refusing to trust client-supplied prices');
        return res.status(500).json({ error: 'Server price validation unavailable' });
    }

    // ── v4: RESALE (Ticket Exchange) price validation ────────────────────────
    // A resale price is the SELLER'S ASK, not one of the event's published tier
    // prices — so the primary-sale check below would reject every resale outright.
    // That is exactly what was happening: the exchange path 400'd on every venue
    // (Live Demo additionally never sent eventId at all, so it failed even earlier).
    //
    // The fix is a different source of truth, NOT a weaker one. The ask is validated
    // against the listing row itself: tickets.listed_price, on a ticket that is
    // actually status='listed' and actually belongs to this event. Trusting the
    // client's price here would let anyone buy a $200 listing for $1.
    //
    // The ask was already capped at listing time by zeroscalp.js validate_price
    // (resale_rule='original_plus_fees' → max = original + Stripe fee). This check
    // is downstream of that: whatever ZeroScalp allowed onto the listing is what the
    // buyer pays, and nothing else.
    if (isExchange) {
        if (!ticketId) return res.status(400).json({ error: 'Missing ticketId — cannot verify resale price' });
        if (seats.length !== 1) return res.status(400).json({ error: 'A resale purchase must be exactly one ticket' });

        const { data: listing, error: lErr } = await supabase
            .from('tickets')
            .select('id, event_id, status, listed_price')
            .eq('id', ticketId)
            .maybeSingle();

        if (lErr || !listing) {
            console.error('create-stripe-session: resale listing lookup failed for', ticketId, lErr?.message);
            return res.status(400).json({ error: 'Listing not found — cannot verify resale price' });
        }
        if (listing.status !== 'listed') {
            console.error('create-stripe-session: REJECTED resale — ticket', ticketId, 'has status', listing.status, '(not listed)');
            return res.status(400).json({ error: 'This ticket is no longer listed for sale.' });
        }
        if (listing.event_id !== eventId) {
            console.error('create-stripe-session: REJECTED resale — ticket', ticketId, 'belongs to event', listing.event_id, 'not', eventId);
            return res.status(400).json({ error: 'Listing does not belong to this event.' });
        }

        const askedCents  = Math.round((seats[0].price || 0) * 100);
        const listedCents = Math.round((Number(listing.listed_price) || 0) * 100);
        if (listedCents <= 0) {
            console.error('create-stripe-session: REJECTED resale — ticket', ticketId, 'has no listed_price');
            return res.status(400).json({ error: 'Listing has no price — cannot process payment.' });
        }
        if (askedCents !== listedCents) {
            console.error(
                'create-stripe-session: REJECTED resale price', seats[0].price,
                'for ticket', ticketId, '— listed_price is', listing.listed_price
            );
            return res.status(400).json({ error: "Resale price does not match this ticket's listing." });
        }
        console.log('create-stripe-session: ✓ resale validated — ticket', ticketId, 'at $' + listing.listed_price);
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

    // Primary sales only — a resale was already validated against its listing above.
    for (const seat of (isExchange ? [] : seats)) {
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

    // ── MODEL C: derive the split from the all-in seat prices ───────────────
    // Always 'card' — this endpoint only creates Stripe sessions; crypto never
    // reaches Stripe, and trusting the client's `payment` string would let a
    // spoofed 'Crypto Wallet' zero out the Stripe deduction.
    if (serviceFee) {
        console.warn(
            'create-stripe-session: client sent serviceFee =', serviceFee,
            '— IGNORED under Model C (the seat price is already all-in). This venue file is',
            'likely stale and should be updated; the fan was NOT overcharged.'
        );
    }

    const splits = seats.map(seat => calcOCTLFees(Number(seat.price) || 0, 'card'));

    const allInCents  = splits.reduce((s, f) => s + Math.round(f.allInPrice      * 100), 0);
    const octlCents   = splits.reduce((s, f) => s + Math.round(f.octlTake        * 100), 0);
    const faceCents   = splits.reduce((s, f) => s + Math.round(f.faceValue       * 100), 0);
    const feeCents    = splits.reduce((s, f) => s + Math.round(f.serviceFeeGross * 100), 0);
    const stripeCents = splits.reduce((s, f) => s + Math.round(f.stripeFee       * 100), 0);

    try {
        // The fan is charged the ALL-IN price. Nothing is added on top.
        const lineItems = seats.map((seat, i) => ({
            price_data: {
                currency: 'usd',
                product_data: { name: `${eventName} — ${seat.label || seat.key} (${seat.tier || 'General'})` },
                unit_amount: Math.round(splits[i].allInPrice * 100),
            },
            quantity: 1,
        }));

        const successUrl = `${venueUrl}/#stripe_success=true&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl  = `${venueUrl}/#stripe_cancel=true`;

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
            hold_ids:        (holdIds    || []).join(',').slice(0, 500),
            is_exchange:     isExchange ? 'true' : 'false',
            resale_ticket_id:(isExchange ? String(ticketId || '') : '').slice(0, 500),
            seats_json:      JSON.stringify(seats).slice(0, 500),
            // Model C reconciliation record — server-derived, never client-supplied.
            pricing_model:   'C',
            all_in_total:    (allInCents  / 100).toFixed(2),
            face_value:      (faceCents   / 100).toFixed(2),
            service_fee:     (feeCents    / 100).toFixed(2),  // DERIVED, replaces the old client value
            octl_take:       (octlCents   / 100).toFixed(2),
            stripe_est:      (stripeCents / 100).toFixed(2),
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
            // MODEL C SPLIT. The platform fee is exactly OCTL's take. Stripe deducts its
            // own processing fee from the charge and transfers the remainder to the venue:
            //
            //     venue receives = allIn − stripeFee − octlTake = faceValue + venueNet
            //
            // The venue's rebate (venueNet) therefore arrives automatically, per
            // transaction — Stripe simply never takes it out of the transfer. There is
            // no separate rebate payout to reconcile.
            //
            // Floored at 0: on sub-$4.93 tickets octlTake is already $0 and the venue
            // absorbs the Stripe shortfall (accepted — see the v3 header note).
            // OPEN QUESTION — RESALE ECONOMICS (flagged Jul 14 2026, NOT decided):
            // On a RESALE this takes OCTL's normal per-ticket cut out of the seller's
            // ask, ON TOP OF the venue's 10% royalty (which is collected separately —
            // payouts pay the seller listed_price × 0.9). Nobody has decided whether
            // OCTL should take a second cut on resales, or whether its share should
            // come OUT of the venue's 10%, or be zero. This has no effect today: every
            // demo venue has venueStripeAccountId = null, so this whole block is
            // skipped. It MUST be settled before the first venue onboards with a real
            // Stripe Connect account. Behaviour is deliberately left AS-IS rather than
            // guessed at.
            const applicationFee = Math.max(0, octlCents);
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
