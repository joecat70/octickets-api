// ============================================================
// /api/zeroscalp.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// ZeroScalp — Consolidated enforcement + exception governance
//
// Routes by req.body.action:
//   'validate_price'              → resale price cap enforcement
//   'check_eligibility'           → transfer eligibility gate
//   'request_exception'           → phone match + OTP send
//   'confirm_exception_otp'       → OTP validate + dual write
//   'approve_exception'           → venue/platform approval
//   'deny_exception'              → venue/platform denial
//   'release_approved_exceptions' → 30-min pre-doors delivery
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const crypto           = require('crypto');
const { v4: uuidv4 }   = require('uuid');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VENUE_ADMIN_EMAIL    = process.env.VENUE_ADMIN_EMAIL    || 'admin@octicketslive.com';
const PLATFORM_ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || 'joe@ten2022.com';
const FROM_EMAIL           = 'OC Tickets Live <tickets@octicketslive.com>';

// ── Helpers ────────────────────────────────────────────────
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp + (process.env.OTP_SALT || 'zs-otp-salt')).digest('hex');
}
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function normalizePhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}
function maskPhone(p) {
  const n = normalizePhone(p);
  return n.length >= 4 ? '***-***-' + n.slice(-4) : '****';
}

// Rolling 6-month exception count for a phone across platform DB
async function getRollingExceptionCount(phone) {
  const sixMonthsAgo = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('platform_exception_requests')
    .select('id')
    .eq('requestor_phone', normalizePhone(phone))
    .gte('requested_at', sixMonthsAgo);
  return data?.length || 0;
}

// Detect repeat resale pattern — same phone, 2+ different events in 6 months
async function detectRepeatResalePattern(phone) {
  const sixMonthsAgo = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('platform_exception_requests')
    .select('event_id')
    .eq('requestor_phone', normalizePhone(phone))
    .gte('requested_at', sixMonthsAgo);
  if (!data) return false;
  const uniqueEvents = new Set(data.map(r => r.event_id));
  return uniqueEvents.size >= 2;
}

// ── Notification helper ────────────────────────────────────
async function sendNotificationEmail({ to, subject, html }) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
    if (error) console.error('ZS notification email error:', error.message, '→', to);
    else console.log(`✓ ZS notification sent → ${to}: ${subject}`);
  } catch (err) {
    console.error('ZS notification send failed:', err.message, '→', to);
  }
}

// ── Email templates ────────────────────────────────────────
function baseTemplate(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0900;font-family:-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0900;padding:24px 16px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
  <tr><td style="background:#0e0c08;border:1px solid #2a2310;border-radius:8px;padding:28px 28px 24px">
    <div style="font-size:10px;font-weight:700;letter-spacing:3px;color:#C9A84C;text-transform:uppercase;font-family:monospace;margin-bottom:18px">⚡ OC Tickets Live · ZeroScalp</div>
    ${content}
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #1e1c14;font-size:10px;color:#4a4530;font-family:monospace;line-height:1.8">
      OC Tickets Live · octicketslive.com<br>This is an automated ZeroScalp governance notification.
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function row(label, value) {
  return `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1c14;font-size:12px">
    <span style="color:#8a7f5c;font-family:monospace">${label}</span>
    <span style="color:#f5f0e6;font-weight:600;text-align:right;max-width:60%">${value}</span>
  </div>`;
}

// Notification 1 — Exception request received (to venue admin + platform admin)
function tplExceptionReceived({ excReq, eventName, seat, ticketId }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#f5f0e6;margin-bottom:6px">New Exception Transfer Request</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">A buyer has submitted an exception transfer request for a non-transferable event.</div>
    ${row('Event', eventName || excReq.event_id)}
    ${row('Seat / Ticket', seat ? `${seat} · ${ticketId}` : ticketId)}
    ${row('Requestor Phone', maskPhone(excReq.requestor_phone))}
    ${row('Requestor Email', excReq.requestor_email || '—')}
    ${row('Recipient', excReq.recipient_name ? `${excReq.recipient_name} · ${excReq.recipient_phone}` : excReq.recipient_phone || '—')}
    ${row('Reason', excReq.reason || 'Not provided')}
    ${row('Approval Tier', excReq.approval_tier === 'platform' ? '⚠ Platform (OC Tickets Live) approval required' : 'Venue Admin')}
    ${row('Request ID', excReq.id)}
    <div style="margin-top:18px;font-size:11px;color:#8a7f5c;font-family:monospace">
      Log in to Venue OS → ⚡ Exceptions to review and approve or deny this request.
    </div>`);
}

// Notification 2 — Approved (to requestor)
// FIX: removed "original ticket remains valid" — ticket is now transfer_pending
// and cannot be used for entry until the transfer is complete or denied.
function tplExceptionApproved({ excReq, eventName, seat }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#1d9e75;margin-bottom:6px">✓ Exception Transfer Approved</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">Your exception transfer request has been approved.</div>
    ${row('Event', eventName || excReq.event_id)}
    ${row('Seat', seat || '—')}
    ${row('Transferring to', excReq.recipient_name ? `${excReq.recipient_name} (${excReq.recipient_email || excReq.recipient_phone})` : excReq.recipient_phone)}
    ${row('Request ID', excReq.id)}
    <div style="margin-top:18px;background:#13110a;border:1px solid #2a2310;border-radius:4px;padding:14px">
      <div style="font-size:12px;color:#C9A84C;font-weight:700;margin-bottom:6px">⚡ ZeroScalp Transfer Hold</div>
      <div style="font-size:11px;color:#8a7f5c;line-height:1.7">
        Your ticket has been placed on <strong style="color:#f5f0e6">transfer hold</strong> and
        <strong style="color:#c0392b">cannot be used for entry</strong> until the transfer is complete.
        The recipient will receive their ticket <strong style="color:#f5f0e6">30 minutes before doors open</strong>,
        at which point your original ticket will be permanently invalidated.
        If this request is cancelled before delivery, your ticket will be restored to valid status.
      </div>
    </div>`);
}

