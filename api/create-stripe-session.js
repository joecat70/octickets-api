// api/create-stripe-session.js
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

  const {
    seats,
    eventName,
    venueUrl,
    buyerEmail,
    serviceFee,
    venueStripeAccountId,
    // New fields for webhook
    holdIds,       // array of hold ticket IDs already inserted to Supabase
    eventId,       // event UUID
    buyerName,
    buyerPhone,
    buyerZip,
    buyerAgeRange,
    buyerReferral,
    optInEmail,
    optInSms,
    payment,
    wallet,
  } = req.body;

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
    const cancelUrl  = `${venueUrl}/#stripe_cancel=true`;

    // Build metadata — Stripe allows up to 50 keys, values max 500 chars each.
    // All buyer context goes here so the webhook can write tickets without any
    // client-side involvement.
    const metadata = {
      event_id:        (eventId       || '').slice(0, 500),
      event_name:      (eventName     || '').slice(0, 500),
      buyer_name:      (buyerName     || '').slice(0, 500),
      buyer_phone:     (buyerPhone    || '').slice(0, 500),
      buyer_zip:       (buyerZip      || '').slice(0, 500),
      buyer_age_range: (buyerAgeRange || '').slice(0, 500),
      buyer_referral:  (buyerReferral || '').slice(0, 500),
      opt_in_email:    optInEmail ? 'true' : 'false',
      opt_in_sms:      optInSms   ? 'true' : 'false',
      payment:         (payment       || 'Card').slice(0, 500),
      wallet:          (wallet        || '').slice(0, 500),
      service_fee:     String(serviceFee || 0),
      // hold_ids is a comma-separated list of ticket IDs already in Supabase.
      // The webhook uses these to UPDATE holds → valid instead of inserting new rows.
      hold_ids:        (holdIds || []).join(',').slice(0, 500),
      // seats_json gives the webhook all seat/tier/price info it needs.
      seats_json:      JSON.stringify(seats).slice(0, 500),
    };

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      customer_email: buyerEmail || undefined,
      metadata,
    };

    if (venueStripeAccountId) {
      sessionParams.payment_intent_data = {
        application_fee_amount: Math.round(seats.reduce((s, seat) => s + seat.price * 0.10, 0) * 100),
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
