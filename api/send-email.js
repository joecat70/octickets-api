// api/send-email.js
// Ticket confirmation email — single template used by both client and webhook paths.
// Creates a claim token in Supabase, then sends via Resend.

const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const {
    email,
    name,
    ticketId,
    ticketIds,
    eventName,
    seat,
    seats,
    seatCount,
    venueUrl,
  } = req.body;

  if (!email || (!ticketId && (!ticketIds || !ticketIds.length))) {
    return res.status(400).json({ error: 'Missing email or ticketId' });
  }

  const allTicketIds = ticketIds?.length ? ticketIds : [ticketId];
  const allSeats     = seats?.length     ? seats     : (seat ? [seat] : allTicketIds.map(() => 'Reserved Seat'));
  const totalCount   = seatCount || allTicketIds.length;
  const buyerName    = name || 'Ticket Holder';
  const primaryId    = allTicketIds[0];
  const baseUrl      = (venueUrl || 'https://octicketslive.eth.limo').replace(/\/+$/, '');

  // ── 1. Create claim token ──────────────────────────────────────────────────
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY   // was incorrectly SUPABASE_SECRET_KEY
  );

  const { error: dbError } = await db.from('claim_tokens').insert({
    token,
    ticket_id:  primaryId,
    phone:      email,
    expires_at: expiresAt.toISOString(),
    claimed:    false,
  });

  if (dbError) {
    console.error('send-email: DB error saving claim token:', dbError);
    return res.status(500).json({ error: 'Failed to save token' });
  }

  // ── 2. Build claim URL ─────────────────────────────────────────────────────
  const claimUrl = `${baseUrl}/#claim=${token}`;

  // ── 3. Build and send email ────────────────────────────────────────────────
  const resend = new Resend(process.env.RESEND_API_KEY);

  const seatLabel = allSeats.length === 1
    ? allSeats[0]
    : `${allSeats.length} seats — ${allSeats.join(', ')}`;

  const seatRows = allSeats.map((s, i) => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #1e1c14;font-family:-apple-system,sans-serif;font-size:13px;color:#d4c88a">
        ${allTicketIds[i] || ''}
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid #1e1c14;font-family:-apple-system,sans-serif;font-size:13px;color:#f5f0e6;font-weight:600">
        ${s}
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Tickets — OC Tickets Live</title>
</head>
<body style="margin:0;padding:0;background:#0a0900;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0900;padding:32px 16px">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

    <!-- Header -->
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-radius:8px 8px 0 0;padding:24px 32px;text-align:center;border-bottom:1px solid #c9a84c40">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center">
              <div style="display:inline-block;background:#c9a84c;width:36px;height:36px;border-radius:50%;line-height:36px;text-align:center;font-size:18px;margin-bottom:10px">🎟</div>
              <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f5f0e6;letter-spacing:4px;text-transform:uppercase">OC Tickets Live</div>
              <div style="font-size:11px;color:#8a7f5c;letter-spacing:1px;margin-top:4px;font-family:monospace">octicketslive.eth · Reserved Seating</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Gold bar -->
    <tr>
      <td style="height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent)"></td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-top:none;padding:32px">

        <!-- Greeting -->
        <p style="margin:0 0 24px;font-size:15px;color:#d4c88a;line-height:1.6">
          Hi ${buyerName},<br><br>
          Your ${totalCount === 1 ? 'ticket is' : `${totalCount} tickets are`} confirmed.
          Use the link below to access your ticket${totalCount > 1 ? 's' : ''} at any time.
        </p>

        <!-- Event block -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr>
            <td style="padding:16px;border-bottom:1px solid #1e1c14">
              <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Event</div>
              <div style="font-size:18px;font-weight:700;color:#f5f0e6;font-family:Georgia,serif">${eventName || 'Your Event'}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px">
              <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px">
                ${totalCount === 1 ? 'Your Seat' : `Your Seats (${totalCount})`}
              </div>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <th style="padding:8px 16px;background:#0a0900;font-size:10px;color:#8a7f5c;text-transform:uppercase;letter-spacing:1px;font-family:monospace;font-weight:400;text-align:left">Ticket ID</th>
                  <th style="padding:8px 16px;background:#0a0900;font-size:10px;color:#8a7f5c;text-transform:uppercase;letter-spacing:1px;font-family:monospace;font-weight:400;text-align:left">Seat</th>
                </tr>
                ${seatRows}
              </table>
            </td>
          </tr>
        </table>

        <!-- CTA -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr>
            <td align="center">
              <a href="${claimUrl}"
                style="display:inline-block;background:#c9a84c;color:#000;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:1px;padding:14px 36px;border-radius:4px;text-transform:uppercase">
                Access My Ticket${totalCount > 1 ? 's' : ''} →
              </a>
            </td>
          </tr>
        </table>

        <!-- Link fallback -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px;padding:16px">
          <tr>
            <td style="padding:16px">
              <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px">Secure Ticket Link</div>
              <div style="font-size:11px;color:#c9a84c;word-break:break-all;font-family:monospace;line-height:1.6">${claimUrl}</div>
              <div style="font-size:11px;color:#4a4530;margin-top:8px">Valid for 7 days · Tap or copy into your browser</div>
            </td>
          </tr>
        </table>

        <!-- Security note -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0a;border:1px solid #1e1c14;border-radius:6px;margin-bottom:8px">
          <tr>
            <td style="padding:14px 16px">
              <div style="font-size:11px;color:#6a6040;line-height:1.7;font-family:monospace">
                🔒 Your ticket includes a rotating QR code that refreshes every 15 seconds.<br>
                Screenshots are not valid at the door — always open your live ticket link.<br>
                Do not share this email or your claim link with anyone.
              </div>
            </td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background:#080700;border:1px solid #2a2310;border-top:none;border-radius:0 0 8px 8px;padding:20px 32px;text-align:center">
        <div style="font-size:10px;color:#4a4530;font-family:monospace;line-height:1.8">
          OC Tickets Live · octicketslive.com<br>
          Questions? Reply to this email.<br>
          This link was sent to ${email}
        </div>
      </td>
    </tr>

  </table>
  </td></tr>
</table>

</body>
</html>`;

  try {
    const { error: emailError } = await resend.emails.send({
      from:    'OC Tickets Live <tickets@octicketslive.com>',
      to:      email,
      subject: `Your Ticket${totalCount > 1 ? `s (${totalCount})` : ''} — ${eventName || 'OC Tickets Live'}`,
      html,
    });

    if (emailError) {
      console.error('send-email: Resend error:', emailError);
      return res.status(500).json({ error: 'Email delivery failed', detail: emailError });
    }

    console.log(`send-email: ✓ sent to ${email} — ${totalCount} ticket(s) — event: ${eventName}`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-email: unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected error', detail: err.message });
  }
};