// Notification 3 — Denied (to requestor)
function tplExceptionDenied({ excReq, eventName, seat, reviewerNotes }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#c0392b;margin-bottom:6px">Exception Transfer Request — Not Approved</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">Your exception transfer request could not be approved at this time.</div>
    ${row('Event', eventName || excReq.event_id)}
    ${row('Seat', seat || '—')}
    ${row('Request ID', excReq.id)}
    ${reviewerNotes ? row('Notes', reviewerNotes) : ''}
    <div style="margin-top:18px;font-size:11px;color:#8a7f5c;font-family:monospace;line-height:1.7">
      Your original ticket has been restored to valid status and is fully usable for entry.
      If you believe this decision was made in error, please contact the venue directly.
    </div>`);
}

// Notification 4a — Ticket delivered to recipient
function tplTicketDelivered({ excReq, eventName, seat, claimUrl }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#f5f0e6;margin-bottom:6px">Your Ticket Has Arrived</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">A ticket has been transferred to you via ZeroScalp exception transfer.</div>
    ${row('Event', eventName || excReq.event_id)}
    ${row('Seat', seat || '—')}
    ${row('From', maskPhone(excReq.requestor_phone))}
    <div style="margin-top:18px;text-align:center">
      <a href="${claimUrl}" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:1px;padding:12px 32px;border-radius:4px;text-transform:uppercase">
        Access My Ticket →
      </a>
    </div>
    <div style="margin-top:14px;font-size:11px;color:#4a4530;font-family:monospace;text-align:center;word-break:break-all">${claimUrl}</div>
    <div style="margin-top:12px;font-size:10px;color:#4a4530;font-family:monospace;line-height:1.7">
      🔒 This ticket includes a rotating QR code. Do not share this link. Screenshots are not valid at the door.
    </div>`);
}

// Notification 4b — Transfer complete confirmation to requestor
function tplTransferComplete({ excReq, eventName, seat }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#1d9e75;margin-bottom:6px">✓ Transfer Complete</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">Your exception transfer has been executed.</div>
    ${row('Event', eventName || excReq.event_id)}
    ${row('Seat', seat || '—')}
    ${row('Transferred to', excReq.recipient_name || excReq.recipient_phone)}
    ${row('Request ID', excReq.id)}
    <div style="margin-top:18px;font-size:11px;color:#8a7f5c;font-family:monospace">
      Your original ticket has been permanently invalidated. The recipient has been sent their ticket claim link.
      This completes your exception transfer request.
    </div>`);
}

// Notification 5 — Account flagged (platform admin only, internal)
function tplAccountFlagged({ phone, rollingCount, eventId }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#C9A84C;margin-bottom:6px">⚠ ZeroScalp Flag — Account Threshold Reached</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">A phone number has reached the exception request flag threshold (3 requests in 6 months).</div>
    ${row('Phone (masked)', maskPhone(phone))}
    ${row('Rolling 6-month count', String(rollingCount))}
    ${row('Event (current request)', eventId)}
    <div style="margin-top:18px;font-size:11px;color:#8a7f5c;font-family:monospace;line-height:1.7">
      This request is proceeding normally. Full cross-venue history has been surfaced to approvers.
      One more request from this number will trigger automatic denial.
    </div>`);
}

