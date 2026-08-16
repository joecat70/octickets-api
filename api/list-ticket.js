// api/list-ticket.js
//
// OCTL Live Demo — ownership-verification security fixes (v3, 2026-08-16)
//
// v3 FIX: gift-confirm's two post-write emails (recipient's ticket
// confirmation, giver's remaining-tickets notice) always fell back to the
// hub domain (octicketslive.eth.limo) instead of the actual venue, because
// this endpoint runs server-side and has no window.location to draw a URL
// from the way every client-side email call in this codebase does — and
// venueUrl was never added as a parameter here, so send.js's own fallback
// silently kicked in every time. Confirmed via live reproduction (Joe, Aug
// 16): both emails linked to the hub, ticket unreachable there; manually
// swapping the domain to the real venue while keeping the same claim token
// worked immediately — proving the token/data were always correct and only
// the link's domain was wrong. Fix: gift-confirm now accepts venueUrl from
// the client and passes it through to both emails, matching the pattern
// already used everywhere else. Client-side (live_demo_*.html) needs the
// matching change — giftStep()'s confirm call must send
// venueUrl: window.location.origin.
//
// OCTL Live Demo — ownership-verification security fixes (v2, 2026-08-15)
//
// v1 covered "List on Exchange" only (see the WHY/THE FIX notes further
// down — unchanged from v1). This revision extends the SAME pattern to two
// more actions found to have the identical class of bug during a full
// audit of everything reachable from an existing ticket:
//
//   - giftStep() sent its verification code to `currentBuyer.email` (the
//     browser SESSION's identity) instead of the ticket's actual current
//     owner — exact same bug as the original listing issue, just never
//     fixed here. The write itself was also a direct anon-key PATCH with
//     zero ownership check, and — separately — never rotated totp_seed on
//     transfer, unlike the paid resale path (transfer-ticket.js), meaning
//     a gifted-away ticket's QR kept working for the OLD owner indefinitely.
//   - cancelListing() had NO verification step of any kind, not even a
//     broken one — a direct anon-key write keyed on nothing but whatever
//     ticket happened to be showing client-side.
//
// Also fixes the deeper root cause those two bugs were riding on: gifting
// a ticket never assigned it a new tx_hash, so claim.js's "load every
// sibling sharing this tx_hash" logic kept finding a gifted-away ticket as
// a "sibling" of the giver's other tickets forever — which is why BOTH the
// giver's and the recipient's claim links ended up showing the entire
// original purchase batch, not just what each of them actually owned.
// transfer-ticket.js (paid resale) already assigns a fresh tx_hash on
// every transfer for exactly this reason; gift-confirm below now does the
// same thing, using the same 'gift:' + uuid shape.
//
// Five actions total now, POSTed to this one endpoint:
//   { action: 'request-code',      ticketIds }
//   { action: 'confirm-listing',   ticketIds, code, price, payoutMethod, payoutHandle }
//   { action: 'gift-request-code', ticketId, recipientEmail, recipientName }
//   { action: 'gift-confirm',      ticketId, code, venueUrl }
//   { action: 'cancel-request-code', ticketId }
//   { action: 'cancel-confirm',      ticketId, code }
//
// listing_verifications now has a `purpose` column ('list' | 'gift' |
// 'cancel') so a pending code for one action can never be invalidated or
// consumed by a request for a different action on the same ticket — see
// the migration. Gift rows also store recipient_email/recipient_name at
// request time; gift-confirm reads those back rather than trusting
// whatever the client resends, so a valid code can't be redirected to a
// different recipient than the one it was actually issued for.
//
// ── WHY THIS EXISTS (original v1 note, still accurate) ──────────────────
// The "List on Exchange" flow used to live entirely client-side in
// live_demo_*.html: sellStep() generated its own 6-digit code, sourced the
// send-to email from the browser session's `currentBuyer` object (or a
// stale local TICKETS[] lookup), and on confirm PATCHed `tickets` directly
// with the anon key — with no check anywhere that the requester still
// actually owned the ticket being listed. This endpoint re-derives actual
// current ownership from the database itself at every step, never from
// anything the client sends, and re-checks again at confirm time — not
// just at code-request time — closing the race window where ownership
// could change between the two steps. Uses the Supabase SERVICE ROLE key
// (server-side only), so this endpoint is the authority — the browser has
// no code path left that can write any of these three actions directly.
//
// ── DEPLOYMENT NOTES ────────────────────────────────────────────────────
// Env var names (SUPABASE_URL / SUPABASE_SERVICE_KEY) and CORS handling
// confirmed against this repo's actual transfer-ticket.js/refund-stripe.js
// in v1 — unchanged here, nothing new to verify on that front.
// generateTotpSeed() below is copied verbatim from transfer-ticket.js (same
// 20-random-bytes-hex-uppercase shape) rather than reimplemented, so gift
// and paid-resale transfers produce seeds the same way.
// ─────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches prior client-side UX
const VERCEL_API = 'https://octickets-api.vercel.app';

