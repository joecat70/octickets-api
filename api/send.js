// ============================================================
// /api/send.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// Consolidated from: send-email.js, send-sms.js, send-verify.js
//
// Routes by req.body.type:
//   'email'  → ticket confirmation email + claim token (was send-email.js)
//   'sms'    → ticket SMS + claim token      (was send-sms.js)
//   'verify' → listing/gift verification code email (was send-verify.js)
//   'sold'   → seller sold-notification + remaining tickets (Aug 2026)
//
// FIX (Aug 2026, Joe): new 'sold' type. Added because transfer-ticket.js's
// resale-completion path sent NO email of any kind to the seller — no
// confirmation a sale happened, no way back into their other tickets.
// Confirmed via live test: sold a ticket, correctly got rejected trying to
// cancel the (already-sold) listing, but received nothing at all. This is
// deliberately its OWN type rather than reusing 'email' — 'email's copy
// ("Your ticket is confirmed... Access My Ticket") is simply wrong for a
// seller who just gave a ticket up, and 'email' has no way to say anything
// when there's nothing left to link to (zero remaining tickets), which is
// a real case here since a seller might have listed their only ticket.
// Combined into one send per explicit request — not two separate emails —
// so remaining tickets, when there are any, are folded into the same
// message rather than following the gift-email's two-message shape.
// Unlike gift's remaining-tickets email, this type ALWAYS sends (a seller
// walking away from a listing has no other signal a sale occurred; a gift
// giver already sees real-time on-screen confirmation, so that email can
// skip sending when nothing remains — this one can't).
// CORRECTION (Aug 2026, Joe): the net payout dollar amount (sale price
// minus venue royalty) IS shown, computed by transfer-ticket.js using the
// same formula the listing modal's updateSellCalc() already uses (flat
// total*0.1 royalty / total*0.9 to seller) — the exact figure a seller
// already saw and agreed to when listing. An earlier version of this file
// deliberately omitted this, reasoning that a guessed net figure risked
// being wrong in a financial email — that concern was valid, but the right
// fix was finding the real authoritative formula, not leaving the
// information out. See transfer-ticket.js's header for the full account.
//
// FIX (this revision): the SMS branch's venueUrl fallback was hardcoded to
// theetestsite.eth.limo (Casino By The Beach specifically). If any caller
// ever omits venueUrl, every recipient gets a wrong-venue claim link.
// Confirmed NOT currently triggered by club_chaotic_v2_11.html — both of its
// SMS call sites already pass venueUrl correctly via window.location.origin.
// But the fallback itself shouldn't silently mislabel a venue if some other
// caller (Coral Springs, Live Demo, a future venue) ever misses it. Changed
// to the venue-neutral hub domain, matching what the email branch already
// does correctly below.
//
// FIX (Aug 2026, Joe): 7-day claim_tokens.expires_at removed from BOTH the
// email and sms branches. Traced back to the original May build — a default
// picked once and never revisited, not a deliberate security decision. This
// is the file that actually generates a buyer's FIRST claim link at purchase
// time (resend-tickets.js only handles later resends, and had the identical
// pattern independently fixed already) — so this was the one really causing
// "already used or expired" on original purchase emails. Using an
// effectively-permanent date rather than null: claim.js's expiry check is a
// plain `new Date(expires_at) < new Date()` comparison, and null would
// evaluate to epoch (1970) — immediately "expired" — unless that check were
// also rewritten to special-case null. A far-future date needs no changes
// anywhere else that reads expires_at. Matches resend-tickets.js exactly, so
// both files now generate tokens the same way. Buyer-facing "Valid for 7
// days" text removed from the email template below since it would now be
// false. NOTE: if event-based expiry (expire N days after the show, not from
// send time) gets built later per the open discussion, both this file and
// resend-tickets.js need the change together — they're confirmed-parallel
// logic now, not independent.
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

