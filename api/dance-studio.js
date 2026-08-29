// ============================================================
// /api/dance-studio.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// Server-side companion to dance_studio_admin.html
//
// Routes by req.body.action:
//   'send_code_email'  → emails a family/student their access code
//   'redeem_code'       → NOT IMPLEMENTED — see comment below
//
// WHY THIS FILE EXISTS SEPARATELY FROM api/send.js: that endpoint's
// shape is built around TICKET DELIVERY specifically — every call site
// in bailey_hall_admin passes a ticketId/seat, because the email it
// sends is "here's your ticket." An access code is issued before any
// ticket exists, so it needs its own template and its own endpoint —
// same reasoning zeroscalp.js already follows for its own notification
// emails (its own Resend init, its own templates), not reusing
// api/send.js either. This file follows that same precedent.
//
// 'redeem_code' IS NOT BUILT. Per Joe's decision, ticket purchase for a
// code-gated event must require a valid code up front (replacing
// "Choose Seats" outright), and code consumption must be tied to
// CONFIRMED PAYMENT (Stripe webhook), never to code entry alone — the
// same posture zeroscalp.js takes with transfer_pending/release, so an
// abandoned cart can never burn a family's one-time code. Building that
// means changes to bailey_hall_v1_2.html's buy flow AND a webhook-side
// redemption step — real, tracked, cross-file work, not an addition to
// this isolated file. This action returns 501 on purpose, rather than
// silently doing nothing or half-implementing something unsafe.
// ============================================================

const { Resend } = require('resend');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FROM_EMAIL = 'OC Tickets Live <tickets@octicketslive.com>';

async function sendEmail({ to, subject, html }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
  if (error) throw new Error(error.message);
}

function baseTemplate(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0900;font-family:-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0900;padding:24px 16px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
<tr><td style="background:#0e0c08;border:1px solid #2a2310;border-radius:8px;padding:28px 28px 24px">
<div style="font-size:10px;font-weight:700;letter-spacing:3px;color:#C9A84C;text-transform:uppercase;font-family:monospace;margin-bottom:18px">OC Tickets Live · Dance Studio Access</div>
${content}
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #1e1c14;font-size:10px;color:#4a4530;font-family:monospace;line-height:1.8">
OC Tickets Live · octicketslive.com
</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function tplCodeIssued({ studentNames, code, eventName, compCount }) {
  const namesLine = studentNames.length > 1
    ? `for ${studentNames.slice(0, -1).join(', ')} and ${studentNames[studentNames.length - 1]}`
    : `for ${studentNames[0]}`;
  return baseTemplate(`
<div style="font-size:17px;font-weight:700;color:#f5f0e6;margin-bottom:6px">Your Access Code</div>
<div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">This code unlocks ${compCount} complimentary ticket(s) ${namesLine} for ${eventName}.</div>
<div style="margin:20px 0;text-align:center;background:#13110a;border:1px solid #2a2310;border-radius:4px;padding:20px">
<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a7f5c;margin-bottom:8px">Access code</div>
<div style="font-size:28px;font-weight:700;letter-spacing:4px;color:#C9A84C;font-family:monospace">${code}</div>
</div>
<div style="font-size:11px;color:#8a7f5c;font-family:monospace;line-height:1.7">
Enter this code when purchasing tickets to ${eventName}. This code is single-use and valid for this event only.
</div>`);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });

  if (action === 'send_code_email') {
    const { email, studentNames, code, eventName, compCount } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!code) return res.status(400).json({ error: 'code required' });
    if (!studentNames || !studentNames.length) return res.status(400).json({ error: 'studentNames required' });

    try {
      await sendEmail({
        to: email,
        subject: `Your Access Code — ${eventName || 'Upcoming Show'}`,
        html: tplCodeIssued({ studentNames, code, eventName: eventName || 'the show', compCount: compCount || 2 }),
      });
      console.log(`✓ Access code emailed: ${code} → ${email}`);
      return res.status(200).json({ sent: true });
    } catch (err) {
      console.error('dance-studio/send_code_email error:', err.message);
      return res.status(500).json({ error: 'Failed to send email', detail: err.message });
    }
  }

  if (action === 'redeem_code') {
    // NOT IMPLEMENTED — see header comment. Returning 501 rather than a
    // generic 400/500 so this is unambiguous in logs and in any client
    // that calls it early: this isn't a bug, it's not built yet.
    return res.status(501).json({
      error: 'redeem_code is not implemented yet',
      detail: 'Code redemption must be wired to confirmed Stripe payment on the Bailey Hall buy flow, not called directly. See dance_studio_admin.html header comment and api/dance-studio.js header comment for the full scope of what remains.',
    });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
};