// Not a password — a short-lived, single-use 6-digit OTP. Plain SHA-256
// salted with the ticket-batch key is appropriate for this threat model:
// it stops a raw DB read from handing over a directly-usable code, which
// is the actual risk here (this table has no anon access at all regardless
// — see the migration — so this is defense in depth, not the primary gate).
function hashCode(code, ticketIdsKey) {
  return crypto.createHash('sha256').update(`${code}:${ticketIdsKey}`).digest('hex');
}

function batchKey(ticketIds) {
  return [...ticketIds].sort().join(',');
}

// Copied verbatim from transfer-ticket.js — same seed format used at
// original purchase time (stripe-webhook.js) and on paid resale. 20 random
// bytes, hex-encoded uppercase.
function generateTotpSeed() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Replicates live_demo_*.html's upsertBuyer() exactly: lookup by lowercased
// email, UPDATE-with-incremented-visit_count if found, INSERT with a fresh
// id if not. Kept in lockstep with that client function's semantics on
// purpose — this is the same "find or create" every other buyer-facing
// flow in this codebase already relies on.
async function upsertBuyer({ email, name, phone }) {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim();

  const { data: existing } = await supabase
    .from('buyers')
    .select('id, name, phone, visit_count')
    .eq('email', cleanEmail)
    .maybeSingle();

  const visitCount = existing ? (existing.visit_count || 0) + 1 : 1;
  const record = {
    email: cleanEmail,
    name: name || existing?.name || null,
    phone: phone || existing?.phone || null,
    visit_count: visitCount,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    await supabase.from('buyers').update(record).eq('id', existing.id);
    return { id: existing.id, ...record };
  }
  const newId = 'buyer-' + Date.now();
  await supabase.from('buyers').insert({ ...record, id: newId });
  return { id: newId, ...record };
}