const NO_EXPIRY_YEARS = 100;
function farFutureExpiry() {
  return new Date(Date.now() + NO_EXPIRY_YEARS * 365 * 24 * 60 * 60 * 1000);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { type } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required: email | sms | verify | sold' });

  // ============================================================
  // TYPE: email
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

    const token     = uuidv4();
    const expiresAt = farFutureExpiry();

    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

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
    const claimPhone = req.body.phone || '';

    const { error: dbError } = await db.from('claim_tokens').insert({
      id:         uuidv4(),
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
            <div style="font-size:11px;color:#4a4530;margin-top:8px">Tap or copy into your browser</div>
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
  // TYPE: sold  (Aug 2026)
  // Seller notification after a resale completes, combined with a link to
  // any remaining tickets in the same send. Always sends — see file header
  // for why this differs from the gift-side email's skip-if-none behavior.
  // ============================================================
  if (type === 'sold') {
    const {
      email, name, soldTicketId, soldSeat, eventName,
      resalePrice, royaltyAmount, netPayout, payoutMethod, payoutHandle,
      remainingTicketIds, remainingSeats, venueUrl,
    } = req.body;

    if (!email || !soldTicketId) {
      return res.status(400).json({ error: 'Missing email or soldTicketId' });
    }

    const sellerName = name || 'Ticket Holder';
    const baseUrl    = (venueUrl || 'https://octicketslive.eth.limo').replace(/\/+$/, '');
    const hasRemaining = Array.isArray(remainingTicketIds) && remainingTicketIds.length > 0;
    const remainingCount = hasRemaining ? remainingTicketIds.length : 0;

    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    let claimUrl = null;
    if (hasRemaining) {
      const token     = uuidv4();
      const expiresAt = farFutureExpiry();
      const { error: dbError } = await db.from('claim_tokens').insert({
        id:         uuidv4(),
        token,
        ticket_id:  remainingTicketIds[0],
        phone:      '',
        expires_at: expiresAt.toISOString(),
        claimed:    false,
      });
      if (dbError) {
        console.error('send/sold: DB error saving claim token for remaining tickets:', dbError);
      } else {
        claimUrl = `${baseUrl}/#claim=${token}`;
      }
    }

    const remainingRows = hasRemaining
      ? remainingTicketIds.map((id, i) => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #1e1c14;font-family:-apple-system,sans-serif;font-size:13px;color:#d4c88a">
          ${id || ''}
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #1e1c14;font-family:-apple-system,sans-serif;font-size:13px;color:#f5f0e6;font-weight:600">
          ${(remainingSeats && remainingSeats[i]) || ''}
        </td>
      </tr>`).join('')
      : '';

    const priceLine = (typeof resalePrice === 'number')
      ? `$${resalePrice.toFixed(2)}`
      : 'the listed price';

    // Aug 2026 (Joe): net payout now shown explicitly — same "Venue Royalty
    // $X · You receive $Y" language already used in the listing modal, for
    // consistency with what the seller already saw and agreed to. See this
    // file's header for why an earlier version of this email deliberately
    // omitted this figure, and why that was corrected.
    const hasPayoutMath = typeof royaltyAmount === 'number' && typeof netPayout === 'number';
    const hasPayoutMethod = !!(payoutMethod && payoutHandle);

    const payoutBlock = `
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:16px${hasPayoutMethod ? ';border-bottom:1px solid #1e1c14' : ''}">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">You Receive</div>
            <div style="font-size:18px;font-weight:700;color:#c9a84c">${hasPayoutMath ? `$${netPayout.toFixed(2)}` : priceLine}</div>
            ${hasPayoutMath ? `<div style="font-size:12px;color:#8a7f5c;margin-top:4px">Sale price ${priceLine} minus $${royaltyAmount.toFixed(2)} venue royalty (10%)</div>` : ''}
          </td></tr>
          ${hasPayoutMethod ? `<tr><td style="padding:16px">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Payout Method</div>
            <div style="font-size:14px;color:#f5f0e6">Being processed via <strong>${payoutMethod}</strong> to <strong>${payoutHandle}</strong>.</div>
          </td></tr>` : ''}
        </table>`;

    const remainingBlock = hasRemaining ? `
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:16px">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px">
              You Still Have ${remainingCount} Ticket${remainingCount > 1 ? 's' : ''}
            </div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <th style="padding:8px 16px;background:#0a0900;font-size:10px;color:#8a7f5c;text-transform:uppercase;letter-spacing:1px;font-family:monospace;font-weight:400;text-align:left">Ticket ID</th>
                <th style="padding:8px 16px;background:#0a0900;font-size:10px;color:#8a7f5c;text-transform:uppercase;letter-spacing:1px;font-family:monospace;font-weight:400;text-align:left">Seat</th>
              </tr>
              ${remainingRows}
            </table>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr><td align="center">
            <a href="${claimUrl}" style="display:inline-block;background:#c9a84c;color:#000;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:1px;padding:14px 36px;border-radius:4px;text-transform:uppercase">
              Access My Remaining Ticket${remainingCount > 1 ? 's' : ''} →
            </a>
          </td></tr>
        </table>` : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Ticket Sold — OC Tickets Live</title>
</head>
<body style="margin:0;padding:0;background:#0a0900;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0900;padding:32px 16px">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-radius:8px 8px 0 0;padding:24px 32px;text-align:center;border-bottom:1px solid #c9a84c40">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
          <div style="display:inline-block;background:#c9a84c;width:36px;height:36px;border-radius:50%;line-height:36px;text-align:center;font-size:18px;margin-bottom:10px">💰</div>
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f5f0e6;letter-spacing:4px;text-transform:uppercase">OC Tickets Live</div>
          <div style="font-size:11px;color:#8a7f5c;letter-spacing:1px;margin-top:4px;font-family:monospace">octicketslive.eth · Reserved Seating</div>
        </td></tr></table>
      </td>
    </tr>
    <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent)"></td></tr>
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-top:none;padding:32px">
        <p style="margin:0 0 24px;font-size:15px;color:#d4c88a;line-height:1.6">
          Hi ${sellerName},<br><br>
          Good news — your ticket sold.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:16px;border-bottom:1px solid #1e1c14">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Event</div>
            <div style="font-size:18px;font-weight:700;color:#f5f0e6;font-family:Georgia,serif">${eventName || 'Your Event'}</div>
          </td></tr>
          <tr><td style="padding:16px;border-bottom:1px solid #1e1c14">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Seat Sold</div>
            <div style="font-size:14px;color:#f5f0e6">${soldSeat || soldTicketId}</div>
          </td></tr>
          <tr><td style="padding:16px">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Sale Price</div>
            <div style="font-size:18px;font-weight:700;color:#c9a84c">${priceLine}</div>
          </td></tr>
        </table>
        ${payoutBlock}
        ${remainingBlock}
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0a;border:1px solid #1e1c14;border-radius:6px;margin-bottom:8px">
          <tr><td style="padding:14px 16px">
            <div style="font-size:11px;color:#6a6040;line-height:1.7;font-family:monospace">
              🔒 Your old claim link for this seat no longer works — ownership has transferred to the new holder.
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
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error: emailError } = await resend.emails.send({
        from:    'OC Tickets Live <tickets@octicketslive.com>',
        to:      email,
        subject: `Your Ticket Sold — ${eventName || 'Event'}`,
        html,
      });
      if (emailError) {
        console.error('send/sold: Resend error:', emailError);
        return res.status(500).json({ success: false, error: 'Email delivery failed', detail: emailError });
      }
      console.log(`send/sold: ✓ sent to ${email} — ticket ${soldTicketId}, ${remainingCount} remaining`);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('send/sold: unexpected error:', err);
      return res.status(500).json({ success: false, error: 'Unexpected error', detail: err.message });
    }
  }

  // ============================================================
  // TYPE: sms
  // ============================================================
  if (type === 'sms') {
    const SMS_ENABLED = process.env.SMS_ENABLED === 'true';
    if (!SMS_ENABLED) {
      console.log('send/sms: SMS_ENABLED is false — skipping');
      return res.status(200).json({ success: true, skipped: true });
    }

    const { phone, ticketId, eventName, seat, venueUrl } = req.body;
    if (!phone || !ticketId) return res.status(400).json({ error: 'Missing phone or ticketId' });

    try {
      const token     = uuidv4();
      const expiresAt = farFutureExpiry();

      const db = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const { error: dbError } = await db.from('claim_tokens').insert({
        id:         uuidv4(),
        token,
        ticket_id:  ticketId,
        phone,
        expires_at: expiresAt.toISOString(),
        claimed:    false,
      });
      if (dbError) return res.status(500).json({ error: 'Failed to save token' });

      const claimUrl = `${(venueUrl || 'https://octicketslive.eth.limo').replace(/\/+$/, '')}/#claim=${token}`;
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
  // ============================================================
  if (type === 'verify') {
    const { email, code, eventName, seats } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'email and code are required' });

    const resend   = new Resend(process.env.RESEND_API_KEY);
    const seatList = Array.isArray(seats) ? seats.join(', ') : (seats || 'Reserved Seat');

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
              This code expires in 10 minutes. If you did not request this, you can ignore this email.
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

  return res.status(400).json({ error: `Unknown type: ${type}. Must be email | sms | verify | sold` });
};
