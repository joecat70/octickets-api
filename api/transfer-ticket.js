// api/transfer-ticket.js
// Confirmed filename — client call found at club_chaotic_v2_11.html line ~4575.
//
// FIX (Aug 2026, Joe): combined "your ticket sold" + "here are your
// remaining tickets" seller notification. Neither existed before — this
// endpoint wrote the new owner's data, rotated the QR, and expired the old
// claim link, then stopped. The seller got nothing: no confirmation a sale
// even happened, no way back into their other tickets. Confirmed via live
// test (Joe, Aug 16): sold a ticket, tried to cancel the (already-sold)
// listing — correctly rejected — but received no email at all.
//
// CORRECTION (Aug 2026, Joe): the first version of this change deliberately
// left the net payout dollar amount OUT of the email — that was a judgment
// call made unilaterally, not something Joe asked for, and he corrected it:
// knowing the actual payout is basic transparency, not optional, and it
// needs to be ACCURATE, not a guess. The concern behind the original
// decision was real (this file had no access to the royalty calculation and
// guessing risked a wrong number in a financial email) but the fix was
// wrong — the right move was to go find the actual authoritative formula,
// not omit the information. That formula turned out to be simple and
// already verified: updateSellCalc() in the listing modal computes a flat
// total*0.1 royalty / total*0.9 seller-payout split — the exact number a
// seller already sees and agrees to when listing. Replicated verbatim
// below. Separately worth knowing: that formula is hardcoded to 10%, not
// read from the event's own configurable royalty_percent column — same bug
// shape as the Tier 3 pricing issue, not yet confirmed to have actually
// caused a wrong number anywhere, logged as its own item.
//
// Unlike the equivalent gift-side email (list-ticket.js's gift-confirm),
// this one is NOT skipped when zero tickets remain. A gift-giver already
// gets real-time on-screen confirmation the moment the transfer completes;
// a seller who lists a ticket and walks away has no signal whatsoever that
// it sold except this email, so it always fires. When tickets do remain,
// the same email folds in a working link to them — one send, not two, per
// Joe's explicit request rather than porting the gift email's two-message
// shape over unchanged.
//
// Requires api/send.js's new `type: 'sold'` branch (added alongside this
// change) — that's where the actual template/claim-token logic lives, same
// division of responsibility as every other email in this codebase.
//
// Now also reads payout_method/payout_handle from the payouts row this
// ticket's listing already created (list-ticket.js's confirm-listing), so
// the email can tell the seller how they're being paid — not just that a
// sale happened. Non-fatal if that lookup finds nothing; the email still
// sends without the payout line.
//
// Companion client-side fix required: the venueUrl this endpoint now reads
// from req.body was never being sent — see live_demo_v8.html's call site.
// Same class of bug as v7.5.31's gift-email fix (server has no
// window.location of its own; must be told).
//
// Four fixes applied to the original logic (unchanged from before):
//   1. buyer_email/buyer_name/buyer_phone are now actually written on resale
//   2. totp_seed is rotated on every resale, invalidating the old QR
//   3. the previous owner's claim_tokens are expired immediately on transfer
//   4. resale_price is now recorded (Aug 2026, Joe) — a NEW column, separate
//      from price. price is left untouched deliberately: it still means
//      "original sale amount" everywhere else that reads it, most notably
//      renderVenueOverview()'s "Primary Revenue" admin metric, which would
//      silently start mixing resale dollars into a primary-sales-only figure
//      if price were overwritten here instead. resale_price sourced from
//      session.amount_total — the CONFIRMED Stripe charge, in cents, divided
//      to dollars — not from listed_price (what the seller typed in before
//      payment), since the confirmed charge is the one actually true.
//      Requires: ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resale_price
//      numeric; (run directly in Supabase SQL editor — not applied by this
//      file). Prerequisite for a future receipt feature (Joe, Aug 2026: a
//      resold ticket's receipt should show what the current holder actually
//      paid, not the original purchase price) — this revision only makes
//      that number available to read; it does not build the receipt itself.
//      NOTE: this endpoint requires a paid Stripe session and can only ever
//      be the resale-completion path — gifts/free transfers (giftStep() in
//      the venue files) go through a different, not-yet-built mechanism and
//      are unaffected by this change.
//
// Without the first three fixes, the original seller retained a fully working
// claim link + valid rotating QR code after reselling a ticket — meaning two
// people could use the same ticket to enter. Confirmed via cross-reference
// with claim.js (re-access is explicitly allowed and never re-checks identity)
// and validate-ticket.js (trusts totp_seed alone, no ownership check).
// Companion fix: club_chaotic_v2_11.html's call to this endpoint was computing
// buyerPhone locally but never including it in the request body — fixed there too.
// NOTE (Aug 2026): live_demo_*.html's call site has this SAME buyerPhone gap,
// confirmed while making the change above — not fixed here, logged separately,
// out of scope for this specific change. UPDATE: fixed in live_demo v8.3, on
// both its card and crypto/wallet resale paths.
//
// FIX (Aug 2026): royaltyAmount/netPayout below no longer hardcode 10% — now
// read the specific event's own royalty_percent column, matching the same
// fix just applied to updateSellCalc() in the listing modal (live_demo
// v8.4). These two were explicitly coupled per this file's own note above;
// this closes that gap. royaltyPercent is now also passed through to
// send.js's payload so the email template can eventually show the real
// percentage — send.js itself still hardcodes literal "(10%)" text in its
// copy and has NOT been updated to use this new field yet. Until it is, the
// dollar amounts in the sold-notification email will be correct for any
// event's actual rate, but the percentage printed alongside them will still
// read "(10%)" regardless of what that rate actually is. Logged, not fixed
// here — separate file.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VERCEL_API = 'https://octickets-api.vercel.app';

