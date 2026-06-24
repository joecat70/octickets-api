// api/resend-tickets.js
// NOTE: original filename unconfirmed — rename to match the actual repo file.
//
// Two fixes applied to the original logic:
//   1. claim_tokens.phone was being set to the buyer's EMAIL address, not an
//      actual phone number. ZeroScalp's whole identity model is phone-based —
//      a phone column full of email strings breaks anything downstream that
//      ever trusts it.
//   2. Manager resend only excluded status=refunded. A ticket sitting in
//      transfer_pending (an approved ZeroScalp exception transfer, locked
//      until T-30 delivery — see zeroscalp.js approve_exception) or already
//      transferred could still get a fresh, working claim link handed to the
//      ORIGINAL buyer, undermining the transfer hold entirely. Now excludes
//      both, matching the same exclusion the self-serve buyer path already had.

const { Resend } = require('resend');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'apikey': supabaseKey,
  'Authorization': `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, venueUrl, ticketIds, overrideEmail, buyerName, phone, isManagerResend } = req.body;

  const sendToEmail = (overrideEmail || email || '').trim().toLowerCase();
  const base = (venueUrl || 'https://theetestsite.eth.limo').replace(/\/+$/, '');

  if (!sendToEmail) return res.status(400).json({ error: 'Missing email' });

  try {
    let tickets = [];

    // ── MANAGER RESEND: specific ticket IDs + optional corrections ──────────
    if (isManagerResend && ticketIds && ticketIds.length) {

      // 1. Apply corrections to tickets table using service key
      const updateBody = { buyer_email: sendToEmail };
      if (buyerName) updateBody.buyer_name = buyerName;

      for (const ticketId of ticketIds) {
        await fetch(`${supabaseUrl}/rest/v1/tickets?id=eq.${encodeURIComponent(ticketId)}`, {
          method: 'PATCH',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify(updateBody),
        });
      }

      // 2. Upsert buyer record with corrected info
      const existingRes = await fetch(
        `${supabaseUrl}/rest/v1/buyers?email=eq.${encodeURIComponent(sendToEmail)}&select=id,visit_count`,
        { headers }
      );
      const existing = await existingRes.json();
      const buyerRecord = {
        id: existing[0]?.id || ('buyer-' + Date.now()),
        email: sendToEmail,
        updated_at: new Date().toISOString(),
      };
      if (buyerName) buyerRecord.name = buyerName;
      if (phone)     buyerRecord.phone = phone;
      if (!existing[0]) buyerRecord.visit_count = 1;

      await fetch(`${supabaseUrl}/rest/v1/buyers`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(buyerRecord),
      });

      // 3. Fetch those specific tickets.
      // FIX 2: exclude transfer_pending/transferred in addition to refunded —
      // a ticket mid-ZeroScalp-exception-hold (or already transferred away)
      // must not get a working claim link resent to the original buyer.
      const ids = ticketIds.map(id => `"${id}"`).join(',');
      const ticketsRes = await fetch(
        `${supabaseUrl}/rest/v1/tickets?id=in.(${ids})&status=neq.refunded&status=neq.transfer_pending&status=neq.transferred&select=id,seat,event_id,event_name,tier_name,price,payment,status`,
        { headers }
      );
      tickets = await ticketsRes.json() || [];

    // ── BUYER SELF-SERVE: look up by email ───────────────────────────────────
    } else {
      // First try buyer_email column directly on tickets (new purchases)
      const directRes = await fetch(
        `${supabaseUrl}/rest/v1/tickets?buyer_email=eq.${encodeURIComponent(sendToEmail)}&status=eq.valid&select=id,seat,event_id,event_name,tier_name,price,payment,status`,
        { headers }
      );
      tickets = await directRes.json() || [];

      // Fall back to buyers table → buyer_id lookup (legacy purchases)
      if (!tickets.length) {
        const buyerRes = await fetch(
          `${supabaseUrl}/rest/v1/buyers?email=eq.${encodeURIComponent(sendToEmail)}&select=id`,
          { headers }
        );
        const buyers = await buyerRes.json() || [];
        if (buyers.length) {
          const buyerIds = buyers.map(b => `"${b.id}"`).join(',');
          const ticketsRes = await fetch(
            `${supabaseUrl}/rest/v1/tickets?buyer_id=in.(${buyerIds})&status=eq.valid&select=id,seat,event_id,event_name,tier_name,price,payment,status`,
            { headers }
          );
          tickets = await ticketsRes.json() || [];
        }
      }
    }

    // ── No tickets found ─────────────────────────────────────────────────────
    if (!tickets.length) {
      if (!isManagerResend) await sendNotFoundEmail(sendToEmail);
      return res.status(200).json({
        success: true,
        ticketsFound: 0,
        message: isManagerResend
          ? 'Buyer info updated but no valid tickets found to send.'
          : 'No tickets found for this email.',
      });
    }

    // ── Generate claim tokens and send email ─────────────────────────────────
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const ticketLinks = [];

    for (const ticket of tickets) {
      const token = crypto.randomUUID();
      const sbRes = await fetch(`${supabaseUrl}/rest/v1/claim_tokens`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          token,
          ticket_id: ticket.id,
          // FIX 1: this was `sendToEmail` (an email address). claim_tokens.phone
          // is meant to hold an actual phone number — use the real `phone` field
          // already accepted in the request, falling back to blank rather than
          // silently writing an email into a phone column.
          phone: phone || '',
          expires_at: expires,
          claimed: false,
        }),
      });
      if (sbRes.ok) {
        ticketLinks.push({ ...ticket, claimUrl: `${base}/#claim=${token}` });
      }
    }

    if (!ticketLinks.length) {
      return res.status(500).json({ error: 'Failed to generate ticket links' });
    }

    // ── Build and send email ─────────────────────────────────────────────────
    const ticketCards = ticketLinks.map((t, i) => `
      <div style="background:#0a0a0f;border:1px solid #2a2a3a;border-radius:8px;padding:20px;margin-bottom:12px;">
        <div style="margin-bottom:14px;">
          <div style="font-size:10px;letter-spacing:2px;color:#d4af37;text-transform:uppercase;margin-bottom:4px;">Ticket ${i + 1} of ${ticketLinks.length}</div>
          <div style="font-size:16px;font-weight:600;color:#ffffff;">${t.event_name || t.event_id || 'Event'}</div>
          <div style="font-size:13px;color:#9090b0;margin-top:3px;">${t.seat || 'General Admission'}${t.tier_name ? ' · ' + t.tier_name : ''}</div>
          <div style="font-size:11px;color:#555570;margin-top:3px;font-family:monospace;">${t.id}</div>
        </div>
        <a href="${t.claimUrl}" style="display:block;background:linear-gradient(135deg,#d4af37,#f0c842);color:#000000;text-decoration:none;text-align:center;padding:13px 24px;border-radius:6px;font-weight:700;font-size:14px;">
          View Ticket ${i + 1} →
        </a>
      </div>
    `).join('');

    const subjectPrefix = isManagerResend ? 'Your tickets (resent by venue) — ' : 'Your ';
    const { data, error } = await resend.emails.send({
      from: 'OC Tickets Live <tickets@octicketslive.com>',
      to: sendToEmail,
      subject: `${subjectPrefix}${ticketLinks.length} ticket${ticketLinks.length > 1 ? 's' : ''} — OC Tickets Live`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#0a0a0f;font-family:'Helvetica Neue',Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
          <div style="text-align:center;margin-bottom:32px;">
            <div style="font-size:13px;letter-spacing:3px;color:#d4af37;text-transform:uppercase;margin-bottom:8px;">OC Tickets Live</div>
            <div style="width:48px;height:1px;background:#d4af37;margin:0 auto;"></div>
          </div>
          <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;overflow:hidden;margin-bottom:20px;">
            <div style="height:4px;background:linear-gradient(90deg,#d4af37,#f0c842,#d4af37);"></div>
            <div style="padding:24px 32px;">
              <div style="font-size:11px;letter-spacing:2px;color:#d4af37;text-transform:uppercase;margin-bottom:8px;">Your Tickets</div>
              <div style="font-size:20px;font-weight:700;color:#ffffff;">${ticketLinks.length} ticket${ticketLinks.length > 1 ? 's' : ''} ${isManagerResend ? '(resent by venue)' : 'found'}</div>
              <div style="font-size:13px;color:#9090b0;margin-top:6px;">Each button opens your individual ticket with a rotating QR code for door entry.</div>
            </div>
          </div>
          ${ticketCards}
          <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:8px;padding:16px;margin-top:8px;margin-bottom:24px;">
            <div style="font-size:12px;color:#9090b0;line-height:1.6;">
              🔒 <strong style="color:#ffffff;">Each link is single-use.</strong>
              First tap activates your rotating QR code. Links expire in 7 days.
            </div>
          </div>
          <div style="text-align:center;"><div style="font-size:11px;color:#555570;">OC Tickets Live · Powered by Ethereum</div></div>
        </div></body></html>`
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send email', detail: error.message });
    }

    return res.status(200).json({ success: true, ticketsFound: ticketLinks.length, emailId: data.id });

  } catch (err) {
    console.error('resend-tickets error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};

async function sendNotFoundEmail(email) {
  try {
    await resend.emails.send({
      from: 'OC Tickets Live <tickets@octicketslive.com>',
      to: email,
      subject: 'OC Tickets Live — Ticket lookup',
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:'Helvetica Neue',Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
          <div style="text-align:center;margin-bottom:32px;">
            <div style="font-size:13px;letter-spacing:3px;color:#d4af37;text-transform:uppercase;margin-bottom:8px;">OC Tickets Live</div>
            <div style="width:48px;height:1px;background:#d4af37;margin:0 auto;"></div>
          </div>
          <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;padding:32px;text-align:center;">
            <div style="font-size:32px;margin-bottom:16px;">🎫</div>
            <div style="font-size:18px;color:#ffffff;margin-bottom:12px;">No tickets found</div>
            <div style="font-size:14px;color:#9090b0;line-height:1.6;">We couldn't find any active tickets for this email address.<br><br>If you used a different email at checkout, please try again with that address.</div>
          </div>
          <div style="text-align:center;margin-top:24px;"><div style="font-size:11px;color:#555570;">OC Tickets Live · Powered by Ethereum</div></div>
        </div></body></html>`
    });
  } catch(e) { console.warn('Could not send not-found email:', e.message); }
}
