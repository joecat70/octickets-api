const { createClient } = require('@supabase/supabase-js');

// Uses service key to bypass RLS — called server-side only after Stripe payment verified
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticketId, sessionId, buyerEmail, buyerName, payment } = req.body;
  if (!ticketId || !sessionId) return res.status(400).json({ error: 'Missing ticketId or sessionId' });

  try {
    // Verify the Stripe session actually paid before transferring
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['customer_details'] });
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not confirmed' });
    }

    const txHash = 'stripe:' + sessionId;

    // Update ticket status and clear listing — service key bypasses RLS
    const { error } = await supabase
      .from('tickets')
      .update({
        status: 'valid',
        listed_price: null,
        buyer_id: null,
        tx_hash: txHash,
        payment: payment || 'Card',
      })
      .eq('id', ticketId);

    if (error) {
      console.error('Transfer error:', error);
      return res.status(500).json({ error: error.message });
    }

    // Fetch the updated ticket to return to client
    const { data: ticket } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', ticketId)
      .single();

    return res.status(200).json({ success: true, ticket, txHash });

  } catch (err) {
    console.error('transfer-ticket error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
