// calcOCTLFees.js (v3 — remainder rounding, hardened interface)
// Model C fee-split calculator — OC Tickets Live
//
// SINGLE SOURCE OF TRUTH. The admin all-in price field, the fan-facing checkout
// breakdown, the Show P&L, and create-stripe-session.js's Stripe Connect
// application_fee_amount must all call THIS function. Embedded copies in HTML
// files must be byte-identical to the calcOCTLFees() body below. (As of v2 they
// were NOT — see CHANGES #2.)
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES FROM v2
//
// 1. ROUNDING METHOD CHANGED: independent → REMAINDER.
//    v2 rounded each of the six outputs independently from its own raw formula
//    ("each column = round(its own raw formula)"). That convention is auditable
//    per-column but does NOT reconcile: stripeFee + octlTake + venueNet differed
//    from serviceFeeGross in ~1/3 of all prices, and octlTake + venueNet differed
//    from netPool in ~1/4. (The source document's own Section 3.3 table carries the
//    same artifact: the $100 row lists venue $1.68, yet 3.20 + 2.96 + 1.68 = $7.84
//    against a $7.83 fee.) A cent per ticket is immaterial to a fan but it means
//    no internal ledger ever balanced, and the Show P&L had to work around it.
//    v3 rounds the INDEPENDENT quantities and derives the DEPENDENT ones as
//    remainders, so every identity below holds exactly, at every price:
//
//        faceValue + serviceFeeGross === allInPrice
//        stripeFee + octlTake + venueNet === serviceFeeGross
//        octlTake + venueNet === netPool
//        netPool + stripeFee === serviceFeeGross
//
//    This is also what settlement actually does: the venue receives whatever is
//    left in the fee after Stripe and OCTL are paid, so the remainder IS the
//    accurate figure, not a rounded re-derivation of it.
//
// 2. FROZEN-BAND ANCHORS PINNED TO EXACT CENTS.
//    v2 computed the $50 anchors at full float precision (card venue $0.659090…,
//    OCTL $2.136363…), but the embedded copies in club_chaotic / coral_springs /
//    the admin files hardcoded the ROUNDED $0.66 / $2.14. Those disagree: at a $51
//    card ticket v2 yields face $46.43 and the deployed copies yield $46.42. Real
//    money, in production. v3 resolves it in favour of the deployed, human-readable
//    values: the anchors ARE the published cent figures (card $0.66/$2.14, crypto
//    $2.41/$2.14). They are now named constants, not a re-derivation.
//
// 3. INTERFACE HARDENED.
//    v2 threw on a bad price; the chaotic_admin copy returned null; the venue-file
//    copies had no guard at all. A throw inside checkout would have been uncaught.
//    v3 never throws: it returns an all-zero split for a non-positive/non-finite
//    price. paymentMethod is now NORMALIZED, not compared for equality — the
//    tickets table stores the string "Crypto Wallet", which v2 silently treated as
//    a CARD payment and charged a Stripe fee it never paid.
//
// ─────────────────────────────────────────────────────────────────────────────
// ECONOMICS BELOW $33.18 (card) — INTENTIONAL, DO NOT "FIX"
//
// • Venue net is $0.00 on every card ticket under ~$33.18. This falls out of
//   OCTL's take being capped at the pool (Math.min below): OCTL absorbs the
//   thin fee on cheap tickets. The venue's face value is untouched and its net
//   floors at $0 — the venue NEVER covers any part of the Stripe fee.
//
// • Below ~$4.93 (card) the service fee is smaller than the Stripe fee itself.
//   OCTL's take floors at $0 and there is not enough money in the fee to fund
//   face value. venueNet therefore goes NEGATIVE in this zone — deliberately.
//   It is not floored at $0 (v2 floored it, which hid the shortfall). Joe's call,
//   Jul 13 2026: "If there is an event at prices that low, that is on the venue,
//   not OCTL. Leave as is." A negative venueNet is the honest representation of
//   exactly that: the venue absorbs it, and the number says so. It also keeps the
//   model exactly self-consistent —
//
//       face + venueNet === allIn − stripe − octl === what settlement transfers
//
//   — so a P&L built on these figures reconciles to the actual payout with no
//   correction. No minimum price is enforced. Raising the service fee to cover
//   this was explicitly REJECTED: under all-in pricing that money would come
//   straight out of face value, i.e. out of the venue, and hand it to OCTL.
//
// • venueNet is therefore >= $0.00 for every card ticket at or above $4.93 and
//   for every crypto ticket at any price. Consumers that must not show a negative
//   venue figure to a venue operator should clamp AT THE DISPLAY LAYER, never here.
// ─────────────────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Published $50 anchor values for the frozen band (see CHANGES #2). These are the
// exact cent figures the deployed files use and the business model document prints.
const FROZEN_ANCHORS = {
  card:   { venue: 0.66, octl: 2.14 },
  crypto: { venue: 2.41, octl: 2.14 }, // crypto's anchor differs: no Stripe fee shrinks its pool
};

