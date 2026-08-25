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
//
// FIX (Aug 19 2026): VENUE PAYOUT NOTIFICATION. Nothing previously told the
// venue a resale had even happened — the seller's "sold" email above was the
// only signal generated, and it goes to the seller, not the venue. Venue
// awareness depended entirely on someone remembering to open the admin
// Payouts tab. This adds a second, independent notification fired from the
// same completed-transfer event: an email to the venue's own
// contact_payout_email (new `venues` table, keyed on the same venue_id
// already present on `events` — confirmed populated for all three current
// venues via direct Supabase inspection, Aug 19 2026) telling them a resale
// completed and exactly what they now owe the seller and how to pay them.
//
// Deliberately a SEPARATE sendEmailSafe() call, not folded into the seller
// email above: different recipient, different content, and — importantly —
// independent failure. A missing or bad venue contact address should never
// prevent the seller from getting their own confirmation, and vice versa.
// Also deliberately NOT nested inside `if (sellerEmail)` — the venue needs
// to know money is owed regardless of whether the seller themselves is
// reachable.
//
// venue_id is read off the SAME events row already being queried for
// royalty_percent (one extra selected column, no additional round trip).
// The venues lookup itself is a second, genuinely separate query — non-fatal
// if it errors or finds nothing, same fire-and-log posture as the existing
// payout_method/payout_handle lookup just below it. Skips (with a console
// warning, not a thrown error) if: the venue has no row yet, its
// contact_payout_email is unset, or resalePrice/netPayout never resolved
// (a notice with no dollar amount isn't actionable and would just confuse).
//
// CURRENT STATE (Aug 19 2026): the `venues` table exists with all three
// venue_id rows (theetestsite, concerttix, tickets4sale) but every
// contact_payout_email is still NULL — nobody has filled them in yet. That
// makes this change safe to deploy immediately: with no address on file,
// every venue notice attempt logs a warning and no-ops. Nothing sends to
// nobody, and nothing sends to a wrong address. Emails start flowing the
// moment each venue row gets a real contact_payout_email set.
//
// FIX (Aug 19 2026): RESALE_CONFIRMED_AT. Discovered while designing the
// venue notice above: the `payouts` row list-ticket.js creates at LISTING
// time sets payout_status='pending' immediately, before any sale, and
// nothing ever clears it if the listing is cancelled instead of sold —
// verified against live data, most "pending" rows in the table did not
// correspond to an actual sale. This file now stamps resale_confirmed_at
// on the payout row at the one moment it actually has the authority to
// say so — a confirmed, paid transfer. See the payout lookup block below
// for the full note. Companion fix in list-ticket.js's cancel-confirm
// cleans up the rows this file's absence of a stamp was masking.
//
// STILL REQUIRED, NOT DONE HERE: api/send.js needs a new branch for
// `type: 'venue_payout_notice'` (name chosen here, trivially renameable) —
// this file only builds and dispatches the payload below, same division of
// responsibility as the existing `type: 'sold'` branch. Proposed payload
// shape, all fields already computed above and simply reused:
//   { type: 'venue_payout_notice', email: <venue's contact_payout_email>,
//     ticketId, seat: soldSeat, eventName: soldEventName, sellerName,
//     resalePrice, royaltyAmount, royaltyPercent, netPayout, payoutMethod,
//     payoutHandle, venueUrl }
// netPayout is the one figure that actually matters for action — it's the
// dollar amount the venue now owes the seller. royaltyAmount is what the
// venue keeps; it's included for context, not as the headline number.
// send.js's own template/subject-line conventions weren't in hand at the
// time of this change, so that branch isn't written here — this file was
// not guessed at without the source to verify against.

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

    // FIX (Aug 2026): IDEMPOTENCY GUARD. This endpoint can legitimately be
    // called twice for the same purchase — the client
    // (handleExchangeStripeReturn) and the Stripe webhook can both reach it
    // in a race (the webhook now also calls this endpoint for exchange
    // sessions, added alongside this fix), and Stripe itself sometimes
    // retries webhook deliveries regardless. Without this check, a second
    // call would: rotate totp_seed AGAIN, silently invalidating the QR the
    // buyer is already looking at moments after getting it; and read
    // "seller" info from a ticket row the FIRST call already overwrote to
    // the NEW buyer — sending the "your ticket sold" email to the person
    // who just bought it, about their own new ticket. If this ticket's
    // tx_hash already matches this exact session, the transfer already
    // completed (by an earlier call, from either caller) — return success
    // and do nothing else.
    if (preTransfer?.tx_hash === txHash) {
      console.log('transfer-ticket: already completed for this session (a prior call — client or webhook — got here first) —', ticketId, sessionId);
      const { data: alreadyTransferred } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
      return res.status(200).json({ success: true, ticket: alreadyTransferred, txHash, alreadyCompleted: true });
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
    //
    // Aug 19 2026: also now selects venue_id in this same query — needed for
    // the venue payout-notification lookup below. One extra column, no
    // additional round trip.
    let royaltyPercent = 10;
    let venueId = null;
    try {
      const { data: eventRow } = await supabase
        .from('events')
        .select('royalty_percent, venue_id')
        .eq('id', preTransfer?.event_id)
        .maybeSingle();
      if (eventRow && eventRow.royalty_percent != null) royaltyPercent = Number(eventRow.royalty_percent);
      if (eventRow && eventRow.venue_id) venueId = eventRow.venue_id;
    } catch (royaltyLookupErr) {
      console.warn('transfer-ticket: royalty_percent/venue_id lookup failed for', ticketId, royaltyLookupErr.message);
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

    // payout_method/payout_handle are needed by BOTH the seller's "sold"
    // email and the venue payout notice below. Hoisted here and looked up
    // once, unconditionally — this used to live inside the `if (sellerEmail)`
    // block below, which meant a seller with no email on file would also
    // silently suppress the venue notice. That's backwards: the venue needs
    // to know money is owed regardless of whether the seller is reachable.
    // Non-fatal if it finds nothing. This ticket's listing (list-ticket.js
    // confirm-listing) already created this row.
    //
    // FIX (Aug 19 2026): also stamps resale_confirmed_at on that same row.
    // payout_status alone can't distinguish "actually sold, money now due"
    // from "listed, never sold" or "listed then cancelled" — it's set to
    // 'pending' by list-ticket.js's confirm-listing at LISTING time, before
    // any sale, and nothing clears it if the listing is later cancelled
    // instead of sold. Confirmed via direct query against live data: of 27
    // rows sitting at payout_status='pending' as of Aug 19 2026, only 11
    // corresponded to a ticket that had actually resold; the rest were
    // cancelled listings, still-unsold listings, or rows referencing
    // tickets that no longer exist. resale_confirmed_at is the new,
    // unambiguous signal — set here, once, ONLY on an actual confirmed
    // paid transfer, nowhere else. Any future reminder job (or any query
    // asking "is money actually owed right now") should filter on
    // resale_confirmed_at IS NOT NULL, not on payout_status alone.
    // Requires: ALTER TABLE payouts ADD COLUMN IF NOT EXISTS
    // resale_confirmed_at timestamptz; (already applied directly in
    // Supabase, Aug 19 2026 — not applied by this file).
    let payoutMethod = null, payoutHandle = null;
    try {
      const { data: payoutRow } = await supabase
        .from('payouts')
        .select('id, payout_method, payout_handle')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (payoutRow) {
        payoutMethod = payoutRow.payout_method;
        payoutHandle = payoutRow.payout_handle;

        const { error: confirmErr } = await supabase
          .from('payouts')
          .update({ resale_confirmed_at: new Date().toISOString() })
          .eq('id', payoutRow.id);
        if (confirmErr) {
          console.warn('transfer-ticket: failed to stamp resale_confirmed_at for payout', payoutRow.id, confirmErr.message);
        }
      } else {
        // Not necessarily a bug — but worth knowing about. A resale
        // completing with no matching payouts row means either this ticket
        // predates the payouts table, or list-ticket.js's confirm-listing
        // failed to create one when it should have.
        console.warn('transfer-ticket: no payouts row found for ticket', ticketId, '— nothing to mark as sold.');
      }
    } catch (payoutLookupErr) {
      console.warn('transfer-ticket: payout lookup/stamp failed for', ticketId, payoutLookupErr.message);
    }

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

    // ── Venue payout notification (Aug 19 2026): fully independent of the
    // seller email/notification above — runs whether or not sellerEmail
    // exists, and whether or not the seller's own email succeeded or
    // failed. Reuses payoutMethod/payoutHandle from the hoisted lookup
    // above rather than querying `payouts` twice. See header note for why
    // this is a separate sendEmailSafe() call and what still needs to be
    // added to send.js.
    if (typeof netPayout === 'number' && venueId) {
      try {
        const { data: venueRow, error: venueLookupErr } = await supabase
          .from('venues')
          .select('contact_payout_email')
          .eq('venue_id', venueId)
          .maybeSingle();

        if (venueLookupErr) {
          console.warn('transfer-ticket: venues lookup failed for', ticketId, venueLookupErr.message);
        } else if (venueRow && venueRow.contact_payout_email) {
          await sendEmailSafe({
            type: 'venue_payout_notice',
            email: venueRow.contact_payout_email,
            ticketId,
            seat: soldSeat,
            eventName: soldEventName,
            sellerName,
            resalePrice,
            royaltyAmount,
            royaltyPercent,
            netPayout,
            payoutMethod,
            payoutHandle,
            venueUrl,
          });
        } else {
          // Expected and harmless today — every venue's contact_payout_email
          // is still unset as of Aug 19 2026. Not an error, just unconfigured.
          console.warn('transfer-ticket: no contact_payout_email on file for venue', venueId, '— venue notice skipped for', ticketId);
        }
      } catch (venueNoticeErr) {
        console.warn('transfer-ticket: venue payout notice failed for', ticketId, venueNoticeErr.message);
      }
    } else if (!venueId) {
      console.warn('transfer-ticket: could not resolve venue_id for event', preTransfer?.event_id, '— venue notice skipped for', ticketId);
    }

    return res.status(200).json({ success: true, ticket, txHash });
  } catch (err) {
    console.error('transfer-ticket error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
