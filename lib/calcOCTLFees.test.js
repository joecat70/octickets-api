// lib/calcOCTLFees.test.js - test harness for calcOCTLFees FLAT-TIER v1.1.
//
// Run:  node lib/calcOCTLFees.test.js
// Expected final line:  ALL INVARIANTS HOLD - 0 failures
// Exit code 0 on pass, 1 on any failure (so it can gate a deploy).
//
// v1.1 (Sep 30 2026, Joe) - two changes, nothing else touched:
//   1. The middle fee tier ($20.01 to $50.00) is now fee $3.00, OCTL $2.00,
//      venue $1.00 (it was $4.00 / $2.00 / $2.00). This matches the change to
//      FEE_TIERS in lib/calcOCTLFees.js. Three places in this file carried
//      the old tier and are updated: the expectedTier() reference function in
//      section 2, and the $20.01 and $50.00 lines in section 3.
//   2. NEW section 7 tests calcOnTop(), the on-top pricing function added to
//      lib/calcOCTLFees.js for Krazy Mike's. The venue enters FACE value;
//      the flat service fee (tier chosen by FACE value) and sales tax (percent
//      of face + fee, always rounded UP to the next cent) are added on top.
//      Section 7 checks the pitch figures, the identities that must always
//      hold, the fee tiers by face value, the round-up rule against an
//      independent calculation, other tax rates, and bad input.
//   Sections 1, 4, 5 and 6 are unchanged. Section 6 (resale) still holds
//   because a $30 primary sale (now fee $3.00) still differs from the flat
//   $2.00 resale fee.
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
var calcOnTop = require('./calcOCTLFees').calcOnTop;

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
// v1.1: middle tier is now fee 3.00 / octl 2.00 / venue 1.00.

console.log('');
console.log('2. REGRESSION vs flat-tier table (both methods)');

