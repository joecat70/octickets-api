// lib/calcOCTLFees.test.js - test harness for calcOCTLFees FLAT-TIER v1.
//
// Run:  node lib/calcOCTLFees.test.js
// Expected final line:  ALL INVARIANTS HOLD - 0 failures
// Exit code 0 on pass, 1 on any failure (so it can gate a deploy).
//
// NOTE ON STYLE: this file deliberately contains NO backticks, NO template
// literals, and NO non-ASCII characters. Plain string concatenation only. An
// earlier version used template literals, and the backticks were silently
// stripped when the file was relayed through a chat client - producing a
// SyntaxError before a single test could run. Concatenation survives any
// copy/paste path. Please keep it that way if you edit this file.
//
// Rewritten for FLAT-TIER v1 (Aug 2026, replaces Model C v3). The frozen-band
// and Section-3.3-doc-regression sections from the Model C test file are
// REMOVED - flat-tier has no percentage formula and no frozen band, so there
// is nothing for them to regress against. Replaced with: tier-table regression
// (section 2) and resale flat-fee coverage (section 6).

var calcOCTLFees = require('./calcOCTLFees').calcOCTLFees;

var failures = 0;

function fail(msg) { failures++; console.log('  [FAIL] ' + msg); }
function near(a, b) { return Math.abs(a - b) < 0.0001; }
function money(n) { return '$' + n.toFixed(2); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

// -- 1. RECONCILIATION INVARIANTS ------------------------------------------
// Swept $0.01-$500.00 at 1 cent granularity, both payment methods.
// Flat-tier invariants differ from Model C's: Stripe no longer lives inside
// the fee, so it is added back in on the face+fee side of the identity, and
// octl+venue===fee holds EXACTLY (fixed constants, no remainder math).

console.log('');
console.log('1. RECONCILIATION INVARIANTS ($0.01-$500.00, 1c steps, card + crypto)');

var broken = { face: 0, split: 0, pool: 0, negOctl: 0, negVenue: 0 };
var checked = 0;
var methods = ['card', 'crypto'];

for (var cents = 1; cents <= 50000; cents++) {
  for (var mi = 0; mi < methods.length; mi++) {
    var m = methods[mi];
    var r = calcOCTLFees(cents / 100, m);
    checked++;

    if (!near(r.faceValue + r.serviceFeeGross + r.stripeFee, r.allInPrice)) broken.face++;
    if (!near(r.octlTake + r.venueNet, r.serviceFeeGross)) broken.split++;
    if (!near(r.netPool, r.serviceFeeGross)) broken.pool++;
    if (r.octlTake < 0) broken.negOctl++;
    if (r.venueNet < 0) broken.negVenue++;
  }
}

console.log('   ' + checked.toLocaleString() + ' splits checked');

var invariants = [
  ['face + serviceFee + stripe === allIn', broken.face],
  ['octl + venue === serviceFee EXACTLY', broken.split],
  ['netPool === serviceFee', broken.pool],
  ['octlTake >= 0 (always - fixed constant)', broken.negOctl],
  ['venueNet >= 0 (always - fixed constant)', broken.negVenue]
];

invariants.forEach(function (row) {
  if (row[1] === 0) console.log('   [ok] ' + row[0]);
  else fail(row[0] + ' - VIOLATED in ' + row[1] + ' cases');
});

console.log('   [info] unlike Model C, octlTake and venueNet can NEVER go negative under');
console.log('          flat-tier - they are fixed constants. Any shortfall from Stripe');
console.log('          cost now shows up in faceValue instead (see section 5).');

// Settlement identity: what the model says everyone gets === what Stripe
// actually transfers (face + fee + stripe === allIn, by construction).
var settleBroken = 0;
for (var c2 = 1; c2 <= 50000; c2++) {
  for (var mj = 0; mj < methods.length; mj++) {
    var s = calcOCTLFees(c2 / 100, methods[mj]);
    var modelled = Math.round((s.faceValue + s.octlTake + s.venueNet + s.stripeFee) * 100) / 100;
    if (!near(modelled, s.allInPrice)) settleBroken++;
  }
}
if (settleBroken === 0) {
  console.log('   [ok] face + octl + venue + stripe === allIn  (model === settlement)');
} else {
  fail('settlement identity VIOLATED in ' + settleBroken + ' cases');
}

// -- 2. REGRESSION vs the flat-tier table (Joe-approved, Aug 2026) -----------
// serviceFeeGross / octlTake / venueNet must be EXACTLY the tier constants,
// at every price in range, both payment methods. No remainder math to check -
// that is the point of flat-tier.

console.log('');
console.log('2. REGRESSION vs flat-tier table (both methods)');

function expectedTier(allIn) {
  if (allIn <= 20.00) return { fee: 2.00, octl: 1.50, venue: 0.50 };
  if (allIn <= 50.00) return { fee: 4.00, octl: 2.00, venue: 2.00 };
  return { fee: 5.00, octl: 3.00, venue: 2.00 };
}

var tierBroken = 0;
for (var c3 = 1; c3 <= 50000; c3++) {
  var price = c3 / 100;
  var exp = expectedTier(price);
  for (var mk = 0; mk < methods.length; mk++) {
    var rr = calcOCTLFees(price, methods[mk]);
    if (rr.serviceFeeGross !== exp.fee || rr.octlTake !== exp.octl || rr.venueNet !== exp.venue) {
      tierBroken++;
      if (tierBroken <= 5) {
        fail('$' + price.toFixed(2) + ' ' + methods[mk] + ': expected fee ' + money(exp.fee) +
             '/octl ' + money(exp.octl) + '/venue ' + money(exp.venue) + ', got fee ' +
             money(rr.serviceFeeGross) + '/octl ' + money(rr.octlTake) + '/venue ' + money(rr.venueNet));
      }
    }
  }
}
if (tierBroken === 0) console.log('   [ok] fee/octl/venue match the tier table exactly at every price, both methods');

var spot = [10, 19.99, 20.00, 20.01, 35, 50.00, 50.01, 75, 100, 300];
console.log('   spot check (card):');
console.log('   price   | fee    | octl   | venue  | stripe | face');
spot.forEach(function (p) {
  var r = calcOCTLFees(p, 'card');
  console.log('   ' + pad(money(p), 8) + '| ' + pad(money(r.serviceFeeGross), 7) + '| ' +
              pad(money(r.octlTake), 7) + '| ' + pad(money(r.venueNet), 7) + '| ' +
              pad(money(r.stripeFee), 7) + '| ' + money(r.faceValue));
});

// -- 3. TIER BOUNDARIES -------------------------------------------------------
// $20 and $50 boundaries are accepted cliffs (Joe, Jul 17 2026: "few sub-$20
// tickets") - confirmed present, not regressed away.

console.log('');
console.log('3. TIER BOUNDARIES (accepted cliffs, confirming they exist as designed)');

var boundaries = [
  [20.00, 2.00, '$20.00 is tier 1'],
  [20.01, 4.00, '$20.01 is tier 2'],
  [50.00, 4.00, '$50.00 is tier 2'],
  [50.01, 5.00, '$50.01 is tier 3']
];
boundaries.forEach(function (b) {
  var r = calcOCTLFees(b[0], 'card');
  if (r.serviceFeeGross === b[1]) console.log('   [ok] ' + b[2] + ' (fee ' + money(r.serviceFeeGross) + ')');
  else fail(b[2] + ': expected fee ' + money(b[1]) + ', got ' + money(r.serviceFeeGross));
});

// -- 4. paymentMethod NORMALIZATION -----------------------------------------
// Unchanged from Model C - the tickets table stores "Crypto Wallet", and that
// must be recognized as crypto, not fall through to card.

console.log('');
console.log('4. paymentMethod NORMALIZATION');

var pmCases = [
  ['crypto', 0], ['Crypto Wallet', 0], ['CRYPTO', 0], ['wallet', 0],
  ['card', 3.20], ['Card', 3.20], ['', 3.20], [undefined, 3.20]
];

pmCases.forEach(function (tc) {
  var input = tc[0], expectStripe = tc[1];
  var r = calcOCTLFees(100, input);
  var label = (input === undefined) ? 'undefined' : JSON.stringify(input);
  if (near(r.stripeFee, expectStripe)) {
    console.log('   [ok] ' + pad(label, 17) + ' -> ' + pad(r.paymentMethod, 7) + ' stripe ' + money(r.stripeFee));
  } else {
    fail(label + ' -> ' + r.paymentMethod + ', stripe ' + money(r.stripeFee) +
         ' (expected ' + money(expectStripe) + ')');
  }
});

// -- 5. BAD INPUT must NOT throw --------------------------------------------

console.log('');
console.log('5. BAD INPUT - must return a zero split, never throw');

var badInputs = [0, -5, NaN, Infinity, null, undefined, 'abc', {}];

badInputs.forEach(function (bad) {
  var label;
  if (bad === undefined) label = 'undefined';
  else if (typeof bad === 'number' && isNaN(bad)) label = 'NaN';
  else label = JSON.stringify(bad);

  try {
    var r = calcOCTLFees(bad, 'card');
    var isZero = (r.allInPrice === 0 && r.faceValue === 0 &&
                  r.serviceFeeGross === 0 && r.venueNet === 0);
    if (isZero) console.log('   [ok] ' + pad(label, 10) + ' -> zero split');
    else fail(label + ' -> non-zero split: ' + JSON.stringify(r));
  } catch (e) {
    fail(label + ' THREW: ' + e.message);
  }
});

// Bad input must also not throw with isResale set.
try {
  var badResale = calcOCTLFees(-5, 'card', { isResale: true });
  if (badResale.allInPrice === 0) console.log('   [ok] bad input + isResale -> zero split');
  else fail('bad input + isResale -> non-zero split: ' + JSON.stringify(badResale));
} catch (e2) {
  fail('bad input + isResale THREW: ' + e2.message);
}

// -- 6. RESALE (TICKET EXCHANGE) FLAT FEE ------------------------------------
// NEW section (Aug 2026). isResale:true must ALWAYS yield fee=octl=$2.00,
// venue=$0.00, regardless of price or payment method - the flat fee replaces
// the tier table entirely for resales, it does not sit alongside it.

console.log('');
console.log('6. RESALE FLAT FEE (isResale: true) - $2.00, 100% OCTL, $0 venue');

var resalePrices = [5, 19.99, 20.01, 50, 65, 100, 300];
var resaleBroken = 0;
resalePrices.forEach(function (p) {
  methods.forEach(function (m) {
    var r = calcOCTLFees(p, m, { isResale: true });
    var ok = (r.serviceFeeGross === 2.00 && r.octlTake === 2.00 && r.venueNet === 0.00);
    if (!ok) {
      resaleBroken++;
      fail('resale $' + p + ' ' + m + ': expected fee 2.00/octl 2.00/venue 0.00, got fee ' +
           money(r.serviceFeeGross) + '/octl ' + money(r.octlTake) + '/venue ' + money(r.venueNet));
    }
  });
});
if (resaleBroken === 0) {
  console.log('   [ok] fee=octl=$2.00, venue=$0.00 at every price tested, both methods');
}

// Resale must be independent of the primary-sale tier table - a $19.99 resale
// (which would be tier 1, fee $2.00, if it were a primary sale) and a $300
// resale (which would be tier 3, fee $5.00) must charge the SAME flat fee.
var lowResale = calcOCTLFees(19.99, 'card', { isResale: true });
var highResale = calcOCTLFees(300, 'card', { isResale: true });
if (lowResale.serviceFeeGross === highResale.serviceFeeGross) {
  console.log('   [ok] resale fee is price-independent ($19.99 and $300 both charge ' +
              money(lowResale.serviceFeeGross) + ')');
} else {
  fail('resale fee varies by price: $19.99 -> ' + money(lowResale.serviceFeeGross) +
       ', $300 -> ' + money(highResale.serviceFeeGross));
}

// A primary sale and a resale at the identical price must differ - proves the
// isResale flag actually branches, rather than isResale being silently ignored.
var primaryAt30 = calcOCTLFees(30, 'card');
var resaleAt30 = calcOCTLFees(30, 'card', { isResale: true });
if (primaryAt30.serviceFeeGross !== resaleAt30.serviceFeeGross || primaryAt30.venueNet !== resaleAt30.venueNet) {
  console.log('   [ok] isResale flag actually changes the split at the same price ($30: primary fee ' +
              money(primaryAt30.serviceFeeGross) + '/venue ' + money(primaryAt30.venueNet) +
              ' vs resale fee ' + money(resaleAt30.serviceFeeGross) + '/venue ' + money(resaleAt30.venueNet) + ')');
} else {
  fail('isResale flag had NO effect at $30 - primary and resale splits are identical');
}

// Resale still deducts real Stripe cost from face value on card, same as primary.
var resaleCard = calcOCTLFees(50, 'card', { isResale: true });
var resaleCrypto = calcOCTLFees(50, 'crypto', { isResale: true });
if (resaleCard.stripeFee > 0 && resaleCrypto.stripeFee === 0) {
  console.log('   [ok] resale still applies real Stripe cost on card, none on crypto (' +
              money(resaleCard.stripeFee) + ' vs ' + money(resaleCrypto.stripeFee) + ')');
} else {
  fail('resale Stripe handling wrong: card ' + money(resaleCard.stripeFee) +
       ', crypto ' + money(resaleCrypto.stripeFee));
}

console.log('');
console.log('----------------------------------------------------------------------');
console.log(failures === 0
  ? 'ALL INVARIANTS HOLD - 0 failures'
  : failures + ' FAILURE(S)');

process.exit(failures === 0 ? 0 : 1);
