const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token } = req.method === 'GET' ? req.query : req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const { data: claimData, error: claimError } = await supabase
      .from('claim_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (claimError || !claimData) return res.status(404).json({ error: 'Invalid or expired token' });
    if (new Date(claimData.expires_at) < new Date()) return res.status(410).json({ error: 'Token has expired' });

    const { data: ticketData, error: ticketError } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', claimData.ticket_id)
      .single();

    if (ticketError || !ticketData) return res.status(404).json({ error: 'Ticket not found' });

    return res.status(200).json({ success: true, ticket: ticketData, phone: claimData.phone });
  } catch (err) {
    console.error('claim error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
