// lib/calcOCTLFees.test.js - test harness for calcOCTLFees v3.
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

var calcOCTLFees = require('./calcOCTLFees').calcOCTLFees;

var failures = 0;

function fail(msg) { failures++; console.log('  [FAIL] ' + msg); }
function near(a, b) { return Math.abs(a - b) < 0.0001; }
function money(n) { return '$' + n.toFixed(2); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

// -- 1. RECONCILIATION INVARIANTS ------------------------------------------
// The identities v2 violated. Swept $0.01-$500.00 at 1 cent granularity.

console.log('');
console.log('1. RECONCILIATION INVARIANTS ($0.01-$500.00, 1c steps, card + crypto)');

var broken = { face: 0, fee: 0, pool: 0, net: 0, negVenue: 0, negOctl: 0, acceptedNeg: 0 };
var checked = 0;
var methods = ['card', 'crypto'];

for (var cents = 1; cents <= 50000; cents++) {
  for (var mi = 0; mi < methods.length; mi++) {
    var m = methods[mi];
    var r = calcOCTLFees(cents / 100, m);
    checked++;

    if (!near(r.faceValue + r.serviceFeeGross, r.allInPrice)) broken.face++;
    if (!near(r.stripeFee + r.octlTake + r.venueNet, r.serviceFeeGross)) broken.fee++;
    if (!near(r.octlTake + r.venueNet, r.netPool)) broken.pool++;
    if (!near(r.netPool + r.stripeFee, r.serviceFeeGross)) broken.net++;
    if (r.octlTake < 0) broken.negOctl++;

    // The venue must never cover Stripe - EXCEPT in the accepted sub-$4.93 card
    // zone, where the service fee cannot even fund Stripe's own fee and the venue
    // absorbs it (Joe, Jul 13 2026: "that is on the venue, not OCTL"). Outside
    // that zone, a negative venueNet would be a real defect.
    var degenerate = (m === 'card' && r.serviceFeeGross < r.stripeFee);
    if (r.venueNet < 0 && !degenerate) broken.negVenue++;
    if (r.venueNet < 0 && degenerate) broken.acceptedNeg++;
  }
}

console.log('   ' + checked.toLocaleString() + ' splits checked');

var invariants = [
  ['face + serviceFee === allIn', broken.face],
  ['stripe + octl + venue === serviceFee', broken.fee],
  ['octl + venue === netPool', broken.pool],
  ['netPool + stripe === serviceFee', broken.net],
  ['venueNet >= 0 wherever the fee covers Stripe', broken.negVenue],
  ['octlTake >= 0', broken.negOctl]
];

invariants.forEach(function (row) {
  if (row[1] === 0) console.log('   [ok] ' + row[0]);
  else fail(row[0] + ' - VIOLATED in ' + row[1] + ' cases');
});

console.log('   [info] ' + broken.acceptedNeg + ' splits have venueNet < 0 - all in the accepted');
console.log('          sub-$4.93 card zone, where the fee cannot fund Stripe and the');
console.log('          venue absorbs the shortfall by design.');

// Settlement identity: what the model says the venue gets === what Stripe transfers.
var settleBroken = 0;
for (var c2 = 1; c2 <= 50000; c2++) {
  for (var mj = 0; mj < methods.length; mj++) {
    var s = calcOCTLFees(c2 / 100, methods[mj]);
    var modelled = Math.round((s.faceValue + s.venueNet) * 100) / 100;
    var settled = Math.round((s.allInPrice - s.stripeFee - s.octlTake) * 100) / 100;
    if (!near(modelled, settled)) settleBroken++;
  }
}

if (settleBroken === 0) {
  console.log('   [ok] face + venueNet === allIn - stripe - octl  (model === settlement)');
} else {
  fail('settlement identity VIOLATED in ' + settleBroken + ' cases');
}

// -- 2. REGRESSION vs the business-model doc, Section 3.3 (card) -------------
// faceValue / serviceFeeGross / stripeFee / octlTake are asserted against the
// published table. venueNet is NOT asserted: the doc's venue column carries the
// same independent-rounding artifact v3 deliberately removes (its $100 row prints
// venue $1.68, yet 3.20 + 2.96 + 1.68 = $7.84 against its own $7.83 fee). v3
// prints the reconciling $1.67. The divergence is expected, and is printed rather
// than silenced.

console.log('');
console.log('2. REGRESSION vs document Section 3.3 (card)');

var doc = [
  { allIn: 29,  face: 26.36,  svc: 2.64, stripe: 1.14, octl: 1.50, venue: 0.00 },
  { allIn: 45,  face: 40.91,  svc: 4.09, stripe: 1.61, octl: 2.02, venue: 0.46 },
  { allIn: 50,  face: 45.45,  svc: 4.55, stripe: 1.75, octl: 2.14, venue: 0.66 },
  { allIn: 65,  face: 59.91,  svc: 5.09, stripe: 2.19, octl: 2.27, venue: 0.63 },
  { allIn: 70,  face: 64.52,  svc: 5.48, stripe: 2.33, octl: 2.37, venue: 0.78 },
  { allIn: 85,  face: 78.34,  svc: 6.66, stripe: 2.77, octl: 2.66, venue: 1.23 },
  { allIn: 100, face: 92.17,  svc: 7.83, stripe: 3.20, octl: 2.96, venue: 1.68 },
  { allIn: 125, face: 115.21, svc: 9.79, stripe: 3.92, octl: 3.45, venue: 2.42 }
];

// KNOWN, EXPECTED DIVERGENCES - asserted as such rather than quietly skipped:
//   $65    is INSIDE the frozen band. Its doc row predates the cliff fix (it
//          applies 8.5% to the whole price), so it is superseded by design.
//   $125   stripe: doc prints $3.92; 0.029 * 125 + 0.30 = $3.925 -> $3.93.
//          A rounding artifact in the doc, not a code defect.

var SUPERSEDED = { 65: 'inside frozen band - doc row predates the cliff fix' };
var DOC_ARTIFACT = { '125:stripe': 'doc $3.92 vs exact $3.925 -> $3.93' };

console.log('   AllIn  | face      | svc      | stripe   | octl     | venue (doc -> v3)');

doc.forEach(function (d) {
  var r = calcOCTLFees(d.allIn, 'card');

  if (SUPERSEDED[d.allIn]) {
    console.log('   $' + pad(d.allIn, 5) + '| SUPERSEDED - ' + SUPERSEDED[d.allIn]);
    console.log('          | v3: face ' + money(r.faceValue) + '  svc ' + money(r.serviceFeeGross) +
                '  octl ' + money(r.octlTake) + '  venue ' + money(r.venueNet) +
                '  (venue held flat at the $50 anchor - the point of the fix)');
    return;
  }

  var fields = [['face', 'faceValue'], ['svc', 'serviceFeeGross'],
                ['stripe', 'stripeFee'], ['octl', 'octlTake']];

  fields.forEach(function (f) {
    var docKey = f[0], resKey = f[1];
    if (near(r[resKey], d[docKey])) return;
    var artifact = DOC_ARTIFACT[d.allIn + ':' + docKey];
    if (artifact) {
      console.log('   [info] $' + d.allIn + ' ' + docKey + ': ' + artifact);
      return;
    }
    fail('$' + d.allIn + ' ' + docKey + ': expected ' + money(d[docKey]) + ', got ' + money(r[resKey]));
  });

  var note = (r.venueNet !== d.venue) ? '  <- reconciled (doc row self-inconsistent)' : '';
  console.log('   $' + pad(d.allIn, 5) + '| ' + pad(money(r.faceValue), 10) + '| ' +
              pad(money(r.serviceFeeGross), 9) + '| ' + pad(money(r.stripeFee), 9) + '| ' +
              pad(money(r.octlTake), 9) + '| ' + money(d.venue) + ' -> ' + money(r.venueNet) + note);
});

// -- 3. FROZEN BAND: venue net must be FLAT across $50.01-$65.00 -------------
console.log('');
console.log('3. FROZEN BAND ($50.01-$65.00) - venue net must be FLAT');

methods.forEach(function (m) {
  var anchor = calcOCTLFees(50, m).venueNet;
  var seen = {};
  for (var c = 5001; c <= 6500; c++) seen[calcOCTLFees(c / 100, m).venueNet] = true;
  var vals = Object.keys(seen);
  if (vals.length === 1 && near(Number(vals[0]), anchor)) {
    console.log('   [ok] ' + pad(m, 6) + ' venue net flat at ' + money(anchor) + ' across the whole band');
  } else {
    fail(m + ' venue net NOT flat: ' + vals.join(', ') + ' (anchor ' + money(anchor) + ')');
  }
});

// The $50 -> $50.01 cliff this band exists to fix.
var at50 = calcOCTLFees(50, 'card').venueNet;
var at5001 = calcOCTLFees(50.01, 'card').venueNet;
if (near(at50, at5001)) {
  console.log('   [ok] no cliff at the $50 boundary (' + money(at50) + ' -> ' + money(at5001) + ')');
} else {
  fail('cliff at the $50 boundary: ' + money(at50) + ' -> ' + money(at5001));
}

var v65 = calcOCTLFees(65, 'card');
var v66 = calcOCTLFees(66, 'card');
console.log('   [info] $65 -> $66 exit: venue ' + money(v65.venueNet) + ' -> ' + money(v66.venueNet) +
            ', OCTL ' + money(v65.octlTake) + ' -> ' + money(v66.octlTake) + ' (OCTL step is by design)');

// -- 4. paymentMethod NORMALIZATION -----------------------------------------
// The tickets table stores the string "Crypto Wallet". v2 compared === 'crypto',
// so that value fell through to CARD and was charged a Stripe fee it never paid.

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
// v2 threw; the chaotic_admin copy returned null; the venue copies had no guard.
// A throw inside checkout would have been uncaught.

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

// -- 6. The sub-$4.93 card zone (accepted, not a defect) ---------------------
// Confirms the model still equals settlement even where venueNet goes negative.

console.log('');
console.log('6. SUB-$4.93 CARD ZONE (accepted: "that is on the venue, not OCTL")');

[3, 4, 4.93, 10, 25, 33.31].forEach(function (p) {
  var r = calcOCTLFees(p, 'card');
  var venueTotal = Math.round((r.faceValue + r.venueNet) * 100) / 100;
  var settled = Math.round((p - r.stripeFee - r.octlTake) * 100) / 100;
  var ok = near(venueTotal, settled) ? 'ok' : 'MISMATCH';

  if (!near(venueTotal, settled)) fail('$' + p + ': venue total ' + money(venueTotal) +
                                       ' != settled ' + money(settled));

  console.log('   $' + pad(p, 6) + ' fee ' + pad(money(r.serviceFeeGross), 7) +
              '| stripe ' + money(r.stripeFee) +
              ' | OCTL ' + money(r.octlTake) +
              ' | venue net ' + pad(money(r.venueNet), 7) +
              '| venue total ' + pad(money(venueTotal), 8) +
              '= settled ' + pad(money(settled), 8) + '[' + ok + ']');
});

console.log('');
console.log('----------------------------------------------------------------------');
console.log(failures === 0
  ? 'ALL INVARIANTS HOLD - 0 failures'
  : failures + ' FAILURE(S)');

process.exit(failures === 0 ? 0 : 1);
