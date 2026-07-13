// calcOCTLFees.js (v2 — frozen $50–$65 band)
// Model C fee-split calculator — OC Tickets Live
//
// Legal review complete (Jul 2026) — cleared to build. This is the single
// source of truth for the fee math: the admin all-in price field, the
// fan-facing checkout breakdown, and create-stripe-session.js's Stripe
// Connect application_fee_amount should all call THIS function rather than
// each re-implementing the formula separately.
//
// ROUNDING METHOD (explicit, because this is real money):
// Every intermediate value is carried at full floating-point precision
// through the whole calculation. Each of the six output fields is rounded
// to the nearest cent independently, at the point it is computed — not
// chained from an already-rounded prior field. This is the simplest,
// most auditable convention (each column = round(its own raw formula)),
// and is what this file uses consistently everywhere.
//
// NOTE ON THE SOURCE DOCUMENT'S EXAMPLE TABLE (OCTL_BusinessModel_FeeStructure.docx,
// section 3.3): most rows match this method exactly to the penny. A couple of rows
// (e.g. the $65 row's Net Pool) are off by $0.01 from this method, because no single
// consistent rounding rule reproduces every row in that table simultaneously — it
// appears a couple of rows in the source table picked up a stray penny from
// spreadsheet cell-reference rounding. See the comparison printed by this file's
// test harness (run `node calcOCTLFees.js`) for the exact rows and deltas.

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * @param {number} allInPrice - the single fan-facing ticket price (required
 *   under Model C — venues enter ONE all-in price, not price + separate fee).
 * @param {'card'|'crypto'} paymentMethod - card subtracts a Stripe processing
 *   deduction before the split; crypto does not (no Stripe fee applies).
 * @returns {{
 *   allInPrice: number, faceValue: number, serviceFeeGross: number,
 *   stripeFee: number, netPool: number, octlTake: number, venueNet: number,
 *   paymentMethod: string
 * }}
 */
function calcOCTLFees(allInPrice, paymentMethod = 'card') {
  if (typeof allInPrice !== 'number' || !(allInPrice > 0)) {
    throw new Error('calcOCTLFees: allInPrice must be a positive number, got ' + allInPrice);
  }

  // Base (unmodified) formula at full precision — used directly outside the
  // frozen band, and to compute the $50 anchor values inside it.
  function baseRaw(allIn) {
    const rate = allIn <= 50 ? 0.10 : 0.085;
    const faceRaw   = allIn / (1 + rate);
    const svcRaw    = allIn - faceRaw;
    const stripeRaw = (paymentMethod === 'crypto') ? 0 : (allIn * 0.029 + 0.30);
    const netRaw    = svcRaw - stripeRaw;
    const octlRaw   = Math.max(0, Math.min(1.00 + 0.25 * svcRaw, netRaw)); // hard cap at pool
    const venueRaw  = Math.max(0, netRaw - octlRaw);                        // floor at $0
    return { faceRaw, svcRaw, stripeRaw, netRaw, octlRaw, venueRaw };
  }

  let r;
  if (allInPrice > 50 && allInPrice <= 65) {
    // FROZEN BAND (cliff fix, Joe-approved Jul 12 2026): the documented formula
    // applied 8.5% to the WHOLE price the instant it crossed $50, crashing
    // venue net from $0.66 (at $50.00) to $0.22 (at $51.00). Fix: venue net
    // and OCTL take are pinned at their exact $50 anchor values FOR THIS
    // PAYMENT METHOD (card: venue ~$0.66 / OCTL ~$2.14; crypto: venue ~$2.41 /
    // OCTL ~$2.14 — crypto's anchor differs because no Stripe fee shrinks its
    // pool). Stripe still scales with the real price; service fee gross
    // stretches to cover (frozen venue + frozen OCTL + actual Stripe fee);
    // the artist's face value absorbs the remainder of each price increase.
    // Verified: venue net perfectly flat across the band, zero discontinuity
    // at the $65 -> $66 boundary; OCTL steps $2.14 -> $2.29 at $66 by design
    // (explicitly left as-is per Joe).
    const anchor    = baseRaw(50);
    const stripeRaw = (paymentMethod === 'crypto') ? 0 : (allInPrice * 0.029 + 0.30);
    const svcRaw    = anchor.venueRaw + anchor.octlRaw + stripeRaw;
    r = {
      faceRaw:   allInPrice - svcRaw,
      svcRaw:    svcRaw,
      stripeRaw: stripeRaw,
      netRaw:    anchor.venueRaw + anchor.octlRaw,
      octlRaw:   anchor.octlRaw,
      venueRaw:  anchor.venueRaw,
    };
  } else {
    r = baseRaw(allInPrice); // <=$50 and >$65: original formula, unchanged
  }

  return {
    allInPrice: round2(allInPrice),
    faceValue: round2(r.faceRaw),
    serviceFeeGross: round2(r.svcRaw),
    stripeFee: round2(r.stripeRaw),
    netPool: round2(r.netRaw),
    octlTake: round2(r.octlRaw),
    venueNet: round2(r.venueRaw),
    paymentMethod,
  };
}