function expectedTier(allIn) {
  if (allIn <= 20.00) return { fee: 2.00, octl: 1.50, venue: 0.50 };
  if (allIn <= 50.00) return { fee: 3.00, octl: 2.00, venue: 1.00 };
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
// v1.1: the $20.01 and $50.00 lines now expect the middle-tier fee of 3.00.

console.log('');
console.log('3. TIER BOUNDARIES (accepted cliffs, confirming they exist as designed)');

var boundaries = [
  [20.00, 2.00, '$20.00 is tier 1'],
  [20.01, 3.00, '$20.01 is tier 2'],
  [50.00, 3.00, '$50.00 is tier 2'],
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

// -- 7. ON-TOP PRICING: calcOnTop(face, taxPct) ------------------------------
// NEW section (v1.1, Sep 2026). The venue enters FACE value; the service fee
// (tier chosen by FACE value, not by the total) and sales tax (percent of
// face + fee, always rounded UP to the next cent) are added on top:
//     allIn = face + fee + tax
// Card processing is not part of this function (Stripe deducts it on the venue
// side, the same policy as calcOCTLFees above).

console.log('');
console.log('7. ON-TOP PRICING calcOnTop (face + fee + tax, tax rounds UP)');

// 7a. The figures used in the Krazy Mike's pitch, at 6.5 percent tax.
var pitch = [
  [20, 23.43], [25, 29.82], [80, 90.53], [100, 111.83], [120, 133.13],
  [135, 149.10], [160, 175.73], [400, 431.33], [540, 580.43]
];
var pitchBroken = 0;
pitch.forEach(function (row) {
  var t = calcOnTop(row[0], 6.5);
  if (!near(t.price, row[1])) {
    pitchBroken++;
    fail('face ' + money(row[0]) + ' at 6.5 percent: expected all-in ' + money(row[1]) + ', got ' + money(t.price));
  }
});
if (pitchBroken === 0) console.log('   [ok] all ' + pitch.length + ' pitch figures match (for example $400.00 face -> $431.33 all-in)');

// 7b. Identities that must hold at every face value from $0.01 to $500.00.
var onTopBroken = { sum: 0, split: 0, negTax: 0, roundUp: 0, notCents: 0, cross: 0 };
for (var fc = 1; fc <= 50000; fc++) {
  var face7 = fc / 100;
  var t7 = calcOnTop(face7, 6.5);
  var feeC7 = Math.round(t7.fee * 100);
  var taxC7 = Math.round(t7.tax * 100);
  if (Math.round(t7.price * 100) !== fc + feeC7 + taxC7) onTopBroken.sum++;
  if (!near(t7.octl + t7.venue, t7.fee)) onTopBroken.split++;
  if (t7.tax < 0) onTopBroken.negTax++;
  // tax must be a whole number of cents
  if (Math.abs(t7.tax * 100 - taxC7) > 0.000001) onTopBroken.notCents++;
  // ROUND UP, checked against a different calculation: exact tax is (face + fee) * 6.5 percent,
  // the charged tax must be at least that, and less than one cent above it.
  var exactTax = (fc + feeC7) * 0.065;
  if (taxC7 < exactTax - 0.000001 || taxC7 - exactTax >= 1 - 0.000001) onTopBroken.roundUp++;
  // independent integer calculation using Math.ceil
  if (taxC7 !== Math.ceil(((fc + feeC7) * 650) / 10000)) onTopBroken.cross++;
}
[
  ['face + fee + tax === all-in, to the cent', onTopBroken.sum],
  ['OCTL share + venue share === service fee', onTopBroken.split],
  ['tax is never negative', onTopBroken.negTax],
  ['tax is a whole number of cents', onTopBroken.notCents],
  ['tax rounds UP (at least exact, less than one cent above)', onTopBroken.roundUp],
  ['tax matches an independent Math.ceil calculation', onTopBroken.cross]
].forEach(function (row) {
  if (row[1] === 0) console.log('   [ok] ' + row[0] + ' (50,000 face values)');
  else fail(row[0] + ' - VIOLATED in ' + row[1] + ' cases');
});

// 7c. The fee tier follows FACE value, not the total.
var onTopTiers = [
  [20.00, 2.00, 1.50, 0.50, 'face $20.00 is the low tier'],
  [20.01, 3.00, 2.00, 1.00, 'face $20.01 is the middle tier'],
  [50.00, 3.00, 2.00, 1.00, 'face $50.00 is the middle tier'],
  [50.01, 5.00, 3.00, 2.00, 'face $50.01 is the high tier']
];
onTopTiers.forEach(function (b) {
  var t = calcOnTop(b[0], 6.5);
  if (t.fee === b[1] && t.octl === b[2] && t.venue === b[3]) {
    console.log('   [ok] ' + b[4] + ' (fee ' + money(t.fee) + ', OCTL ' + money(t.octl) + ', venue ' + money(t.venue) + ')');
  } else {
    fail(b[4] + ': expected fee ' + money(b[1]) + '/OCTL ' + money(b[2]) + '/venue ' + money(b[3]) +
         ', got fee ' + money(t.fee) + '/OCTL ' + money(t.octl) + '/venue ' + money(t.venue));
  }
});
// A $20.00 face has an all-in of $23.43, which is over $20. If the tier followed
// the total it would jump to the middle tier. It must not.
var faceTwenty = calcOnTop(20, 6.5);
if (faceTwenty.price > 20 && faceTwenty.fee === 2.00) {
  console.log('   [ok] tier follows face, not total ($20.00 face -> all-in ' + money(faceTwenty.price) + ' but fee stays ' + money(faceTwenty.fee) + ')');
} else {
  fail('tier followed the total instead of the face value: $20.00 face gave fee ' + money(faceTwenty.fee));
}

// 7d. Other tax rates and the default.
var t0 = calcOnTop(100, 0);
if (t0.tax === 0 && near(t0.price, 105)) console.log('   [ok] 0 percent tax -> all-in is face + fee ($105.00)');
else fail('0 percent tax: expected tax 0.00 and all-in 105.00, got ' + money(t0.tax) + ' / ' + money(t0.price));

var t7pct = calcOnTop(100, 7);
if (near(t7pct.tax, 7.35) && near(t7pct.price, 112.35)) console.log('   [ok] 7 percent tax on $105.00 -> $7.35 (all-in $112.35)');
else fail('7 percent tax: expected 7.35 / 112.35, got ' + money(t7pct.tax) + ' / ' + money(t7pct.price));

var tDefault = calcOnTop(100);
var tNull = calcOnTop(100, null);
if (near(tDefault.price, 111.83) && near(tNull.price, 111.83)) console.log('   [ok] no tax rate given -> defaults to 6.5 percent ($111.83)');
else fail('default tax rate wrong: undefined -> ' + money(tDefault.price) + ', null -> ' + money(tNull.price));

var tExact = calcOnTop(25, 6.5);
if (near(tExact.tax, 1.82)) console.log('   [ok] an exact result is not rounded up ($28.00 x 6.5 percent = $1.82 exactly)');
else fail('exact tax was changed: expected 1.82, got ' + money(tExact.tax));

// 7e. Bad input must return a zero result and never throw.
var onTopBad = [0, -5, NaN, Infinity, null, undefined, 'abc', {}];
onTopBad.forEach(function (bad) {
  var label;
  if (bad === undefined) label = 'undefined';
  else if (typeof bad === 'number' && isNaN(bad)) label = 'NaN';
  else label = JSON.stringify(bad);
  try {
    var t = calcOnTop(bad, 6.5);
    if (t.price === 0 && t.face === 0 && t.fee === 0 && t.tax === 0) console.log('   [ok] ' + pad(label, 10) + ' -> zero result');
    else fail('calcOnTop(' + label + ') -> non-zero result: ' + JSON.stringify(t));
  } catch (e3) {
    fail('calcOnTop(' + label + ') THREW: ' + e3.message);
  }
});

console.log('');
console.log('----------------------------------------------------------------------');
console.log(failures === 0
  ? 'ALL INVARIANTS HOLD - 0 failures'
  : failures + ' FAILURE(S)');

process.exit(failures === 0 ? 0 : 1);
