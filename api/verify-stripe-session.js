const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { sessionId } = req.body;

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
      };
