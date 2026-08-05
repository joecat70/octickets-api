// calcOCTLFees.js (FLAT-TIER v1 — replaces Model C v3)
// Fee-split calculator — OC Tickets Live
//
// SINGLE SOURCE OF TRUTH. The admin all-in price field, the fan-facing checkout
// breakdown, the Show P&L, and create-stripe-session.js's Stripe Connect
// application_fee_amount must all call THIS function. Embedded copies in HTML
// files must be byte-identical to the calcOCTLFees() body below (except the
// browser-only .allIn alias some of them add — see those files' own headers).
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES FROM MODEL C v3 (Joe-approved, Aug 2026)
//
// 1. FLAT TIERS, NOT A PERCENTAGE FORMULA. Fee and OCTL/venue split are now
//    FIXED CONSTANTS per tier, identical for card and crypto (never
//    payment-method-dependent — all-in-pricing compliance):
//
//        allIn <= $20.00           -> fee $2.00  (OCTL $1.50 / venue $0.50)
//        $20.00 < allIn <= $50.00  -> fee $4.00  (OCTL $2.00 / venue $2.00)
//        allIn > $50.00            -> fee $5.00  (OCTL $3.00 / venue $2.00)
//
//    $20 boundary is an accepted cliff (Joe, Jul 17 2026: "few sub-$20
//    tickets"). No more frozen-band / cliff-fix machinery — flat constants
//    don't need one; there's no percentage-of-price discontinuity to smooth.
//
// 2. STRIPE'S COST COMES OUT OF FACE VALUE, NOT THE FEE. This is the core
//    mechanical difference from Model C. Under Model C, Stripe was paid OUT OF
//    the service fee pool, and OCTL/venue split the remainder — so a bigger
//    Stripe fee meant a smaller OCTL/venue take. Under flat-tier, OCTL and
//    venue ALWAYS get their exact fixed cut, on every ticket, regardless of
//    payment method. Stripe's real processing cost (card only; ~2.9% + $0.30)
//    is deducted from FACE VALUE instead — it comes out of the artist/venue
//    settlement, not out of OCTL's or venue's take. Per Joe (Aug 2026): "we are
//    just a provider of a service for a fee... OCTL has no part in [Stripe
//    cost] — that's a cost of doing business between the artist and venue,
//    however they configure it into show cost."
//
//    Consequence: octlTake + venueNet === serviceFeeGross EXACTLY, always — no
//    remainder math needed, because nothing is subtracted from the fee anymore.
//    netPool is kept in the return shape for interface back-compat with Model C
//    consumers; it is now simply === serviceFeeGross.
//
// 3. RESALE (TICKET EXCHANGE) FLAT FEE — NEW, Aug 2026, DEMO FIGURE.
//    Resales no longer run through the primary-sale tier table. This resolves
//    the open question flagged Jul 14 2026 in create-stripe-session.js (OCTL's
//    normal per-ticket cut was stacking on top of the venue's separately
//    collected 10% resale royalty, with no decision on whether that was right).
//    Joe's call: on a resale, OCTL takes a FLAT fee, 100% to OCTL, $0 to venue
//    from this fee (the venue's cut on a resale comes entirely from the
//    existing separate 10% royalty mechanism in payouts, not from here).
//    Set at $2.00 for demonstration purposes — call calcOCTLFees(allInPrice,
//    paymentMethod, { isResale: true }). REVISIT THIS FIGURE before a real
//    venue resale goes live; it has not been validated against real economics.
//
// ─────────────────────────────────────────────────────────────────────────────
// FAN-FACING RULE (unchanged): only faceValue and serviceFeeGross may ever be
// shown to a buyer. stripeFee / octlTake / venueNet are internal — never
// itemize them on any buyer-facing surface (all-in pricing compliance).
//
// EDGE CASE (not floored, deliberately — same philosophy as Model C's negative
// venueNet below ~$4.93, except it now shows up in faceValue instead of
// venueNet, because venue/OCTL are constants and face value is what flexes):
// faceValue can go negative or near-zero on very low-priced card tickets,
// because Stripe's ~$0.30+2.9% cost is fixed while the artist/venue absorb it
// out of face value — NOT out of OCTL's or venue's fixed cut, which never
// change. Not floored here. Clamp at the DISPLAY layer only if a venue-facing
// panel must not show a negative face value.
// ─────────────────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const FEE_TIERS = [
  { max: 20.00, fee: 2.00, octl: 1.50, venue: 0.50 },
  { max: 50.00, fee: 4.00, octl: 2.00, venue: 2.00 },
  { max: Infinity, fee: 5.00, octl: 3.00, venue: 2.00 },
];

// Resale (Ticket Exchange) flat fee — 100% to OCTL, $0 to venue from this fee.
// DEMO FIGURE (Joe, Aug 2026) — revisit before a real venue resale goes live.
const RESALE_FEE_FLAT = 2.00;

const ZERO_SPLIT = {
  allInPrice: 0, faceValue: 0, serviceFeeGross: 0, stripeFee: 0,
  netPool: 0, octlTake: 0, venueNet: 0, paymentMethod: 'card',
};

/**
 * @param {number} allInPrice - the single fan-facing ticket price (venues enter
 * ONE all-in price, never price + separate fee).
 * @param {string} paymentMethod - anything matching /crypto|wallet/i is treated
 * as crypto (no Stripe fee); everything else is card. Accepts the raw strings
 * the tickets table stores, e.g. "Card", "Crypto Wallet".
 * @param {{isResale?: boolean}} [opts] - pass { isResale: true } for a Ticket
 * Exchange resale, which uses the flat RESALE_FEE_FLAT instead of the
 * primary-sale FEE_TIERS table.
 * @returns {{allInPrice:number, faceValue:number, serviceFeeGross:number,
 * stripeFee:number, netPool:number, octlTake:number, venueNet:number,
 * paymentMethod:'card'|'crypto'}} Never throws. Returns an all-zero split for a
 * non-positive or non-finite price.
 */
function calcOCTLFees(allInPrice, paymentMethod = 'card', opts = {}) {
  const isResale = !!opts.isResale;
  const method = /crypto|wallet/i.test(String(paymentMethod)) ? 'crypto' : 'card';

  const allIn = Number(allInPrice);
  if (!Number.isFinite(allIn) || allIn <= 0) {
    return { ...ZERO_SPLIT, paymentMethod: method };
  }

  let serviceFeeGross, octlTake, venueNet;
  if (isResale) {
    serviceFeeGross = RESALE_FEE_FLAT;
    octlTake = RESALE_FEE_FLAT;
    venueNet = 0;
  } else {
    const tier = FEE_TIERS.find(t => allIn <= t.max);
    serviceFeeGross = tier.fee;
    octlTake = tier.octl;
    venueNet = tier.venue;
  }

  // Stripe's real cost — card only, never charged/shown to crypto buyers, never
  // itemized to any buyer. Deducted from face value, not from the fixed fee.
  const stripeFee = (method === 'crypto') ? 0 : round2(allIn * 0.029 + 0.30);

  // netPool: interface back-compat with the Model C shape. Under flat-tier the
  // fee is never touched by Stripe, so netPool === serviceFeeGross exactly.
  const netPool = serviceFeeGross;

  const faceValue = round2(allIn - serviceFeeGross - stripeFee);

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

module.exports = { calcOCTLFees, round2, FEE_TIERS, RESALE_FEE_FLAT };