// Same seed format used in stripe-webhook.js — 20 random bytes, hex-encoded uppercase.
function generateTotpSeed() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Fire-and-log, never fatal — the transfer itself has already succeeded by
// the time this runs. Same philosophy as every other post-write email call
// in this codebase (list-ticket.js's payout inserts, gift-confirm's emails).
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // FIX 1: buyerPhone is now an accepted param — required for ZeroScalp's
  // phone-match identity model to work correctly for the NEW owner.
  const { ticketId, sessionId, buyerEmail, buyerName, buyerPhone, payment, venueUrl } = req.body;
  if (!ticketId || !sessionId) return res.status(400).json({ error: 'Missing ticketId or sessionId' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['customer_details'] });
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not confirmed' });
    }

    const txHash = 'stripe:' + sessionId;

    // Capture the SELLER's info before it gets overwritten below — this is
    // the piece that was missing entirely before this change. Without this
    // read, there's no way to know who to notify or which of their other
    // tickets (by old tx_hash) still legitimately belong to them.
    const { data: preTransfer, error: preFetchErr } = await supabase
      .from('tickets')
      .select('buyer_email, buyer_name, tx_hash, seat, event_name, event_id')
      .eq('id', ticketId)
      .single();

    if (preFetchErr || !preTransfer) {
      console.error('transfer-ticket: could not read pre-transfer ticket state for', ticketId, preFetchErr && preFetchErr.message);
    }
    const sellerEmail = preTransfer?.buyer_email || null;
    const sellerName = preTransfer?.buyer_name || 'Guest';
    const oldTxHash = preTransfer?.tx_hash || null;
    const soldSeat = preTransfer?.seat || null;
    const soldEventName = preTransfer?.event_name || 'Event';

    // FIX 2: rotate the TOTP seed on every resale. The old owner's claim link
    // generates QR codes purely from totp_seed (see validate-ticket.js) — if
    // this isn't rotated, the old owner keeps a fully working ticket forever.
    const newTotpSeed = generateTotpSeed();

    // FIX 4: the confirmed charge, not the pre-purchase asking price. Stripe
    // reports amount_total in cents; session.amount_total will always be a
    // whole number of cents here (it's what was actually charged), so
    // dividing by 100 produces a clean 2-decimal dollar figure with no
    // rounding artifacts — no need to round2() this.
    const resalePrice = typeof session.amount_total === 'number'
      ? session.amount_total / 100
      : null;

    // v2 FIX (Aug 2026): royalty_percent is now read from the event's own
    // configurable column instead of a hardcoded 10% — the server-side half
    // of the fix already applied to updateSellCalc() in the listing modal
    // (live_demo v8.4). Every event in the DB is set to 10 today (checked
    // directly against Supabase), so this has never produced a wrong number
    // yet, but this file and the client would have silently disagreed the
    // moment any event was configured differently. Non-fatal lookup, same
    // pattern as the payout_method/payout_handle read further down — a
    // failed lookup or a missing value falls back to 10, matching both the
    // DB column's own default and updateSellCalc()'s client-side fallback.
    let royaltyPercent = 10;
    try {
      const { data: eventRow } = await supabase
        .from('events')
        .select('royalty_percent')
        .eq('id', preTransfer?.event_id)
        .maybeSingle();
      if (eventRow && eventRow.royalty_percent != null) royaltyPercent = Number(eventRow.royalty_percent);
    } catch (royaltyLookupErr) {
      console.warn('transfer-ticket: royalty_percent lookup failed for', ticketId, royaltyLookupErr.message);
    }

    const royaltyAmount = typeof resalePrice === 'number' ? resalePrice * (royaltyPercent / 100) : null;
    const netPayout      = typeof resalePrice === 'number' ? resalePrice - royaltyAmount : null;

    const { error } = await supabase
      .from('tickets')
      .update({
        status: 'valid',
        listed_price: null,
        buyer_id: null,
        tx_hash: txHash,
        payment: payment || 'Card',
        // FIX 1: actually write the new owner's info — previously accepted
        // as params and silently never used, leaving the seller's info on
        // the ticket row indefinitely.
        buyer_email: buyerEmail || null,
        buyer_name:  buyerName  || null,
        buyer_phone: buyerPhone || null,
        totp_seed:   newTotpSeed,
        // FIX 4: see header note — price (original sale amount) is
        // deliberately left untouched.
        resale_price: resalePrice,
      })
      .eq('id', ticketId);

    if (error) {
      console.error('Transfer error:', error);
      return res.status(500).json({ error: error.message });
    }

    // FIX 3: expire the previous owner's claim link(s) for this ticket
    // immediately. claim.js treats re-access as always allowed (no identity
    // check on repeat visits), so the only way to actually cut off the old
    // owner's access is to push expires_at into the past. This does not
    // touch claim_tokens for OTHER tickets the same person may hold.
    const { error: expireErr } = await supabase
      .from('claim_tokens')
      .update({ expires_at: new Date(0).toISOString() })
      .eq('ticket_id', ticketId);

    if (expireErr) {
      // Non-fatal — the ticket update above already succeeded and is the
      // important part. Log it so stale claim links can be investigated.
      console.warn('transfer-ticket: failed to expire old claim_tokens for', ticketId, expireErr.message);
    }

    const { data: ticket } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', ticketId)
      .single();

    // ── Seller notification: always sent, combined with remaining tickets
    // when there are any. Fire-and-log — the transfer has already fully
    // succeeded by this point, an email failure here shouldn't undo any of
    // the above or fail this response.
    if (sellerEmail) {
      let remaining = [];
      if (oldTxHash) {
        const { data: remainingRows } = await supabase
          .from('tickets')
          .select('id, seat')
          .eq('tx_hash', oldTxHash)
          .neq('id', ticketId);
        remaining = remainingRows || [];
      }

      // Optional nicety, non-fatal if it finds nothing: tell the seller how
      // they're being paid, not just that a sale happened. This ticket's
      // listing (list-ticket.js confirm-listing) already created this row.
      let payoutMethod = null, payoutHandle = null;
      try {
        const { data: payoutRow } = await supabase
          .from('payouts')
          .select('payout_method, payout_handle')
          .eq('ticket_id', ticketId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (payoutRow) {
          payoutMethod = payoutRow.payout_method;
          payoutHandle = payoutRow.payout_handle;
        }
      } catch (payoutLookupErr) {
        console.warn('transfer-ticket: payout lookup failed for', ticketId, payoutLookupErr.message);
      }

      await sendEmailSafe({
        type: 'sold',
        email: sellerEmail,
        name: sellerName,
        soldTicketId: ticketId,
        soldSeat,
        eventName: soldEventName,
        resalePrice,
        royaltyAmount,
        royaltyPercent,
        netPayout,
        payoutMethod,
        payoutHandle,
        remainingTicketIds: remaining.map(r => r.id),
        remainingSeats: remaining.map(r => r.seat),
        venueUrl,
      });
    } else {
      console.warn('transfer-ticket: no seller email on file for', ticketId, '— sold notification skipped');
    }

    return res.status(200).json({ success: true, ticket, txHash });
  } catch (err) {
    console.error('transfer-ticket error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
