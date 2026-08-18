// api/resend-tickets.js
//
// v-next (Aug 2026) — SELF-SERVE SEARCH REBUILD: the buyer-facing "My
// Tickets" search on a fresh session was originally just an email box —
// looked up every valid ticket that email had for any upcoming (or recently
// past) event at this venue and mailed all of it. Rebuilt per Joe's spec:
//   1. EVENT-SCOPED: the client now sends a required `eventId` (populated
//      from an upcoming-events dropdown). The self-serve branch verifies
//      that event actually belongs to `venueId` AND hasn't passed yet
//      before using it to scope every ticket query — same reasoning as the
//      existing venueId-required fix below: a tampered eventId must not be
//      able to pull tickets from another venue's event, or a past one. This
//      replaces the old "all upcoming events + 30-day post-show window"
//      scope entirely — that existed to compensate for not having a single
//      event to scope to; now that a specific event is always selected,
//      it's no longer needed.
//   2. EMAIL *OR* PHONE: added a phone lookup path, mirroring the existing
//      email path exactly (direct tickets.buyer_phone match, falling back
//      to buyers.phone → buyer_id). Phone search doesn't know the
//      destination email up front the way email search does — it's
//      resolved from whichever record matches (the ticket's own
//      buyer_email if present, else the buyers row's email). If a phone
//      matches a buyer/ticket but no email is on file anywhere to send
//      results to, that's treated as its own outcome (see below) rather
//      than silently failing.
//   3. EXPLICIT FOUND/NOT-FOUND MESSAGING: every response now carries a
//      `message` string meant to be shown to the searcher directly, not
//      just used internally. Previously the buyer-facing UI showed a
//      deliberately vague "if tickets exist you'll receive them shortly"
//      regardless of outcome — but the email side was never actually
//      vague: sendNotFoundEmail() already told the searcher definitively
//      that nothing was found. Making the on-screen message explicit just
//      matches what the searcher was already being told by email; it
//      doesn't newly expose anything.
//   4. sendNotFoundEmail() now includes a contact-support line — it didn't
//      have one before, and Joe's spec calls for a support path when a
//      legitimate searcher can't be found.
// NOTE: original filename unconfirmed — rename to match the actual repo file.
//
// v-next FIX (Aug 2026): the "View Ticket" button used
// background: linear-gradient(135deg,#d4af37,#f0c842) with color:#000000.
// Several email clients (confirmed: at least one dark-mode / Gmail-app-style
// renderer) drop unsupported `background: linear-gradient(...)` on <a> tags
// silently rather than falling back to any solid color — leaving black text
// sitting directly on the email body's #0a0a0f background, invisible. Fixed
// by using a solid background-color instead of a gradient. Gradients on
// interactive email elements are unreliable enough across clients that this
// is the standard "bulletproof button" practice for transactional email —
// not worth the visual flourish given the failure mode is buyers unable to
// find their tickets at all.
//
// Three fixes now applied total, two from before:
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

  const { email, venueUrl, venueId, ticketIds, overrideEmail, buyerName, phone, isManagerResend, eventId } = req.body;

  const base = (venueUrl || 'https://theetestsite.eth.limo').replace(/\/+$/, '');

  try {
    let tickets = [];
    // Resolved per-branch below: manager resend and email search know this
    // immediately; phone search resolves it from whichever record matches.
    let sendToEmail = '';

    // ── MANAGER RESEND: specific ticket IDs + optional corrections ──────────
    if (isManagerResend && ticketIds && ticketIds.length) {
      sendToEmail = (overrideEmail || email || '').trim().toLowerCase();
      if (!sendToEmail) return res.status(400).json({ error: 'Missing email' });

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

    // ── BUYER SELF-SERVE: look up by email or phone, scoped to one event ────
    } else {
      // venueId REQUIRED — a missing venueId must fail loudly rather than
      // silently falling back to an unscoped global lookup (this is the
      // original cross-venue leak this branch was first hardened against).
      if (!venueId) {
        return res.status(400).json({ error: 'venueId is required for self-serve ticket lookup' });
      }
      // eventId REQUIRED — the client's event dropdown always sends one now;
      // see the v-next block at the top of this file for why the old
      // "all upcoming + 30-day window" scope was replaced with this.
      if (!eventId) {
        return res.status(400).json({ error: 'eventId is required for self-serve ticket lookup' });
      }
      const searchEmail = (email || '').trim().toLowerCase();
      const searchPhone = (phone || '').trim();
      if (!searchEmail && !searchPhone) {
        return res.status(400).json({ error: 'Provide an email or phone number to search' });
      }

      // Verify eventId actually belongs to this venue AND hasn't passed yet —
      // do not trust the client-sent eventId blindly. Mirrors the venueId
      // fix above: a tampered eventId must not pull tickets from another
      // venue's event, or from a past one the dropdown was never supposed
      // to offer. "today" computed in UTC to match how events.date is
      // written and compared client-side (same convention as the rest of
      // this file).
      const todayISO = new Date().toISOString().slice(0, 10);
      const evCheckRes = await fetch(
        `${supabaseUrl}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}&venue_id=eq.${encodeURIComponent(venueId)}&date=gte.${todayISO}&select=id`,
        { headers }
      );
      const evCheckRows = await evCheckRes.json() || [];
      if (!evCheckRows.length) {
        return res.status(400).json({ error: 'Event not found for this venue, or it has already passed' });
      }
      const eventScope = `&event_id=eq.${encodeURIComponent(eventId)}`;
      const TICKET_FIELDS = 'id,seat,event_id,event_name,tier_name,price,payment,status';

      if (searchEmail) {
        sendToEmail = searchEmail;

        // First try buyer_email column directly on tickets (new purchases)
        const directRes = await fetch(
          `${supabaseUrl}/rest/v1/tickets?buyer_email=eq.${encodeURIComponent(searchEmail)}&status=eq.valid${eventScope}&select=${TICKET_FIELDS}`,
          { headers }
        );
        tickets = await directRes.json() || [];

        // Fall back to buyers table → buyer_id lookup (legacy purchases)
        if (!tickets.length) {
          const buyerRes = await fetch(
            `${supabaseUrl}/rest/v1/buyers?email=eq.${encodeURIComponent(searchEmail)}&select=id`,
            { headers }
          );
          const buyers = await buyerRes.json() || [];
          if (buyers.length) {
            const buyerIds = buyers.map(b => `"${b.id}"`).join(',');
            const ticketsRes = await fetch(
              `${supabaseUrl}/rest/v1/tickets?buyer_id=in.(${buyerIds})&status=eq.valid${eventScope}&select=${TICKET_FIELDS}`,
              { headers }
            );
            tickets = await ticketsRes.json() || [];
          }
        }
      } else {
        // Phone search — mirrors the email path exactly, but the destination
        // email isn't known up front. Resolve it from whichever record
        // matches: the ticket's own buyer_email first, else the buyers row.
        const directRes = await fetch(
          `${supabaseUrl}/rest/v1/tickets?buyer_phone=eq.${encodeURIComponent(searchPhone)}&status=eq.valid${eventScope}&select=${TICKET_FIELDS},buyer_email`,
          { headers }
        );
        const directRows = await directRes.json() || [];
        if (directRows.length) {
          sendToEmail = (directRows.find(t => t.buyer_email)?.buyer_email || '').toLowerCase();
          tickets = directRows.map(({ buyer_email, ...t }) => t);
        } else {
          const buyerRes = await fetch(
            `${supabaseUrl}/rest/v1/buyers?phone=eq.${encodeURIComponent(searchPhone)}&select=id,email`,
            { headers }
          );
          const buyers = await buyerRes.json() || [];
          if (buyers.length) {
            sendToEmail = (buyers.find(b => b.email)?.email || '').toLowerCase();
            const buyerIds = buyers.map(b => `"${b.id}"`).join(',');
            const ticketsRes = await fetch(
              `${supabaseUrl}/rest/v1/tickets?buyer_id=in.(${buyerIds})&status=eq.valid${eventScope}&select=${TICKET_FIELDS}`,
              { headers }
            );
            tickets = await ticketsRes.json() || [];
          }
        }
        if (tickets.length && !sendToEmail) {
          // Matched a phone number (and found valid tickets for this event)
          // but there's no email on file anywhere to send results to. Can't
          // fulfill "email sent with the tickets" without one — this is a
          // distinct outcome from "not found", so it gets its own message
          // rather than silently falling through to the not-found email
          // (which would have nowhere to send to either).
          return res.status(200).json({
            success: true,
            ticketsFound: 0,
            message: 'Found a match, but no email is on file for this phone number — contact support to get your tickets.',
          });
        }
      }
    }

    // ── No tickets found ─────────────────────────────────────────────────────
    if (!tickets.length) {
      if (!isManagerResend && sendToEmail) await sendNotFoundEmail(sendToEmail);
      return res.status(200).json({
        success: true,
        ticketsFound: 0,
        message: isManagerResend
          ? 'Buyer info updated but no valid tickets found to send.'
          : 'No tickets found for that event with this email or phone number — contact support if you believe this is wrong.',
      });
    }

    // ── Generate claim tokens and send email ─────────────────────────────────
    // v-next FIX (Joe, Aug 2026): 7-day expiration removed on purpose — traced
    // back to the original May build, where it was a default picked once and
    // never revisited, not a deliberate security decision. Using an
    // effectively-permanent date rather than null: claim.js's expiry check is
    // a plain `new Date(expires_at) < new Date()` comparison, and a null
    // would evaluate to epoch (1970) — immediately "expired" — unless that
    // check were also rewritten to special-case null. A far-future date needs
    // no changes anywhere else that reads expires_at.
    const NO_EXPIRY_YEARS = 100;
    const expires = new Date(Date.now() + NO_EXPIRY_YEARS * 365 * 24 * 60 * 60 * 1000).toISOString();
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
        <a href="${t.claimUrl}" style="display:block;background-color:#d4af37;color:#000000;text-decoration:none;text-align:center;padding:13px 24px;border-radius:6px;font-weight:700;font-size:14px;">
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
              First tap activates your rotating QR code.
            </div>
          </div>
          <div style="text-align:center;"><div style="font-size:11px;color:#555570;">OC Tickets Live · Powered by Ethereum</div></div>
        </div></body></html>`
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send email', detail: error.message });
    }

    return res.status(200).json({
      success: true,
      ticketsFound: ticketLinks.length,
      emailId: data.id,
      message: isManagerResend
        ? `${ticketLinks.length} ticket${ticketLinks.length > 1 ? 's' : ''} resent.`
        : `Found ${ticketLinks.length} ticket${ticketLinks.length > 1 ? 's' : ''} — check your email!`,
    });

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
            <div style="font-size:14px;color:#9090b0;line-height:1.6;">We couldn't find any active tickets for this email address for that event.<br><br>If you used a different email at checkout, please try the search again with that address. Still no luck? <a href="mailto:support@octicketslive.com" style="color:#d4af37;">Contact support</a> and we'll help track it down.</div>
          </div>
          <div style="text-align:center;margin-top:24px;"><div style="font-size:11px;color:#555570;">OC Tickets Live · Powered by Ethereum</div></div>
        </div></body></html>`
    });
  } catch(e) { console.warn('Could not send not-found email:', e.message); }
}