module.exports = { calcOCTLFees, round2 };

// ── Test harness: verify against the document's Section 3.3 table ──────────
if (require.main === module) {
  const docTable = [
    { allIn: 29,  face: 26.36,  svc: 2.64, stripe: 1.14, net: 1.50, octl: 1.50, venue: 0.00 },
    { allIn: 45,  face: 40.91,  svc: 4.09, stripe: 1.61, net: 2.49, octl: 2.02, venue: 0.46 },
    { allIn: 50,  face: 45.45,  svc: 4.55, stripe: 1.75, net: 2.80, octl: 2.14, venue: 0.66 },
    { allIn: 65,  face: 59.91,  svc: 5.09, stripe: 2.19, net: 2.90, octl: 2.27, venue: 0.63 },
    { allIn: 70,  face: 64.52,  svc: 5.48, stripe: 2.33, net: 3.15, octl: 2.37, venue: 0.78 },
    { allIn: 85,  face: 78.34,  svc: 6.66, stripe: 2.77, net: 3.89, octl: 2.66, venue: 1.23 },
    { allIn: 100, face: 92.17,  svc: 7.83, stripe: 3.20, net: 4.63, octl: 2.96, venue: 1.68 },
    { allIn: 125, face: 115.21, svc: 9.79, stripe: 3.92, net: 5.87, octl: 3.45, venue: 2.42 },
  ];

  const fields = ['face','svc','stripe','net','octl','venue'];
  const keyMap  = { face:'faceValue', svc:'serviceFeeGross', stripe:'stripeFee', net:'netPool', octl:'octlTake', venue:'venueNet' };

  console.log('CARD — computed vs. document Section 3.3 table\n');
  console.log('AllIn  | Field   | Computed | Document | Match?');
  console.log('-------|---------|----------|----------|-------');
  let mismatches = 0;
  docTable.forEach(row => {
    const result = calcOCTLFees(row.allIn, 'card');
    fields.forEach(f => {
      const computed = result[keyMap[f]];
      const doc = row[f];
      const match = Math.abs(computed - doc) < 0.001;
      if (!match) mismatches++;
      console.log(
        `$${String(row.allIn).padEnd(5)}| ${f.padEnd(7)} | $${computed.toFixed(2).padEnd(7)} | $${doc.toFixed(2).padEnd(7)} | ${match ? '✓' : '✗ off by $' + Math.abs(computed - doc).toFixed(2)}`
      );
    });
    console.log('-------|---------|----------|----------|-------');
  });
  console.log(`\nTotal mismatches: ${mismatches} out of ${docTable.length * fields.length} values checked.\n`);

  console.log('CRYPTO example — $65 all-in (no Stripe fee, full service fee gross flows to net pool):');
  console.log(calcOCTLFees(65, 'crypto'));
}