// Notification 6 — Auto-denied (to requestor + platform admin)
function tplAutoDenied({ phone, eventName }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#c0392b;margin-bottom:6px">Exception Transfer Request — Unable to Process</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">We were unable to process your exception transfer request at this time.</div>
    ${row('Event', eventName || '—')}
    <div style="margin-top:18px;font-size:11px;color:#8a7f5c;font-family:monospace;line-height:1.7">
      Your original ticket remains valid and unaffected. If you need assistance, please contact the venue directly.
    </div>`);
}

function tplAutoDeniedAdmin({ phone, rollingCount, eventId }) {
  return baseTemplate(`
    <div style="font-size:17px;font-weight:700;color:#c0392b;margin-bottom:6px">⛔ ZeroScalp Auto-Denial — Audit Record</div>
    <div style="font-size:12px;color:#8a7f5c;margin-bottom:20px">An exception transfer request was automatically denied — request limit exceeded.</div>
    ${row('Phone (masked)', maskPhone(phone))}
    ${row('Rolling 6-month count', String(rollingCount))}
    ${row('Event', eventId)}
    <div style="margin-top:18px;font-size:11px;color:#8a7f5c;font-family:monospace">
      Audit record written to platform_exception_requests. No further action required unless manual review is warranted.
    </div>`);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });

  // ============================================================
  // ACTION: validate_price
  // ============================================================
  if (action === 'validate_price') {
    const { ticket_id, asked_price } = req.body;
    if (!ticket_id || asked_price == null) return res.status(400).json({ error: 'ticket_id and asked_price required' });
    const askedNum = parseFloat(asked_price);
    if (isNaN(askedNum) || askedNum <= 0) return res.status(400).json({ error: 'asked_price must be a positive number' });
    try {
      const { data: ticket } = await supabase.from('tickets').select('id, price, stripe_fee, event_id, status').eq('id', ticket_id).maybeSingle();
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (!['valid','listed'].includes(ticket.status)) return res.status(400).json({ error: 'Ticket not eligible for resale', status: ticket.status });
      const { data: config } = await supabase.from('event_config').select('resale_rule, transfer_enabled').eq('event_id', ticket.event_id).maybeSingle();
      const resaleRule = config?.resale_rule ?? 'open';
      if (resaleRule === 'original_plus_fees') {
        const originalPrice = parseFloat(ticket.price)      || 0;
        const stripeFee     = parseFloat(ticket.stripe_fee) || parseFloat(((originalPrice * 0.029) + 0.30).toFixed(2));
        const maxPrice      = parseFloat((originalPrice + stripeFee).toFixed(2));
        if (askedNum > maxPrice) {
          return res.status(400).json({ allowed: false, max_price: maxPrice, original: originalPrice, stripe_fee: stripeFee, resale_rule: resaleRule, reason: `Resale price capped at original price + Stripe fee ($${maxPrice.toFixed(2)})` });
        }
      }
      return res.status(200).json({ allowed: true, resale_rule: resaleRule, asked_price: askedNum });
    } catch (err) { return res.status(500).json({ error: 'Internal error', detail: err.message }); }
  }

  // ============================================================
  // ACTION: check_eligibility
  // ============================================================
  if (action === 'check_eligibility') {
    const { ticket_id } = req.body;
    if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });
    try {
      const { data: ticket } = await supabase.from('tickets').select('id, event_id, status, price, stripe_fee').eq('id', ticket_id).maybeSingle();
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.status !== 'valid') return res.status(200).json({ eligible: false, reason: `Ticket status is '${ticket.status}' — only valid tickets can be transferred` });
      const { data: config } = await supabase.from('event_config').select('transfer_enabled, resale_rule, price_cap_bps, doors_open').eq('event_id', ticket.event_id).maybeSingle();
      const transferEnabled = config?.transfer_enabled ?? true;
      const resaleRule      = config?.resale_rule      ?? 'open';
      const originalPrice   = parseFloat(ticket.price)      || 0;
      const stripeFee       = parseFloat(ticket.stripe_fee) || parseFloat(((originalPrice * 0.029) + 0.30).toFixed(2));
      const maxPrice        = resaleRule === 'original_plus_fees' ? parseFloat((originalPrice + stripeFee).toFixed(2)) : null;
      if (!transferEnabled) {
        return res.status(200).json({
          eligible: false, transfer_enabled: false,
          reason: 'Transfers are disabled for this event. You may request an exception transfer through the platform.',
          exception_eligible: true,
          resale_rule: resaleRule, max_price: maxPrice,
          original_price: originalPrice, stripe_fee: stripeFee,
        });
      }
      return res.status(200).json({ eligible: true, transfer_enabled: true, resale_rule: resaleRule, max_price: maxPrice, original_price: originalPrice, stripe_fee: stripeFee });
    } catch (err) { return res.status(500).json({ error: 'Internal error', detail: err.message }); }
  }

  // ============================================================
  // ACTION: request_exception
  // ============================================================
  if (action === 'request_exception') {
    const { ticket_id, requestor_phone, requestor_email } = req.body;
    if (!ticket_id || !requestor_phone) return res.status(400).json({ error: 'ticket_id and requestor_phone required' });
    if (!requestor_email) return res.status(400).json({ error: 'requestor_email required' });

    try {
      const { data: ticket } = await supabase.from('tickets').select('id, event_id, buyer_phone, buyer_email, buyer_name, price, status').eq('id', ticket_id).maybeSingle();
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.status !== 'valid') return res.status(400).json({ error: 'Ticket is not eligible for exception transfer' });

      const purchasePhone = normalizePhone(ticket.buyer_phone || '');
      const requestorNorm = normalizePhone(requestor_phone);
      if (!purchasePhone || purchasePhone !== requestorNorm) {
        return res.status(200).json({ verified: false, reason: 'Phone number does not match the purchase record.' });
      }

      const rollingCount = await getRollingExceptionCount(requestor_phone);
      const { data: evConfig } = await supabase.from('event_config').select('doors_open').eq('event_id', ticket.event_id).maybeSingle();

      if (rollingCount >= 4) {
        await supabase.from('platform_exception_requests').insert({
          id: 'exc-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
          ticket_id, event_id: ticket.event_id, venue_id: 'casino-dania-beach',
          requestor_phone: requestorNorm, requestor_email: requestor_email || ticket.buyer_email || null,
          requestor_name: ticket.buyer_name || null, recipient_phone: '',
          status: 'denied', delivery_status: 'none', otp_verified: false,
          prior_exception_count: rollingCount, repeat_resale_flag: true,
          approval_tier: 'platform', reviewer_notes: 'Auto-denied: request limit exceeded',
        });
        const requestorEmail = requestor_email || ticket.buyer_email;
        if (requestorEmail) {
          sendNotificationEmail({ to: requestorEmail, subject: `Exception Transfer Request — Unable to Process`, html: tplAutoDenied({ phone: requestorNorm, eventName: ticket.event_id }) });
        }
        sendNotificationEmail({ to: PLATFORM_ADMIN_EMAIL, subject: `⛔ ZeroScalp Auto-Denial — ${requestorNorm}`, html: tplAutoDeniedAdmin({ phone: requestorNorm, rollingCount, eventId: ticket.event_id }) });
        return res.status(200).json({ verified: false, auto_denied: true, reason: 'Exception request limit reached. This request has been logged.' });
      }

      const approvalTier = rollingCount >= 1 ? 'platform' : 'venue_admin';
      const flagged      = rollingCount >= 3;

      if (flagged) {
        sendNotificationEmail({ to: PLATFORM_ADMIN_EMAIL, subject: `⚠ ZeroScalp Flag — ${maskPhone(requestorNorm)}`, html: tplAccountFlagged({ phone: requestorNorm, rollingCount, eventId: ticket.event_id }) });
      }

      const otp        = generateOtp();
      const otpHash    = hashOtp(otp);
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const requestId  = 'exc-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);

      const { error: insertErr } = await supabase.from('exception_requests').insert({
        id: requestId, ticket_id, event_id: ticket.event_id,
        requestor_phone: requestorNorm, requestor_email: requestor_email || ticket.buyer_email || null,
        requestor_name: ticket.buyer_name || null, recipient_phone: '',
        status: 'pending', delivery_status: 'none', otp_verified: false,
        otp_hash: otpHash, otp_expires_at: otpExpires, approval_tier: approvalTier,
      });
      if (insertErr) return res.status(500).json({ error: 'Failed to create exception request' });

      let otpSent = false;
      if (process.env.SMS_ENABLED === 'true' && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const twilio = require('twilio');
          const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to:   '+1' + requestorNorm,
            body: `Your OC Tickets Live exception transfer code: ${otp}\n\nValid for 10 minutes. Do not share this code.`,
          });
          otpSent = true;
        } catch (smsErr) {
          console.warn('OTP SMS failed:', smsErr.message);
        }
      }

      return res.status(200).json({
        verified: true, otp_sent: otpSent, request_id: requestId,
        approval_tier: approvalTier, flagged,
        ...(!otpSent && { otp_testing: otp }),
      });

    } catch (err) {
      console.error('zeroscalp/request_exception error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  // ============================================================
  // ACTION: confirm_exception_otp
  // ============================================================
  if (action === 'confirm_exception_otp') {
    const { request_id, otp, recipient_phone, recipient_email, recipient_name, reason } = req.body;
    if (!request_id || !otp) return res.status(400).json({ error: 'request_id and otp required' });

    try {
      const { data: excReq } = await supabase.from('exception_requests').select('*').eq('id', request_id).maybeSingle();
      if (!excReq)          return res.status(404).json({ error: 'Exception request not found' });
      if (excReq.otp_verified) return res.status(400).json({ error: 'OTP already verified' });
      if (!excReq.otp_hash || !excReq.otp_expires_at) return res.status(400).json({ error: 'No OTP on record — start over' });
      if (new Date(excReq.otp_expires_at) < new Date()) return res.status(400).json({ error: 'OTP expired — start over' });
      if (hashOtp(otp) !== excReq.otp_hash) return res.status(400).json({ error: 'Incorrect code — check your message and try again' });

      const rollingCount = await getRollingExceptionCount(excReq.requestor_phone);
      const repeatResale = await detectRepeatResalePattern(excReq.requestor_phone);

      await supabase.from('exception_requests').update({
        otp_verified: true, otp_hash: null, otp_expires_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', request_id);

      return res.status(200).json({
        submitted: true, request_id, approval_tier: excReq.approval_tier,
        flagged: rollingCount >= 3, repeat_resale: repeatResale,
      });

    } catch (err) {
      console.error('zeroscalp/confirm_exception_otp error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  // ============================================================
  // ACTION: approve_exception
  // FIX: immediately sets original ticket to 'transfer_pending'
  // so the original holder cannot use it for entry between
  // approval and the T-30 delivery window.
  // Triggers Notification 2 — approved email to requestor.
  // Body: { action, request_id, reviewer_notes }
  // ============================================================
  if (action === 'approve_exception') {
    const { request_id, reviewer_notes } = req.body;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    try {
      const { data: excReq } = await supabase.from('exception_requests').select('*').eq('id', request_id).maybeSingle();
      if (!excReq)              return res.status(404).json({ error: 'Exception request not found' });
      if (!excReq.otp_verified) return res.status(400).json({ error: 'OTP not verified — cannot approve' });
      if (excReq.status !== 'pending') return res.status(400).json({ error: `Request already ${excReq.status}` });

      const now = new Date().toISOString();

      // FIX: Set original ticket to 'transfer_pending' immediately on approval.
      // This prevents the original holder from using their QR code for entry
      // during the window between approval and the T-30 delivery.
      // The door scanner must deny 'transfer_pending' status.
      const { error: ticketUpdateErr } = await supabase
        .from('tickets')
        .update({ status: 'transfer_pending', updated_at: now })
        .eq('id', excReq.ticket_id);

      if (ticketUpdateErr) {
        console.error('zeroscalp/approve_exception: failed to set transfer_pending:', ticketUpdateErr.message);
        return res.status(500).json({ error: 'Failed to lock original ticket — approval aborted', detail: ticketUpdateErr.message });
      }

      await supabase.from('exception_requests').update({
        status: 'approved', delivery_status: 'none',
        reviewed_at: now, reviewer_notes: reviewer_notes || null, updated_at: now,
      }).eq('id', request_id);

      await supabase.from('platform_exception_requests')
        .update({ status: 'approved', reviewed_at: now, reviewer_notes: reviewer_notes || null, updated_at: now })
        .eq('id', 'plat-' + request_id)
        .then(() => {}, e => console.error('Platform approve sync error:', e.message));

      // Load ticket info for notification
      const { data: ticket } = await supabase.from('tickets').select('seat, event_name').eq('id', excReq.ticket_id).maybeSingle();
      const eventName = ticket?.event_name || excReq.event_id;
      const seat      = ticket?.seat || '—';

      // Notification 2 — approved → requestor
      if (excReq.requestor_email) {
        sendNotificationEmail({
          to:      excReq.requestor_email,
          subject: `✓ Exception Transfer Approved — ${eventName}`,
          html:    tplExceptionApproved({ excReq, eventName, seat }),
        });
      }
      // Platform copy
      sendNotificationEmail({
        to:      PLATFORM_ADMIN_EMAIL,
        subject: `[Platform] Exception Approved — ${request_id}`,
        html:    tplExceptionApproved({ excReq, eventName, seat }),
      });

      console.log(`zeroscalp/approve_exception: ✓ approved ${request_id} — ticket ${excReq.ticket_id} set to transfer_pending`);
      return res.status(200).json({
        approved: true, request_id,
        delivery_status: 'none',
        ticket_status: 'transfer_pending',
        message: 'Approved. Original ticket locked (transfer_pending). Ticket will be delivered 30 minutes before doors open.',
      });

    } catch (err) {
      console.error('zeroscalp/approve_exception error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  // ============================================================
  // ACTION: deny_exception
  // FIX: if ticket was previously set to transfer_pending
  // (i.e. approved then re-denied), restore it to 'valid'.
  // Triggers Notification 3 — denied email to requestor.
  // Body: { action, request_id, reviewer_notes }
  // ============================================================
  if (action === 'deny_exception') {
    const { request_id, reviewer_notes } = req.body;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    try {
      const { data: excReq } = await supabase.from('exception_requests').select('*').eq('id', request_id).maybeSingle();
      if (!excReq) return res.status(404).json({ error: 'Exception request not found' });

      const now = new Date().toISOString();

      // Restore ticket to 'valid' if it was locked as transfer_pending on a prior approval.
      // Covers the edge case where approve → deny sequence occurs.
      const { data: ticket } = await supabase.from('tickets').select('status, seat, event_name').eq('id', excReq.ticket_id).maybeSingle();
      if (ticket?.status === 'transfer_pending') {
        await supabase.from('tickets')
          .update({ status: 'valid', updated_at: now })
          .eq('id', excReq.ticket_id);
        console.log(`zeroscalp/deny_exception: ticket ${excReq.ticket_id} restored to valid`);
      }

      await supabase.from('exception_requests').update({
        status: 'denied', reviewed_at: now, reviewer_notes: reviewer_notes || null, updated_at: now,
      }).eq('id', request_id);

      await supabase.from('platform_exception_requests')
        .update({ status: 'denied', reviewed_at: now, reviewer_notes: reviewer_notes || null, updated_at: now })
        .eq('id', 'plat-' + request_id)
        .then(() => {}, e => console.error('Platform deny sync error:', e.message));

      const eventName = ticket?.event_name || excReq.event_id;
      const seat      = ticket?.seat || '—';

      // Notification 3 — denied → requestor
      if (excReq.requestor_email) {
        sendNotificationEmail({
          to:      excReq.requestor_email,
          subject: `Exception Transfer Request — Not Approved`,
          html:    tplExceptionDenied({ excReq, eventName, seat, reviewerNotes: reviewer_notes || null }),
        });
      }

      return res.status(200).json({ denied: true, request_id });
    } catch (err) {
      console.error('zeroscalp/deny_exception error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  // ============================================================
  // ACTION: release_approved_exceptions
  // FIX: creates a NEW ticket record for the recipient instead
  // of reassigning buyer fields on the original. Original ticket
  // is set to 'transferred' (permanently dead). This ensures
  // two distinct ticket IDs — the original QR is cryptographically
  // invalid after transfer, not just reassigned.
  // Triggers Notifications 4a + 4b.
  // Body: { action }
  // ============================================================
  if (action === 'release_approved_exceptions') {
    try {
      const now = new Date();
      const { data: approved } = await supabase
        .from('exception_requests')
        .select('*')
        .eq('status', 'approved')
        .eq('delivery_status', 'none');

      if (!approved || approved.length === 0) return res.status(200).json({ released: 0, checked: 0 });

      let released = 0;
      const results = [];

      for (const excReq of approved) {
        try {
          const { data: config } = await supabase.from('event_config').select('doors_open').eq('event_id', excReq.event_id).maybeSingle();
          if (!config?.doors_open) {
            results.push({ id: excReq.id, skipped: true, reason: 'No doors_open configured' });
            continue;
          }

          const doorsOpen     = new Date(config.doors_open);
          const releaseWindow = new Date(doorsOpen.getTime() - 30 * 60 * 1000);

          if (now < releaseWindow) {
            const minsRemaining = Math.round((releaseWindow - now) / 60000);
            results.push({ id: excReq.id, skipped: true, reason: `${minsRemaining} min until release window` });
            continue;
          }

          // Mark pending delivery
          await supabase.from('exception_requests').update({
            delivery_status: 'pending_exception_delivery', updated_at: now.toISOString(),
          }).eq('id', excReq.id);
          await supabase.from('platform_exception_requests').update({
            delivery_status: 'pending_exception_delivery', updated_at: now.toISOString(),
          }).eq('id', 'plat-' + excReq.id).then(() => {}, () => {});

          // Load original ticket to copy its data for the new ticket
          const { data: origTicket } = await supabase
            .from('tickets')
            .select('*')
            .eq('id', excReq.ticket_id)
            .maybeSingle();

          if (!origTicket) {
            results.push({ id: excReq.id, error: 'Original ticket not found' });
            continue;
          }

          // FIX: Create a NEW ticket for the recipient — fresh ID, fresh QR seed.
          // The original ticket's QR code is tied to its ID; by issuing a new ID
          // the original QR is permanently dead regardless of status.
          const newTicketId = origTicket.id.replace(/^CADB-/, 'CADB-X-');
          const { error: newTicketErr } = await supabase.from('tickets').insert({
            ...origTicket,
            id:           newTicketId,
            buyer_email:  excReq.recipient_email || null,
            buyer_name:   excReq.recipient_name  || null,
            buyer_phone:  excReq.recipient_phone  || null,
            status:       'valid',
            payment:      'exception_transfer',
            purchased_at: now.toISOString(),
            updated_at:   now.toISOString(),
          });

          if (newTicketErr) {
            console.error(`zeroscalp/release: failed to create new ticket for ${excReq.id}:`, newTicketErr.message);
            results.push({ id: excReq.id, error: 'Failed to create recipient ticket: ' + newTicketErr.message });
            continue;
          }

          // FIX: Permanently invalidate the original ticket.
          // Status 'transferred' is final — door scanner denies entry,
          // QR validation rejects it, no further changes permitted.
          await supabase.from('tickets').update({
            status:     'transferred',
            updated_at: now.toISOString(),
          }).eq('id', excReq.ticket_id);

          // Create claim token for recipient pointing to the NEW ticket ID
          const token     = uuidv4();
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const baseUrl   = process.env.VENUE_BASE_URL || 'https://theetestsite.eth.limo';
          await supabase.from('claim_tokens').insert({
            token,
            ticket_id:  newTicketId,
            phone:      excReq.recipient_phone || null,
            expires_at: expiresAt,
            claimed:    false,
          }).then(() => {}, e => console.error('Claim token error:', e.message));
          const claimUrl = `${baseUrl}/#claim=${token}`;

          // Load event info for notifications
          const eventName = origTicket.event_name || excReq.event_id;
          const seat      = origTicket.seat || '—';

          // Mark delivered
          await supabase.from('exception_requests').update({
            delivery_status: 'delivered', updated_at: now.toISOString(),
          }).eq('id', excReq.id);
          await supabase.from('platform_exception_requests').update({
            delivery_status: 'delivered', updated_at: now.toISOString(),
          }).eq('id', 'plat-' + excReq.id).then(() => {}, () => {});

          // Notification 4a — ticket delivered to recipient
          if (excReq.recipient_email) {
            sendNotificationEmail({
              to:      excReq.recipient_email,
              subject: `Your Ticket Has Arrived — ${eventName}`,
              html:    tplTicketDelivered({ excReq, eventName, seat, claimUrl }),
            });
          }

          // Notification 4b — transfer complete to requestor
          if (excReq.requestor_email) {
            sendNotificationEmail({
              to:      excReq.requestor_email,
              subject: `✓ Transfer Complete — ${eventName}`,
              html:    tplTransferComplete({ excReq, eventName, seat }),
            });
          }

          released++;
          results.push({
            id: excReq.id, released: true,
            original_ticket_id: excReq.ticket_id,
            new_ticket_id: newTicketId,
          });
          console.log(`zeroscalp/release: ✓ released ${excReq.id} — original ${excReq.ticket_id} → transferred, new ticket ${newTicketId} → valid`);

        } catch (innerErr) {
          console.error(`zeroscalp/release: error on ${excReq.id}:`, innerErr.message);
          results.push({ id: excReq.id, error: innerErr.message });
        }
      }

      return res.status(200).json({ released, checked: approved.length, results });
    } catch (err) {
      console.error('zeroscalp/release_approved_exceptions error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  // ============================================================
  // ACTION: finalize_exception
  // ============================================================
  if (action === 'finalize_exception') {
    const { request_id, recipient_phone, recipient_email, recipient_name, reason } = req.body;
    if (!request_id)    return res.status(400).json({ error: 'request_id required' });
    if (!recipient_phone) return res.status(400).json({ error: 'recipient_phone required' });

    try {
      const { data: excReq } = await supabase.from('exception_requests').select('*').eq('id', request_id).maybeSingle();
      if (!excReq)              return res.status(404).json({ error: 'Exception request not found' });
      if (!excReq.otp_verified) return res.status(400).json({ error: 'OTP not verified — complete Step 2 first' });

      const recipientNorm  = normalizePhone(recipient_phone);
      const rollingCount   = await getRollingExceptionCount(excReq.requestor_phone);
      const repeatResale   = await detectRepeatResalePattern(excReq.requestor_phone);

      await supabase.from('exception_requests').update({
        recipient_phone: recipientNorm,
        recipient_email: recipient_email || null,
        recipient_name:  recipient_name  || null,
        reason:          reason          || null,
        updated_at:      new Date().toISOString(),
      }).eq('id', request_id);

      await supabase.from('platform_exception_requests').insert({
        id:                    'plat-' + request_id,
        ticket_id:             excReq.ticket_id,
        event_id:              excReq.event_id,
        venue_id:              'casino-dania-beach',
        requestor_phone:       excReq.requestor_phone,
        requestor_email:       excReq.requestor_email || null,
        requestor_name:        excReq.requestor_name  || null,
        recipient_phone:       recipientNorm,
        recipient_email:       recipient_email || null,
        recipient_name:        recipient_name  || null,
        reason:                reason          || null,
        status:                'pending',
        delivery_status:       'none',
        otp_verified:          true,
        prior_exception_count: rollingCount,
        repeat_resale_flag:    repeatResale,
        approval_tier:         excReq.approval_tier,
      }).then(() => {}, e => console.error('Platform dual write error:', e.message));

      const { data: ticket } = await supabase.from('tickets').select('seat, event_name').eq('id', excReq.ticket_id).maybeSingle();
      const eventName  = ticket?.event_name || excReq.event_id;
      const seat       = ticket?.seat || '—';
      const fullExcReq = { ...excReq, recipient_phone: recipientNorm, recipient_email, recipient_name, reason };

      sendNotificationEmail({
        to:      VENUE_ADMIN_EMAIL,
        subject: `⚡ New Exception Transfer Request — ${eventName}`,
        html:    tplExceptionReceived({ excReq: fullExcReq, eventName, seat, ticketId: excReq.ticket_id }),
      });
      sendNotificationEmail({
        to:      PLATFORM_ADMIN_EMAIL,
        subject: `⚡ [Platform Copy] Exception Request — ${eventName}`,
        html:    tplExceptionReceived({ excReq: fullExcReq, eventName, seat, ticketId: excReq.ticket_id }),
      });

      console.log(`zeroscalp/finalize_exception: ✓ request ${request_id} finalized`);
      return res.status(200).json({ finalized: true, request_id });

    } catch (err) {
      console.error('zeroscalp/finalize_exception error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
};
