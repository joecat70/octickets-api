const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token } = req.method === 'GET' ? req.query : req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    // Look up the claim token
    const { data: claimData, error: claimError } = await supabase
      .from('claim_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (claimError || !claimData) return res.status(404).json({ error: 'Invalid or expired token' });
    if (new Date(claimData.expires_at) < new Date()) return res.status(410).json({ error: 'Token has expired' });

    // Fetch the primary ticket
    const { data: ticketData, error: ticketError } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', claimData.ticket_id)
      .single();

    if (ticketError || !ticketData) return res.status(404).json({ error: 'Ticket not found' });

    // Fetch ALL tickets from the same purchase (same tx_hash) using service key
    let allTickets = [ticketData];
    if (ticketData.tx_hash) {
      const { data: related } = await supabase
        .from('tickets')
        .select('*')
        .eq('tx_hash', ticketData.tx_hash)
        .eq('status', 'valid');
      if (related && related.length > 0) {
        // Deduplicate — primary ticket may already be in related
        const seen = new Set();
        allTickets = related.filter(t => {
          if (seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        });
      }
    }

    return res.status(200).json({
      success: true,
      ticket:  ticketData,   // primary ticket (backwards compat)
      tickets: allTickets,   // ALL tickets in this purchase
      phone:   claimData.phone,
    });

  } catch (err) {
    console.error('claim error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
