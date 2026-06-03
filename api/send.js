// ============================================================
// /api/send.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// Consolidated from: send-email.js, send-sms.js, send-verify.js
//
// Routes by req.body.type:
//   'email'  → ticket confirmation email + claim token (was send-email.js)
//   'sms'    → ticket SMS + claim token      (was send-sms.js)
//   'verify' → listing/gift verification code email (was send-verify.js)
//
// All existing request bodies and response shapes are preserved exactly.
// HTML calls updated to /api/send with type field added to body.
// ============================================================

const { Resend }       = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 }   = require('uuid');
const twilio           = require('twilio');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { type } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required: email | sms | verify' });

  // ============================================================
  // TYPE: email
  // Ticket confirmation email + claim token in Supabase.
  // Preserves full send-email.js behavior exactly.
  // ============================================================
  if (type === 'email') {
    const {
      email, name, ticketId, ticketIds, eventName,
      seat, seats, seatCount, venueUrl,
    } = req.body;

    if (!email || (!ticketId && (!ticketIds || !ticketIds.length))) {
      return res.status(400).json({ error: 'Missing email or ticketId' });
    }

    const allTicketIds = ticketIds?.length ? ticketIds : [ticketId];
    const allSeats     = seats?.length ? seats : (seat ? [seat] : allTicketIds.map(() => 'Reserved Seat'));
    const totalCount   = seatCount || allTicketIds.length;
    const buyerName    = name || 'Ticket Holder';
    const primaryId    = allTicketIds[0];
    const baseUrl      = (venueUrl || 'https://octicketslive.eth.limo').replace(/\/+$/, '');

    // Create claim token
    const token     = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Authoritative event name lookup ───────────────────────────────
    // db must be initialized before this runs. If the client passed a raw
    // event ID (evt_...) or nothing, look up from Supabase directly.
    let resolvedEventName = eventName;
    if (!resolvedEventName || resolvedEventName.startsWith('evt_')) {
      try {
        const { data: ticketRow } = await db.from('tickets')
          .select('event_name')
          .eq('id', primaryId)
          .maybeSingle();
        if (ticketRow?.event_name) resolvedEventName = ticketRow.event_name;
      } catch (lookupErr) {
        console.warn('send/email: event name lookup failed:', lookupErr.message);
      }
    }
    const finalEventName = resolvedEventName || 'Your Event';

    // phone is optional — claim_tokens.phone is NOT NULL so default to empty string
    const claimPhone = req.body.phone || '';

    const { error: dbError } = await db.from('claim_tokens').insert({
      token,
      ticket_id:  primaryId,
      phone:      claimPhone,
      expires_at: expiresAt.toISOString(),
      claimed:    false,
    });

    if (dbError) {
      console.error('send/email: DB error saving claim token:', dbError);
      return res.status(500).json({ error: 'Failed to save token' });
    }

    const claimUrl = `${baseUrl}/#claim=${token}`;
    const resend   = new Resend(process.env.RESEND_API_KEY);

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
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-radius:8px 8px 0 0;padding:24px 32px;text-align:center;border-bottom:1px solid #c9a84c40">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
          <div style="display:inline-block;background:#c9a84c;width:36px;height:36px;border-radius:50%;line-height:36px;text-align:center;font-size:18px;margin-bottom:10px">🎟</div>
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f5f0e6;letter-spacing:4px;text-transform:uppercase">OC Tickets Live</div>
          <div style="font-size:11px;color:#8a7f5c;letter-spacing:1px;margin-top:4px;font-family:monospace">octicketslive.eth · Reserved Seating</div>
        </td></tr></table>
      </td>
    </tr>
    <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent)"></td></tr>
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-top:none;padding:32px">
        <p style="margin:0 0 24px;font-size:15px;color:#d4c88a;line-height:1.6">
          Hi ${buyerName},<br><br>
          Your ${totalCount === 1 ? 'ticket is' : `${totalCount} tickets are`} confirmed.
          Use the link below to access your ticket${totalCount > 1 ? 's' : ''} at any time.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:16px;border-bottom:1px solid #1e1c14">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Event</div>
            <div style="font-size:18px;font-weight:700;color:#f5f0e6;font-family:Georgia,serif">${finalEventName}</div>
          </td></tr>
          <tr><td style="padding:16px">
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
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr><td align="center">
            <a href="${claimUrl}" style="display:inline-block;background:#c9a84c;color:#000;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:1px;padding:14px 36px;border-radius:4px;text-transform:uppercase">
              Access My Ticket${totalCount > 1 ? 's' : ''} →
            </a>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px;padding:16px">
          <tr><td style="padding:16px">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px">Secure Ticket Link</div>
            <div style="font-size:11px;color:#c9a84c;word-break:break-all;font-family:monospace;line-height:1.6">${claimUrl}</div>
            <div style="font-size:11px;color:#4a4530;margin-top:8px">Valid for 7 days · Tap or copy into your browser</div>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0a;border:1px solid #1e1c14;border-radius:6px;margin-bottom:8px">
          <tr><td style="padding:14px 16px">
            <div style="font-size:11px;color:#6a6040;line-height:1.7;font-family:monospace">
              🔒 Your ticket includes a rotating QR code that refreshes every 15 seconds.<br>
              Screenshots are not valid at the door — always open your live ticket link.<br>
              Do not share this email or your claim link with anyone.
            </div>
          </td></tr>
        </table>
      </td>
    </tr>
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
</body></html>`;

    try {
      const { error: emailError } = await resend.emails.send({
        from:    'OC Tickets Live <tickets@octicketslive.com>',
        to:      email,
        subject: `Your Ticket${totalCount > 1 ? `s (${totalCount})` : ''} — ${finalEventName}`,
        html,
      });
      if (emailError) {
        console.error('send/email: Resend error:', emailError);
        return res.status(500).json({ error: 'Email delivery failed', detail: emailError });
      }
      console.log(`send/email: ✓ sent to ${email} — ${totalCount} ticket(s)`);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('send/email: unexpected error:', err);
      return res.status(500).json({ error: 'Unexpected error', detail: err.message });
    }
  }

  // ============================================================
  // TYPE: sms
  // Ticket SMS with claim token. Preserves send-sms.js exactly.
  // Note: uses SUPABASE_SECRET_KEY (matches original send-sms.js)
  // ============================================================
  if (type === 'sms') {
    const { phone, ticketId, eventName, seat, venueUrl } = req.body;
    if (!phone || !ticketId) return res.status(400).json({ error: 'Missing phone or ticketId' });

    try {
      const token     = uuidv4();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const db = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY  // preserved from original send-sms.js
      );

      const { error: dbError } = await db.from('claim_tokens').insert({
        token, ticket_id: ticketId, phone,
        expires_at: expiresAt.toISOString(), claimed: false,
      });
      if (dbError) return res.status(500).json({ error: 'Failed to save token' });

      const claimUrl = `${(venueUrl || 'https://theetestsite.eth.limo').replace(/\/+$/, '')}/#claim=${token}`;
      const client   = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   phone,
        body: `Your ticket for ${eventName} (${seat}) is ready!\n\nTap to view: ${claimUrl}\n\nOC Tickets Live`,
      });

      console.log(`send/sms: ✓ sent to ${phone} for ticket ${ticketId}`);
      return res.status(200).json({ success: true, token });
    } catch (err) {
      console.error('send/sms error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ============================================================
  // TYPE: verify
  // 6-digit verification code email for listing/gift confirmation.
  // Preserves send-verify.js exactly.
  // ============================================================
  if (type === 'verify') {
    const { email, code, eventName, seats } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'email and code are required' });

    const resend    = new Resend(process.env.RESEND_API_KEY);
    const seatList  = Array.isArray(seats) ? seats.join(', ') : (seats || 'Reserved Seat');

    try {
      const { error } = await resend.emails.send({
        from:    'OC Tickets Live <tickets@octicketslive.com>',
        to:      email,
        subject: `Your listing verification code: ${code}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <div style="font-size:13px;font-weight:700;letter-spacing:2px;color:#C9A84C;text-transform:uppercase;margin-bottom:16px">OC Tickets Live</div>
            <h2 style="font-size:20px;margin:0 0 8px">Ticket Exchange Listing</h2>
            <p style="font-size:14px;color:#555;margin:0 0 24px">
              You requested to list the following ticket(s) on the OC Tickets Exchange:
            </p>
            <div style="background:#f5f5f5;border-radius:6px;padding:16px;margin-bottom:24px">
              <div style="font-size:13px;color:#333;font-weight:600">${eventName || 'Upcoming Event'}</div>
              <div style="font-size:12px;color:#666;margin-top:4px">Seats: ${seatList}</div>
            </div>
            <p style="font-size:14px;color:#555;margin:0 0 12px">Enter this code to confirm your listing:</p>
            <div style="background:#1a1a1a;color:#C9A84C;font-size:36px;font-weight:900;letter-spacing:10px;text-align:center;padding:20px;border-radius:8px;margin-bottom:24px;font-family:monospace">
              ${code}
            </div>
            <p style="font-size:12px;color:#999;margin:0">
              This code expires in 10 minutes. If you did not request this, you can ignore this email — your tickets remain safe.
            </p>
          </div>
        `,
      });

      if (error) {
        console.error('send/verify: Resend error:', error);
        return res.status(500).json({ success: false, error: error.message });
      }

      console.log(`send/verify: ✓ code sent to ${email}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('send/verify error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // Unknown type
  return res.status(400).json({ error: `Unknown type: ${type}. Must be email | sms | verify` });
};