const ZERO_SPLIT = {
  allInPrice: 0, faceValue: 0, serviceFeeGross: 0, stripeFee: 0,
  netPool: 0, octlTake: 0, venueNet: 0, paymentMethod: 'card',
};

/**
 * @param {number} allInPrice - the single fan-facing ticket price (Model C: venues
 * enter ONE all-in price, never price + separate fee).
 * @param {string} paymentMethod - anything matching /crypto|wallet/i is treated as
 * crypto (no Stripe fee); everything else is card. Accepts the raw strings the
 * tickets table stores, e.g. "Card", "Crypto Wallet".
 * @returns {{allInPrice:number, faceValue:number, serviceFeeGross:number,
 * stripeFee:number, netPool:number, octlTake:number, venueNet:number,
 * paymentMethod:'card'|'crypto'}} Never throws. Returns an all-zero split for a
 * non-positive or non-finite price.
 */
function calcOCTLFees(allInPrice, paymentMethod = 'card') {
  const method = /crypto|wallet/i.test(String(paymentMethod)) ? 'crypto' : 'card';

  const allIn = Number(allInPrice);
  if (!Number.isFinite(allIn) || allIn <= 0) {
    return { ...ZERO_SPLIT, paymentMethod: method };
  }

  const stripeRaw = (method === 'crypto') ? 0 : (allIn * 0.029 + 0.30);

  let svcRaw, octlRaw;
  if (allIn > 50 && allIn <= 65) {
    // FROZEN BAND (cliff fix, Joe-approved Jul 12 2026). The documented formula
    // applied 8.5% to the WHOLE price the instant it crossed $50, crashing venue
    // net from $0.66 (at $50.00) to $0.22 (at $51.00). Fix: venue net and OCTL take
    // are pinned at their $50 anchor values FOR THIS PAYMENT METHOD. Stripe still
    // scales with the real price; the service fee gross stretches to cover
    // (frozen venue + frozen OCTL + actual Stripe); face value absorbs the rest.
    // Venue net is perfectly flat across the band. OCTL steps $2.14 → $2.29 at $66
    // by design — explicitly left as-is per Joe.
    const a = FROZEN_ANCHORS[method];
    svcRaw = a.venue + a.octl + stripeRaw;
    octlRaw = a.octl;
  } else {
    // Base formula: <= $50 and > $65.
    const rate = allIn <= 50 ? 0.10 : 0.085;
    svcRaw  = allIn - allIn / (1 + rate);
    const netRaw = svcRaw - stripeRaw;
    // OCTL takes $1 + 25% of the service fee, capped at whatever is actually in the
    // pool and floored at $0. The cap is what makes OCTL — never the venue — absorb
    // the shortfall on cheap tickets. See ECONOMICS above.
    octlRaw = Math.max(0, Math.min(1.00 + 0.25 * svcRaw, netRaw));
  }

  // ── Rounding: round the independents, derive the dependents as remainders ──
  const serviceFeeGross = round2(svcRaw);
  const faceValue       = round2(allIn - serviceFeeGross);          // remainder of the all-in
  const stripeFee       = round2(stripeRaw);
  const netPool         = round2(serviceFeeGross - stripeFee);      // remainder of the fee

  // OCTL's take is capped against the ROUNDED pool, not the raw one. Rounding the
  // raw take independently could push it a cent ABOVE the rounded pool, dragging
  // venueNet to −$0.01 on prices where the fee comfortably covers Stripe (it did so
  // at $25, among 351 others). Capping after rounding guarantees venueNet >= 0
  // everywhere the pool is non-negative. Where the pool IS negative (sub-$4.93 card),
  // OCTL takes nothing and the venue absorbs the shortfall — see ECONOMICS above.
  const octlTake = Math.min(round2(octlRaw), Math.max(netPool, 0));
  const venueNet = round2(netPool - octlTake);                      // remainder of the pool

  return {
    allInPrice: round2(allIn),
    faceValue,
    serviceFeeGross,
    stripeFee,
    netPool,
    octlTake,
    venueNet,
    paymentMethod: method,
  };
}

module.exports = { calcOCTLFees, round2, FROZEN_ANCHORS };
