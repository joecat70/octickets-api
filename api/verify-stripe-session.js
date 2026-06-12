// api/verify-stripe-session.js
// Verifies a Stripe checkout session after buyer returns from Stripe

const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  // Handle CORS preflight
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: 'Stripe key not configured' });
    }

    const stripe = new Stripe(stripeKey);
    const { session_id } = req.body || {};

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    // Retrieve the session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    return res.status(200).json({
      success: true,
      id: session.id,
      payment_status: session.payment_status,
      customer_email: session.customer_email || session.customer_details?.email || null,
      metadata: session.metadata || {},
      amount_total: session.amount_total,
      currency: session.currency,
    });

  } catch (err) {
    console.error('verify-stripe-session error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
