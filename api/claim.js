// api/claim.js
// Magic link claim handler — validates token and returns tickets.
// No device binding, no OTP gate, no Twilio calls.
//
// GET ?token=xxx — validate token and return tickets

const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: true } };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
}

async function loadTicketsForClaim(db, claimRow) {
  const primaryTicketId = claimRow.ticket_id;

  const { data: primary } = await db
    .from('tickets')
    .select('tx_hash, id, event_id, event_name, seat, seat_key, tier_name, tier_id, price, payment, status, purchased_at, wallet, totp_seed, buyer_email, buyer_name, buyer_phone')
    .eq('id', primaryTicketId)
    .maybeSingle();

  if (!primary) return null;

  let tickets = [primary];

  if (primary.tx_hash) {
    const { data: siblings } = await db
      .from('tickets')
      .select('id, event_id, event_name, seat, seat_key, tier_name, tier_id, price, payment, status, purchased_at, wallet, totp_seed, tx_hash, buyer_email, buyer_name, buyer_phone')
      .eq('tx_hash', primary.tx_hash)
      .neq('id', primaryTicketId);

    if (siblings?.length) tickets = [primary, ...siblings];
  }

  return tickets;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only GET is supported
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = getSupabase();
    const { token } = req.query;

    if (!token) return res.status(400).json({ error: 'Missing token' });

    // Look up claim token
    const { data: claimRow, error } = await db
      .from('claim_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error || !claimRow) return res.status(404).json({ error: 'Invalid claim token' });
    if (new Date(claimRow.expires_at) < new Date()) return res.status(410).json({ error: 'Claim link has expired' });

    // Load tickets
    const tickets = await loadTicketsForClaim(db, claimRow);
    if (!tickets) return res.status(404).json({ error: 'Tickets not found' });

    // Mark as claimed (idempotent — safe to call on every access)
    await db.from('claim_tokens').update({
      claimed:          true,
      claimed_at:       claimRow.claimed_at || new Date().toISOString(),
      reaccess_count:   (claimRow.reaccess_count || 0) + 1,
      last_reaccess_at: new Date().toISOString(),
    }).eq('token', token);

    console.log(`claim.js: ✓ token ${token.slice(0, 8)}… — ${tickets.length} ticket(s)`);

    return res.status(200).json({
      success: true,
      tickets,
      ticket:  tickets[0],
      phone:   claimRow.phone,
    });

  } catch (err) {
    console.error('claim.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
