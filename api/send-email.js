const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Support both single ticket (ticketId/seat) and batch (ticketIds/seats)
  const {
    email, ticketId, ticketIds, eventName, seat, seats, seatCount, venueUrl
  } = req.body;

  if (!email || (!ticketId && (!ticketIds || !ticketIds.length))) {
    return res.status(400).json({ error: 'Missing email or ticketId' });
  }

  // Normalise to arrays
  const allTicketIds = ticketIds && ticketIds.length ? ticketIds : [ticketId];
  const allSeats     = seats    && seats.length    ? seats    : (seat ? [seat] : allTicketIds.map(() => 'See ticket'));
  const totalCount   = seatCount || allTicketIds.length;

  // Store ONE claim token pointing to the primary ticket (first in batch)
  const primaryId = allTicketIds[0];
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );

  const { error: dbError } = await db.from('claim_tokens').insert({
    token,
    ticket_id:  primaryId,
    phone:      email,          // column is named 'phone' but stores email
    expires_at: expiresAt.toISOString(),
    claimed:    false,
  });

  if (dbError) {
    console.error('DB error:', dbError);
    return res.status(500).json({ error: 'Failed to save token' });
  }

  const baseUrl  = (venueUrl || 'https://theetestsite.eth.limo').replace(/\/+$/, '');
  const claimUrl = `${baseUrl}/#claim=${token}`;

  // Build seat list HTML — one row per seat
  const seatRows = allSeats.map((s, i) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a3a;color:#d4af37;font-family:monospace;font-size:13px">
        ${String(i + 1).padStart(2, '0')}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a3a;color:#ffffff;font-size:13px">
        ${s}
      </td>
    </tr>`).join('');

  const ticketWord = totalCount === 1 ? 'ticket' : 'tickets';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a1a;color:#ffffff">
      <div style="text-align:center;margin-bottom:32px;padding:32px 24px 0">
        <h1 style="color:#d4af37;font-size:28px;margin:0">OC Tickets Live</h1>
        <p style="color:#888;margin:8px 0 0">Your ${ticketWord} ${totalCount === 1 ? 'is' : 'are'} confirmed</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #d4af37;border-radius:8px;padding:24px;margin:0 24px">
        <h2 style="color:#d4af37;font-size:20px;margin:0 0 8px">${eventName || 'Your Event'}</h2>
        <p style="color:#aaa;margin:0 0 16px;font-size:13px">${totalCount} ${ticketWord} purchased</p>

        <table style="width:100%;border-collapse:collapse;background:#0d0d1f;border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:#12122a">
              <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;font-weight:normal;text-transform:uppercase">#</th>
              <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;font-weight:normal;text-transform:uppercase">Seat</th>
            </tr>
          </thead>
          <tbody>${seatRows}</tbody>
        </table>
      </div>

      <div style="text-align:center;margin:24px">
        <a href="${claimUrl}"
           style="display:inline-block;background:#d4af37;color:#000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px">
          View My ${totalCount === 1 ? 'Ticket' : `${totalCount} Tickets`} →
        </a>
        <p style="color:#555;font-size:11px;margin:12px 0 0">Link expires in 7 days</p>
      </div>

      <div style="text-align:center;padding:16px 24px 32px;color:#444;font-size:11px">
        OC Tickets Live · tickets@octicketslive.com
      </div>
    </div>`;

  const { error: emailError } = await resend.emails.send({
    from:    'OC Tickets Live <tickets@octicketslive.com>',
    to:      email,
    subject: `Your ${totalCount === 1 ? '' : totalCount + ' '}${ticketWord} for ${eventName || 'the event'} ${totalCount === 1 ? 'is' : 'are'} ready`,
    html,
  });

  if (emailError) {
    console.error('Resend error:', emailError);
    return res.status(500).json({ error: emailError.message });
  }

  return res.status(200).json({ success: true });
};
