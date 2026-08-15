// api/list-ticket.js
//
// OCTL Live Demo — listing-ownership security fix (v1, 2026-08-15)
//
// WHY THIS EXISTS:
// The "List on Exchange" flow used to live entirely client-side in
// live_demo_*.html: sellStep() generated its own 6-digit code, sourced the
// send-to email from the browser session's `currentBuyer` object (or a
// stale local TICKETS[] lookup), and on confirm PATCHed `tickets` directly
// with the anon key — with no check anywhere that the requester still
// actually owned the ticket being listed.
//
// Confirmed via live reproduction on 2026-08-14: gift a ticket away, then
// — without refreshing — open "List on Exchange" on that same ticket from
// the FORMER owner's still-open session. The verification code went to the
// former owner (not the ticket's real current owner), and confirming the
// code actually flipped status to 'listed' and created a payout record.
// A separate buyer then successfully purchased the improperly-listed
// ticket, silently displacing whoever the ticket had actually been gifted
// to — who was never notified and received nothing.
//
// THE FIX:
// This endpoint is now the ONLY thing allowed to move a ticket to
// status='listed' or write to `payouts` for a listing, for Live Demo. It
// re-derives each ticket's actual current owner from the database itself
// at BOTH steps (never from anything the client sends), and re-checks
// ownership/status again at confirm time — not just at code-request time —
// which also closes the race window where ownership could change in
// between the two steps.
//
// Uses the Supabase SERVICE ROLE key (server-side only, never exposed to
// the client), so this endpoint is the authority — the browser no longer
// has a code path that can write a listing at all.
//
// ── DEPLOYMENT NOTES ────────────────────────────────────────────────────
// Env var names (SUPABASE_URL / SUPABASE_SERVICE_KEY) confirmed against
// this repo's actual transfer-ticket.js and refund-stripe.js — both agree
// on this exact pair, now matched here. No shared db-client helper exists
// in either reference file (both instantiate createClient() inline, same
// as this file does) — nothing to reconcile there. CORS/OPTIONS handling
// was missing entirely in an earlier draft of this file (the two reference
// files handle it in slightly different styles from each other); added
// here matching transfer-ticket.js's simpler res.setHeader approach, since
// without it this endpoint could not be called from the browser at all.
// Still worth a glance before deploy: neither reference file gave a strong
// signal either way on rate limiting or logging conventions beyond what's
// already here.
// ─────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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
    if (action === 'request-code') {
      return await handleRequestCode(req, res);
    }
    if (action === 'confirm-listing') {
      return await handleConfirmListing(req, res);
    }
    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('list-ticket error:', err);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
};

async function handleRequestCode(req, res) {
  const { ticketIds } = req.body || {};
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    return res.status(400).json({ success: false, error: 'No tickets specified.' });
  }

  // Fresh, authoritative read. Never trust anything the client claims
  // about who owns these tickets.
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

  // Invalidate any earlier unconsumed codes for this exact ticket batch
  // before issuing a new one, so only the most recently sent code is ever
  // valid (prevents an old, still-unexpired code from a prior attempt
  // being usable alongside a fresh one).
  const { error: invalidateErr } = await supabase
    .from('listing_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('ticket_ids_key', key)
    .is('consumed_at', null);
  if (invalidateErr) {
    console.error('request-code invalidate-prior error:', invalidateErr.message);
    // Not fatal — proceed; the new row below still becomes the most recent
    // and confirm-listing always orders by created_at desc.
  }

  const { error: insertErr } = await supabase.from('listing_verifications').insert({
    ticket_ids: ticketIds,
    ticket_ids_key: key,
    owner_email: ownerEmail,
    code_hash: hashCode(code, key),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (insertErr) {
    console.error('request-code insert error:', insertErr.message);
    return res.status(500).json({ success: false, error: 'Could not start verification.' });
  }

  const seats = tickets.map(t => t.seat).filter(Boolean);
  const eventName = tickets[0].event_name || 'Event';

  const sendResp = await fetch(`${VERCEL_API}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'verify', email: ownerEmail, name: ownerName, code, eventName, seats }),
  })
    .then(r => r.json())
    .catch(e => ({ success: false, error: e.message }));

  if (!sendResp.success) {
    console.error('request-code email send failed:', sendResp.error);
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

  // Re-check ownership/status RIGHT NOW, not just at request-code time —
  // this is what closes the race window between the two steps, e.g. the
  // ticket getting gifted or sold again in between a code being issued
  // and someone (correctly or not) submitting it.
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

  // Mark the code consumed FIRST, before writing anything, so a
  // double-click or retry can't reuse it to list the batch twice.
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
    // Atomic guard: only writes if status is STILL 'valid' at the moment
    // of this specific write, not just at the check above a few lines up.
    const { data: updated, error: updateErr } = await supabase
      .from('tickets')
      .update({ status: 'listed', listed_price: p })
      .eq('id', t.id)
      .eq('status', 'valid')
      .select('id');

    if (updateErr || !updated || updated.length === 0) {
      console.error(`confirm-listing status update failed for ${t.id}:`, updateErr && updateErr.message);
      continue; // reported to the client below via the partial-success path
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
