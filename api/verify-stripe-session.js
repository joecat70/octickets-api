// api/verify-stripe-session.js
// Verifies a Stripe checkout session after buyer returns from Stripe.
// Accepts sessionId (camelCase) OR session_id (snake_case) for compatibility.
// Returns paid/customerEmail to match create-stripe-session.js verify route
// and the field names used across all OCTL venue HTML files.
const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: 'Stripe key not configured' });
    }
    const stripe = new Stripe(stripeKey);

    // Accept sessionId (camelCase) OR session_id (snake_case)
    const sessionId = req.body?.sessionId || req.body?.session_id;
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === 'paid';

    return res.status(200).json({
      success:       true,
      paid,                                                          // matches vData.paid check in HTML
      customerEmail: session.customer_email                          // matches vData.customerEmail in HTML
                     || session.customer_details?.email
                     || null,
      // Legacy fields preserved for any other consumers
      id:             session.id,
      payment_status: session.payment_status,
      customer_email: session.customer_email
                      || session.customer_details?.email
                      || null,
      metadata:       session.metadata    || {},
      amount_total:   session.amount_total,
      currency:       session.currency,
    });
  } catch (err) {
    console.error('verify-stripe-session error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: true } };