// Fire-and-log, never fatal to the caller — matches the existing philosophy
// in this file (e.g. payout insert failures in confirm-listing) and in
// refund-stripe.js: once the primary action has already succeeded, a
// downstream notification failing shouldn't be reported as the whole
// action failing.
async function sendEmailSafe(payload) {
  try {
    const resp = await fetch(`${VERCEL_API}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!data.success) console.error('sendEmailSafe: send.js reported failure', payload.type, data.error);
    return data.success === true;
  } catch (e) {
    console.error('sendEmailSafe: send.js unreachable', payload.type, e.message);
    return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  try {
    if (action === 'request-code')        return await handleRequestCode(req, res);
    if (action === 'confirm-listing')     return await handleConfirmListing(req, res);
    if (action === 'gift-request-code')   return await handleGiftRequestCode(req, res);
    if (action === 'gift-confirm')        return await handleGiftConfirm(req, res);
    if (action === 'cancel-request-code') return await handleCancelRequestCode(req, res);
    if (action === 'cancel-confirm')      return await handleCancelConfirm(req, res);
    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('list-ticket error:', err);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
};

// ══════════════════════════════════════════════════════════════════════
// LISTING (unchanged from v1 except purpose:'list' added to every
// listing_verifications query, so gift/cancel codes on the same ticket
// can never collide with or invalidate a pending listing code)
// ══════════════════════════════════════════════════════════════════════

async function handleRequestCode(req, res) {
  const { ticketIds } = req.body || {};
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    return res.status(400).json({ success: false, error: 'No tickets specified.' });
  }

  const { data: tickets, error: fetchErr } = await supabase
    .from('tickets')
    .select('id, status, buyer_email, buyer_name, event_id, event_name, seat, price')
    .in('id', ticketIds);

  if (fetchErr) {
    console.error('request-code fetch error:', fetchErr.message);
    return res.status(500).json({ success: false, error: 'Could not look up tickets.' });
  }
  if (!tickets || tickets.length !== ticketIds.length) {
    return res.status(404).json({ success: false, error: 'One or more tickets could not be found.' });
  }

  const notValid = tickets.filter(t => t.status !== 'valid');
  if (notValid.length > 0) {
    return res.status(409).json({
      success: false,
      error: notValid.length === tickets.length
        ? 'These tickets are no longer available to list (already listed, sold, or transferred). Please refresh and try again.'
        : 'One of the selected tickets is no longer available to list. Please refresh and try again.',
    });
  }

  const distinctOwners = [...new Set(tickets.map(t => (t.buyer_email || '').toLowerCase()))];
  if (distinctOwners.length !== 1 || !distinctOwners[0]) {
    return res.status(409).json({
      success: false,
      error: 'These tickets do not all have the same current owner on file. Please list them separately.',
    });
  }

  const ownerEmail = tickets[0].buyer_email;
  const ownerName = tickets[0].buyer_name || 'Guest';
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const key = batchKey(ticketIds);

  const { error: invalidateErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('ticket_ids_key', key)
    .eq('purpose', 'list')
    .is('consumed_at', null);
  if (invalidateErr) {
    console.error('request-code invalidate-prior error:', invalidateErr.message);
  }

  const { error: insertErr } = await supabase.from('listing_verifications').insert({
    ticket_ids: ticketIds,
    ticket_ids_key: key,
    owner_email: ownerEmail,
    code_hash: hashCode(code, key),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    purpose: 'list',
  });
  if (insertErr) {
    console.error('request-code insert error:', insertErr.message);
    return res.status(500).json({ success: false, error: 'Could not start verification.' });
  }

  const seats = tickets.map(t => t.seat).filter(Boolean);
  const eventName = tickets[0].event_name || 'Event';

  const sent = await sendEmailSafe({ type: 'verify', email: ownerEmail, name: ownerName, code, eventName, seats });
  if (!sent) {
    return res.status(502).json({ success: false, error: 'Could not send verification email. Please try again.' });
  }

  return res.status(200).json({ success: true, email: ownerEmail });
}

async function handleConfirmListing(req, res) {
  const { ticketIds, code, price, payoutMethod, payoutHandle } = req.body || {};

  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    return res.status(400).json({ success: false, error: 'No tickets specified.' });
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: 'Verification code required.' });
  }
  const p = Number(price);
  if (!p || p <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid price.' });
  }
  if (!payoutMethod || !payoutHandle) {
    return res.status(400).json({ success: false, error: 'Payout method and handle required.' });
  }

  const key = batchKey(ticketIds);

  const { data: verifications, error: verErr } = await supabase
    .from('listing_verifications')
    .select('*')
    .eq('ticket_ids_key', key)
    .eq('purpose', 'list')
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (verErr) {
    console.error('confirm-listing lookup error:', verErr.message);
    return res.status(500).json({ success: false, error: 'Could not verify code.' });
  }
  const verification = verifications && verifications[0];
  if (!verification) {
    return res.status(400).json({ success: false, error: 'No pending verification for these tickets. Please request a new code.' });
  }
  if (new Date(verification.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ success: false, error: 'Verification code expired. Please request a new code.' });
  }
  if (hashCode(code, key) !== verification.code_hash) {
    return res.status(400).json({ success: false, error: 'Incorrect code. Check your email and try again.' });
  }

  const { data: tickets, error: fetchErr } = await supabase
    .from('tickets')
    .select('id, status, buyer_email, buyer_name, event_id, event_name, seat, seat_key, price')
    .in('id', ticketIds);

  if (fetchErr) {
    console.error('confirm-listing fetch error:', fetchErr.message);
    return res.status(500).json({ success: false, error: 'Could not look up tickets.' });
  }
  const notValid = tickets.filter(t => t.status !== 'valid');
  if (notValid.length > 0) {
    return res.status(409).json({ success: false, error: 'One or more of these tickets changed status since verification. Please start over.' });
  }
  const stillSameOwner = tickets.every(
    t => (t.buyer_email || '').toLowerCase() === verification.owner_email.toLowerCase()
  );
  if (!stillSameOwner) {
    return res.status(409).json({ success: false, error: 'Ticket ownership changed since verification. Please start over.' });
  }

  const { error: consumeErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', verification.id);
  if (consumeErr) {
    console.error('confirm-listing consume error:', consumeErr.message);
    return res.status(500).json({ success: false, error: 'Could not confirm listing. Please try again.' });
  }

  const listedTickets = [];
  for (const t of tickets) {
    const { data: updated, error: updateErr } = await supabase
      .from('tickets')
      .update({ status: 'listed', listed_price: p })
      .eq('id', t.id)
      .eq('status', 'valid')
      .select('id');

    if (updateErr || !updated || updated.length === 0) {
      console.error(`confirm-listing status update failed for ${t.id}:`, updateErr && updateErr.message);
      continue;
    }
    listedTickets.push({ id: t.id, listedPrice: p });

    const { error: payoutErr } = await supabase.from('payouts').insert({
      ticket_id: t.id,
      event_id: t.event_id,
      event_name: t.event_name,
      buyer_name: t.buyer_name || verification.owner_email,
      buyer_email: verification.owner_email,
      seat: t.seat,
      seat_key: t.seat_key,
      price: t.price,
      listed_price: p,
      payout_method: payoutMethod,
      payout_handle: payoutHandle,
      payout_status: 'pending',
    });
    if (payoutErr) {
      console.error(`confirm-listing payout insert failed for ${t.id}:`, payoutErr.message);
    }
  }

  if (listedTickets.length === 0) {
    return res.status(500).json({ success: false, error: 'Listing failed for all selected tickets. Please try again.' });
  }
  if (listedTickets.length < tickets.length) {
    return res.status(207).json({
      success: true,
      partial: true,
      listedTickets,
      error: `${tickets.length - listedTickets.length} of ${tickets.length} tickets could not be listed. Please check My Tickets.`,
    });
  }

  return res.status(200).json({ success: true, listedTickets });
}

// ══════════════════════════════════════════════════════════════════════
// GIFT
// ══════════════════════════════════════════════════════════════════════

async function handleGiftRequestCode(req, res) {
  const { ticketId, recipientEmail, recipientName } = req.body || {};
  if (!ticketId) return res.status(400).json({ success: false, error: 'No ticket specified.' });
  if (!recipientEmail || !/^[^@]+@[^@]+\.[^@]+$/.test(recipientEmail)) {
    return res.status(400).json({ success: false, error: 'Valid recipient email required.' });
  }
  if (!recipientName) return res.status(400).json({ success: false, error: 'Recipient name required.' });

  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('id, status, buyer_email, buyer_name, event_id, event_name, seat')
    .eq('id', ticketId)
    .single();

  if (fetchErr || !ticket) return res.status(404).json({ success: false, error: 'Ticket not found.' });
  if (ticket.status !== 'valid') {
    return res.status(409).json({ success: false, error: 'This ticket is not currently eligible to be gifted.' });
  }
  if (!ticket.buyer_email) {
    return res.status(409).json({ success: false, error: 'No email on file for this ticket. Cannot send verification code.' });
  }

  // Same-event duplicate warning — non-blocking, mirrors the ALL-CAPS
  // warning the client used to show before code-generation. Sent back to
  // the client so it can decide whether to still let the sender proceed.
  let warning = null;
  const { data: existing } = await supabase
    .from('tickets')
    .select('id')
    .eq('buyer_email', recipientEmail.toLowerCase())
    .eq('event_id', ticket.event_id)
    .not('status', 'in', '(refunded,cancelled,transferred)')
    .limit(1);
  if (existing && existing.length > 0) {
    warning = 'This recipient already has a ticket to this event. Gifting will result in two tickets for the same seat holder.';
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const key = batchKey([ticketId]);

  const { error: invalidateErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('ticket_ids_key', key)
    .eq('purpose', 'gift')
    .is('consumed_at', null);
  if (invalidateErr) console.error('gift-request-code invalidate-prior error:', invalidateErr.message);

  const { error: insertErr } = await supabase.from('listing_verifications').insert({
    ticket_ids: [ticketId],
    ticket_ids_key: key,
    owner_email: ticket.buyer_email,
    code_hash: hashCode(code, key),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    purpose: 'gift',
    recipient_email: recipientEmail,
    recipient_name: recipientName,
  });
  if (insertErr) {
    console.error('gift-request-code insert error:', insertErr.message);
    return res.status(500).json({ success: false, error: 'Could not start verification.' });
  }

  const sent = await sendEmailSafe({
    type: 'verify', email: ticket.buyer_email, name: ticket.buyer_name || 'Guest',
    code, eventName: ticket.event_name || 'Event', seats: [ticket.seat].filter(Boolean),
  });
  if (!sent) {
    return res.status(502).json({ success: false, error: 'Could not send verification email. Please try again.' });
  }

  return res.status(200).json({ success: true, email: ticket.buyer_email, warning });
}

async function handleGiftConfirm(req, res) {
  const { ticketId, code, venueUrl } = req.body || {};
  if (!ticketId) return res.status(400).json({ success: false, error: 'No ticket specified.' });
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: 'Verification code required.' });
  }

  const key = batchKey([ticketId]);

  const { data: verifications, error: verErr } = await supabase
    .from('listing_verifications')
    .select('*')
    .eq('ticket_ids_key', key)
    .eq('purpose', 'gift')
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (verErr) return res.status(500).json({ success: false, error: 'Could not verify code.' });
  const verification = verifications && verifications[0];
  if (!verification) {
    return res.status(400).json({ success: false, error: 'No pending gift verification for this ticket. Please start over.' });
  }
  if (new Date(verification.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ success: false, error: 'Verification code expired. Please start over.' });
  }
  if (hashCode(code, key) !== verification.code_hash) {
    return res.status(400).json({ success: false, error: 'Incorrect code. Check your email and try again.' });
  }

  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('id, status, buyer_email, buyer_name, event_id, event_name, seat, seat_key, tx_hash')
    .eq('id', ticketId)
    .single();

  if (fetchErr || !ticket) return res.status(404).json({ success: false, error: 'Ticket not found.' });
  if (ticket.status !== 'valid') {
    return res.status(409).json({ success: false, error: 'This ticket changed status since verification. Please start over.' });
  }
  if ((ticket.buyer_email || '').toLowerCase() !== verification.owner_email.toLowerCase()) {
    return res.status(409).json({ success: false, error: 'Ticket ownership changed since verification. Please start over.' });
  }

  // Consume before writing — matches the listing flow's replay protection.
  const { error: consumeErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', verification.id);
  if (consumeErr) {
    console.error('gift-confirm consume error:', consumeErr.message);
    return res.status(500).json({ success: false, error: 'Could not confirm gift. Please try again.' });
  }

  const oldTxHash = ticket.tx_hash;
  const oldOwnerEmail = ticket.buyer_email;
  const oldOwnerName = ticket.buyer_name;
  const recipientEmail = verification.recipient_email;

  const recipientProfile = await upsertBuyer({ email: recipientEmail, name: verification.recipient_name });
  const recipientName = verification.recipient_name
    || recipientProfile?.name
    || recipientEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const newTxHash = 'gift:' + uuidv4();
  const newTotpSeed = generateTotpSeed();

  // Atomic guard: only writes if this ticket is STILL 'valid' AND still
  // owned by the email the code was actually issued to, at the exact
  // moment of this write — not just at the checks a few lines up.
  const { data: updated, error: updateErr } = await supabase
    .from('tickets')
    .update({
      buyer_email: recipientEmail,
      buyer_name: recipientName,
      buyer_id: recipientProfile?.id || null,
      status: 'valid',
      tx_hash: newTxHash,
      totp_seed: newTotpSeed,
    })
    .eq('id', ticketId)
    .eq('status', 'valid')
    .eq('buyer_email', oldOwnerEmail)
    .select()
    .single();

  if (updateErr || !updated) {
    return res.status(409).json({
      success: false,
      error: 'Could not complete this gift — the ticket changed before confirmation completed.',
    });
  }

  // Expire the giver's old claim link for THIS ticket specifically — same
  // fix transfer-ticket.js already applies on paid resale, ported here.
  const { error: expireErr } = await supabase
    .from('claim_tokens')
    .update({ expires_at: new Date(0).toISOString() })
    .eq('ticket_id', ticketId);
  if (expireErr) {
    console.warn('gift-confirm: failed to expire old claim_tokens for', ticketId, expireErr.message);
  }

  // Recipient's ticket confirmation — single ticket, brand-new tx_hash, so
  // claim.js's sibling lookup will correctly find nothing else alongside it.
  await sendEmailSafe({
    type: 'email',
    email: recipientEmail,
    name: recipientName,
    ticketId: updated.id,
    ticketIds: [updated.id],
    seat: updated.seat,
    seats: [updated.seat],
    seatCount: 1,
    eventName: updated.event_name,
    venueUrl,
  });

  // Giver's remaining tickets — found by the OLD tx_hash (captured before
  // we overwrote it above), excluding the one just gifted. Anything that
  // comes back here still legitimately belongs to the giver; anything
  // gifted away earlier already has its own different tx_hash by now and
  // correctly won't appear.
  const { data: remaining } = await supabase
    .from('tickets')
    .select('id, seat')
    .eq('tx_hash', oldTxHash)
    .neq('id', ticketId);

  let remainingEmailSent = false;
  if (remaining && remaining.length > 0) {
    remainingEmailSent = await sendEmailSafe({
      type: 'email',
      email: oldOwnerEmail,
      name: oldOwnerName || 'Guest',
      ticketId: remaining[0].id,
      ticketIds: remaining.map(r => r.id),
      seats: remaining.map(r => r.seat),
      seatCount: remaining.length,
      venueUrl,
      // eventName intentionally omitted — send.js resolves it server-side
      // from the primary ticket if not given a good one.
    });
  }

  return res.status(200).json({
    success: true,
    ticket: updated,
    remainingCount: remaining ? remaining.length : 0,
    remainingEmailSent,
  });
}

// ══════════════════════════════════════════════════════════════════════
// CANCEL LISTING
// ══════════════════════════════════════════════════════════════════════

async function handleCancelRequestCode(req, res) {
  const { ticketId } = req.body || {};
  if (!ticketId) return res.status(400).json({ success: false, error: 'No ticket specified.' });

  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('id, status, buyer_email, buyer_name, event_id, event_name, seat')
    .eq('id', ticketId)
    .single();

  if (fetchErr || !ticket) return res.status(404).json({ success: false, error: 'Ticket not found.' });
  if (ticket.status !== 'listed') {
    return res.status(409).json({ success: false, error: 'This ticket is not currently listed.' });
  }
  if (!ticket.buyer_email) {
    return res.status(409).json({ success: false, error: 'No email on file for this ticket. Cannot send verification code.' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const key = batchKey([ticketId]);

  const { error: invalidateErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('ticket_ids_key', key)
    .eq('purpose', 'cancel')
    .is('consumed_at', null);
  if (invalidateErr) console.error('cancel-request-code invalidate-prior error:', invalidateErr.message);

  const { error: insertErr } = await supabase.from('listing_verifications').insert({
    ticket_ids: [ticketId],
    ticket_ids_key: key,
    owner_email: ticket.buyer_email,
    code_hash: hashCode(code, key),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    purpose: 'cancel',
  });
  if (insertErr) {
    console.error('cancel-request-code insert error:', insertErr.message);
    return res.status(500).json({ success: false, error: 'Could not start verification.' });
  }

  const sent = await sendEmailSafe({
    type: 'verify', email: ticket.buyer_email, name: ticket.buyer_name || 'Guest',
    code, eventName: ticket.event_name || 'Event', seats: [ticket.seat].filter(Boolean),
  });
  if (!sent) {
    return res.status(502).json({ success: false, error: 'Could not send verification email. Please try again.' });
  }

  return res.status(200).json({ success: true, email: ticket.buyer_email });
}

async function handleCancelConfirm(req, res) {
  const { ticketId, code } = req.body || {};
  if (!ticketId) return res.status(400).json({ success: false, error: 'No ticket specified.' });
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: 'Verification code required.' });
  }

  const key = batchKey([ticketId]);

  const { data: verifications, error: verErr } = await supabase
    .from('listing_verifications')
    .select('*')
    .eq('ticket_ids_key', key)
    .eq('purpose', 'cancel')
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (verErr) return res.status(500).json({ success: false, error: 'Could not verify code.' });
  const verification = verifications && verifications[0];
  if (!verification) {
    return res.status(400).json({ success: false, error: 'No pending cancellation verification for this ticket. Please start over.' });
  }
  if (new Date(verification.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ success: false, error: 'Verification code expired. Please start over.' });
  }
  if (hashCode(code, key) !== verification.code_hash) {
    return res.status(400).json({ success: false, error: 'Incorrect code. Check your email and try again.' });
  }

  const { data: ticket, error: fetchErr } = await supabase
    .from('tickets')
    .select('id, status, buyer_email')
    .eq('id', ticketId)
    .single();

  if (fetchErr || !ticket) return res.status(404).json({ success: false, error: 'Ticket not found.' });
  if (ticket.status !== 'listed') {
    return res.status(409).json({ success: false, error: 'This ticket is no longer listed.' });
  }
  if ((ticket.buyer_email || '').toLowerCase() !== verification.owner_email.toLowerCase()) {
    return res.status(409).json({ success: false, error: 'Ticket ownership changed since verification. Please start over.' });
  }

  const { error: consumeErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', verification.id);
  if (consumeErr) {
    console.error('cancel-confirm consume error:', consumeErr.message);
    return res.status(500).json({ success: false, error: 'Could not confirm cancellation. Please try again.' });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('tickets')
    .update({
      status: 'valid',
      listed_price: null,
      payout_method: null,
      payout_handle: null,
      payout_status: null,
    })
    .eq('id', ticketId)
    .eq('status', 'listed')
    .eq('buyer_email', ticket.buyer_email)
    .select()
    .single();

  if (updateErr || !updated) {
    return res.status(409).json({
      success: false,
      error: 'Could not cancel this listing — its status changed before confirmation completed.',
    });
  }

  return res.status(200).json({ success: true, ticket: updated });
}
