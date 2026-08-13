// api/transfer-ticket.js
// Confirmed filename — client call found at club_chaotic_v2_11.html line ~4575.
//
// Four fixes applied to the original logic (fourth added this revision):
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

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Same seed format used in stripe-webhook.js — 20 random bytes, hex-encoded uppercase.
function generateTotpSeed() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // FIX 1: buyerPhone is now an accepted param — required for ZeroScalp's
  // phone-match identity model to work correctly for the NEW owner.
  const { ticketId, sessionId, buyerEmail, buyerName, buyerPhone, payment } = req.body;
  if (!ticketId || !sessionId) return res.status(400).json({ error: 'Missing ticketId or sessionId' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['customer_details'] });
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not confirmed' });
    }

    const txHash = 'stripe:' + sessionId;

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

    return res.status(200).json({ success: true, ticket, txHash });
  } catch (err) {
    console.error('transfer-ticket error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
