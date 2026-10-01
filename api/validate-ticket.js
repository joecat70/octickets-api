// api/validate-ticket.js
// Validates a scanned QR ticket payload (ticketId:totpCode) against Supabase.
// Performs TOTP verification using Node crypto — no external libraries needed.
//
// FIX (2026-08-28): comp/reserved tickets could be scanned an unlimited
// number of times. Root cause: the final "mark as scanned" update guarded
// against a race condition by matching `.eq('status', 'valid')` — but
// comp/reserved tickets never have status='valid' (their real status is
// literally 'comp' or 'reserved', confirmed directly against
// bailey_hall_admin_v1_18.html's issueComp()/issueHeldSeats()). That guard
// silently matched zero rows for every comp/reserved ticket, so the status
// never actually flipped to 'scanned' — but only `error` was checked, never
// the affected-row count, so the endpoint still returned valid:true every
// time. The "already scanned — duplicate entry blocked" check earlier in
// this file could therefore never trigger for a comp/reserved ticket, since
// its status was never anything but 'comp'/'reserved' to begin with. This
// went live-relevant the moment bailey_hall_v1_2.html widened its QR-draw
// gate to actually render QR codes for comp/reserved tickets — before that,
// there was no QR to scan, so the bug was latent rather than exploitable.
// Fix: match the update against the ticket's own current status (whatever
// admissible value it had when read above — 'valid', 'comp', or 'reserved')
// instead of hardcoding 'valid', and check the actual returned row(s), not
// just `error`. A zero-row result now fails closed instead of reporting a
// false VALID.
//
// v2 (2026-09-30, Joe) — MULTI-ADMIT TABLES. A table ticket ("... (admits 4)") is one ticket with one QR,
// but a party rarely arrives together. Before: the first scan marked the whole ticket 'scanned' and
// everyone arriving later was turned away. Now: each scan admits part of the party and the ticket stays
// valid until all of them are in; only then does it flip to 'scanned'.
//   - The party size is read from the ticket's own label, "(admits N)", the same text the door screen
//     already shows. A ticket without one (every seat, GA and bar ticket, and every ticket at every
//     other venue) has a party size of 1 and runs the original code path below, unchanged: same
//     queries, same responses.
//   - Progress is kept in two NEW columns on tickets (run the admitted_count migration first):
//       admitted_count  integer, how many of the party are in
//       last_totp_step  bigint,  the 30-second code window of the most recent admission
//     They are read and written ONLY for multi-admit tickets, so a party-of-1 scan never touches them.
//   - Each admission must come from a NEW code. The QR refreshes every 30 seconds, so a code that was
//     already used cannot admit a second person (this also stops a scanner that is still pointed at the
//     same phone from admitting extra guests). Door staff can instead admit several at once by sending
//     admitCount (1 by default); it is capped at the number still to come.
//   - The response keeps every existing field and adds admitted, partySize, admittedNow, remaining and
//     complete. For a multi-admit ticket, ticket.seat in a VALID response has "(admits N)" rewritten to
//     the number admitted by THIS scan, so a door screen that has not been updated yet shows "Admit 1"
//     rather than "Admit 4". The untouched label is in ticket.seatFull.
//   - If the two columns do not exist yet, a multi-admit scan fails closed with a clear message; every
//     other ticket keeps working.
//
// v3 (2026-10-01, Joe) — 15-SECOND QR CODES. A table of 8 where every guest scans separately had to wait up to
// 30 seconds between admissions for a fresh code. The code check now accepts a code made with EITHER a 30-second
// or a 15-second period (each with the same one-step tolerance either side). Every ticket page that exists today
// draws 30-second codes and keeps working untouched; the Krazy Mike's page switches to 15 seconds from its own
// next version. Deploy this file first, then publish that page.
//   - Because the two periods have different step numbers, last_totp_step now stores the START TIME, in epoch
//     seconds, of the 30- or 15-second window that admitted the last guest, so the "a code admits once" rule
//     compares like with like. A value written by v2 (a 30-second step number, always under 1,000,000,000) is
//     read as step * 30, so tables already part-admitted keep their place. No new migration is needed.
//   - Cost: at any instant six codes are acceptable instead of three (still about 6 in a million per guess, and
//     a guess also needs the ticket id). A party-of-1 ticket is otherwise untouched.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── TOTP verification (RFC 6238 / HMAC-SHA1) ─────────────────────────────────
// Accepts the current time step and ±1 step to account for clock drift and scan delay, for a code made with
// either period in TOTP_PERIODS (seconds). matchTOTP returns the START TIME (epoch seconds) of the window the
// code belongs to, or -1 when it matches none; larger means newer, whichever period it came from.
const TOTP_PERIODS = [30, 15];   // 30: every ticket page built before Oct 2026. 15: Krazy Mike's from its public v1.7.

function otpFor(key, step) {
  const counter = Buffer.alloc(8);
  let t = step;
  for(let i = 7; i >= 0; i--) {
    counter[i] = t & 0xff;
    t = Math.floor(t / 256);
  }

  const hmac   = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[19] & 0xf;
  const otp    = (
    ((hmac[offset]   & 0x7f) << 24) |
    ((hmac[offset+1] & 0xff) << 16) |
    ((hmac[offset+2] & 0xff) <<  8) |
     (hmac[offset+3] & 0xff)
  ) % 1_000_000;
  return String(otp).padStart(6, '0');
}

function matchTOTP(hexSeed, code) {
  const key  = Buffer.from(hexSeed, 'hex');
  const want = String(code).padStart(6, '0');
  for(const period of TOTP_PERIODS) {
    const timeStep = Math.floor(Date.now() / 1000 / period);
    for(const step of [timeStep, timeStep - 1, timeStep + 1]) {
      if(otpFor(key, step) === want) return step * period;
    }
  }
  return -1;
}
// Same answer as before for callers that only need yes / no.
function verifyTOTP(hexSeed, code) { return matchTOTP(hexSeed, code) !== -1; }

// ── Scan window constants ─────────────────────────────────────────────────────
// Scanning opens 2 hours before doors and closes 4 hours after doors.
// Adjust these if venues need a different window.
const SCAN_WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000; // 2 hours before doors
const SCAN_WINDOW_AFTER_MS  = 4 * 60 * 60 * 1000; // 4 hours after doors

// ── Multi-admit tables ───────────────────────────────────────────────────────
// "Table For 6 People - Table 2 (admits 6)" -> 6. Anything without that text is a single admission.
function partySizeOf(seatText) {
  const m = /\(admits (\d+)\)/i.exec(String(seatText || ''));
  const n = m ? parseInt(m[1], 10) : 1;
  return (Number.isFinite(n) && n > 1) ? n : 1;
}

async function admitTable({ db, res, ticket, ticketId, partySize, matchedStep, requested }) {
  // Progress columns are read only here, so a party-of-1 scan never depends on them.
  const { data: prog, error: progErr } = await db
    .from('tickets')
    .select('admitted_count, last_totp_step')
    .eq('id', ticketId)
    .maybeSingle();

  if(progErr || !prog) {
    console.error(`validate-ticket: multi-admit progress read failed for ${ticketId}:`, progErr && progErr.message);
    return res.status(500).json({
      valid:  false,
      reason: 'Table admission tracking is not set up on the database yet — run the admitted_count migration',
    });
  }

  const admittedBefore = Number.isFinite(Number(prog.admitted_count)) ? Number(prog.admitted_count) : 0;
  const progress = (admitted) => ({ admitted, partySize, remaining: Math.max(0, partySize - admitted) });

  if(admittedBefore >= partySize) {
    return res.status(200).json({
      valid:  false,
      reason: `Already scanned — all ${partySize} guests on this table have been admitted`,
      ...progress(admittedBefore),
      ticket: { id: ticket.id, seat: ticket.seat },
    });
  }

  // A code that already admitted someone cannot admit anyone else. The next one appears within 15 or 30 seconds.
  // last_totp_step holds the start time (epoch seconds) of the last admitting window; v2 stored a 30-second step number.
  const lastRaw   = (prog.last_totp_step === null || prog.last_totp_step === undefined) ? NaN : Number(prog.last_totp_step);
  const lastStart = Number.isFinite(lastRaw) ? (lastRaw < 1e9 ? lastRaw * 30 : lastRaw) : null;
  if(matchedStep !== null && lastStart !== null && matchedStep <= lastStart) {
    return res.status(200).json({
      valid:  false,
      reason: 'This code was already used for an admission — ask the guest to wait a few seconds for the QR to refresh, or admit several people with one scan',
      ...progress(admittedBefore),
      ticket: { id: ticket.id, seat: ticket.seat },
    });
  }

  let want = parseInt(requested, 10);
  if(!Number.isFinite(want) || want < 1) want = 1;
  const admitNow       = Math.min(want, partySize - admittedBefore);
  const admittedAfter  = admittedBefore + admitNow;
  const complete       = admittedAfter >= partySize;
  const scannedAt      = new Date().toISOString();

  const patch = { admitted_count: admittedAfter, scanned_at: scannedAt };
  if(matchedStep !== null) patch.last_totp_step = matchedStep;
  if(complete) patch.status = 'scanned';   // everyone is in: from here on it behaves like any scanned ticket

  // Only apply if nothing changed since we read it (status and count), and check the rows returned, not just `error`.
  const { data: updated, error: updateError } = await db
    .from('tickets')
    .update(patch)
    .eq('id', ticketId)
    .eq('status', ticket.status)
    .eq('admitted_count', admittedBefore)
    .select('id');

  if(updateError) {
    console.error('Update error:', updateError);
    return res.status(500).json({ valid: false, reason: 'Failed to record scan' });
  }

  if(!updated || updated.length === 0) {
    console.warn(`validate-ticket: zero-row update for table ${ticketId} (expected status '${ticket.status}', admitted ${admittedBefore}) — race condition, failing closed`);
    return res.status(200).json({
      valid:  false,
      reason: 'Scan could not be completed — ticket status changed during validation. Try scanning again.',
    });
  }

  console.log(`✓ Admitted ${admitNow} (${admittedAfter}/${partySize}): ${ticketId} · ${ticket.seat} · ${scannedAt}`);

  return res.status(200).json({
    valid:       true,
    scannedAt:   scannedAt,
    ...progress(admittedAfter),
    admittedNow: admitNow,
    complete,
    ticket: {
      id:       ticket.id,
      // Door screens that read "(admits N)" from the label show how many to let in for THIS scan.
      seat:     String(ticket.seat).replace(/\(admits \d+\)/i, `(admits ${admitNow})`),
      seatFull: ticket.seat,
      seatKey:  ticket.seat_key,
      eventId:  ticket.event_id,
      buyerId:  ticket.buyer_id,
    },
  });
}

module.exports = async function handler(req, res) {
  // Preflight
  if(req.method === 'OPTIONS') {
    return res.writeHead(204, CORS).end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if(req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, eventId } = req.body || {};

  if(!token || typeof token !== 'string') {
    return res.status(400).json({ valid: false, reason: 'Missing scan token' });
  }

  // ── Parse payload — format: "TICKETID:TOTPCODE" ───────────────────────────
  // Split on the LAST colon so ticket IDs containing colons are handled safely
  const lastColon = token.lastIndexOf(':');
  if(lastColon === -1) {
    return res.status(400).json({ valid: false, reason: 'Invalid QR format' });
  }

  const ticketId = token.slice(0, lastColon).trim();
  const totpCode = token.slice(lastColon + 1).trim();

  if(!ticketId || !totpCode) {
    return res.status(400).json({ valid: false, reason: 'Invalid QR payload' });
  }

  // ── Supabase lookup ───────────────────────────────────────────────────────
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: ticket, error } = await db
    .from('tickets')
    .select('id, status, event_id, seat, seat_key, totp_seed, scanned_at, buyer_id')
    .eq('id', ticketId)
    .maybeSingle();

  if(error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ valid: false, reason: 'Database error' });
  }

  // ── Ticket not found ──────────────────────────────────────────────────────
  if(!ticket) {
    return res.status(200).json({
      valid:  false,
      reason: 'Ticket not found — not issued on this platform',
    });
  }

  // Party size from the ticket's own label (1 for everything except tables).
  const partySize = partySizeOf(ticket.seat);

  // ── Already scanned ───────────────────────────────────────────────────────
  if(ticket.status === 'scanned') {
    return res.status(200).json({
      valid:      false,
      reason:     partySize > 1
        ? `Already scanned — all ${partySize} guests on this table have been admitted`
        : 'Already scanned — duplicate entry blocked',
      scannedAt:  ticket.scanned_at,
      ticket: {
        id:   ticket.id,
        seat: ticket.seat,
      },
    });
  }

  // ── Refunded / cancelled / held ───────────────────────────────────────────
  if(['refunded', 'cancelled', 'held'].includes(ticket.status)) {
    return res.status(200).json({
      valid:  false,
      reason: `Ticket is ${ticket.status} — entry not permitted`,
    });
  }

  // ── ZeroScalp transfer hold ───────────────────────────────────────────────
  // ticket.status === 'transfer_pending' means an exception transfer has been
  // approved. The original holder cannot use this ticket for entry until the
  // transfer is either completed (→ 'transferred') or denied (→ 'valid').
  if(ticket.status === 'transfer_pending') {
    return res.status(200).json({
      valid:         false,
      ticket_status: 'transfer_pending',
      reason:        'Transfer hold — this ticket has an approved exception transfer in progress and cannot be used for entry',
      ticket: {
        id:   ticket.id,
        seat: ticket.seat,
      },
    });
  }

  // ── Permanently transferred ───────────────────────────────────────────────
  if(ticket.status === 'transferred') {
    return res.status(200).json({
      valid:  false,
      reason: 'Ticket has been transferred — this QR code is no longer valid',
    });
  }

  // ── Scan window check ─────────────────────────────────────────────────────
  // Query event_config for doors_open. If configured, only allow scans within
  // the window: [doors_open - 2hrs] through [doors_open + 4hrs].
  // If doors_open is not configured, scanning is allowed at any time (fail-open
  // so misconfigured events don't accidentally lock out valid ticket holders).
  const resolvedEventId = ticket.event_id || eventId;
  if(resolvedEventId) {
    try {
      const { data: config } = await db
        .from('event_config')
        .select('doors_open')
        .eq('event_id', resolvedEventId)
        .maybeSingle();

      if(config?.doors_open) {
        const now         = Date.now();
        const doorsOpen   = new Date(config.doors_open).getTime();
        const windowOpen  = doorsOpen - SCAN_WINDOW_BEFORE_MS;
        const windowClose = doorsOpen + SCAN_WINDOW_AFTER_MS;

        if(now < windowOpen) {
          // Too early — scanning not yet open
          const opensAt = new Date(windowOpen).toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          });
          return res.status(200).json({
            valid:  false,
            reason: `Scanning not open yet — door scanning opens at ${opensAt}`,
          });
        }

        if(now > windowClose) {
          // Too late — scanning window has closed
          return res.status(200).json({
            valid:  false,
            reason: 'Scanning window has closed for this event',
          });
        }
      }
      // No doors_open configured — fail-open, allow scan
    } catch(configErr) {
      // Non-fatal — log and continue rather than blocking valid ticket holders
      console.warn(`validate-ticket: event_config lookup failed for ${resolvedEventId}:`, configErr.message);
    }
  }

  // ── Event mismatch (if scanner has event selected) ────────────────────────
  if(eventId && ticket.event_id !== eventId) {
    return res.status(200).json({
      valid:  false,
      reason: 'Wrong event — ticket is not valid for this show',
    });
  }

  // ── TOTP validation ───────────────────────────────────────────────────────
  let matchedStep = null;   // start time (epoch seconds) of the 30- or 15-second window this code belongs to (only used for multi-admit tables)
  if(!ticket.totp_seed) {
    // No seed on record — legacy ticket or data issue — allow entry but flag it
    console.warn(`Ticket ${ticketId} has no totp_seed — allowing entry without TOTP check`);
  } else {
    matchedStep = matchTOTP(ticket.totp_seed, totpCode);
    const totpValid = matchedStep !== -1;
    if(!totpValid) {
      return res.status(200).json({
        valid:  false,
        reason: 'QR code expired or invalid — ask guest to refresh their ticket',
      });
    }
  }

  // ── Table with a party: admit part of it and keep the ticket valid until all are in ──
  if(partySize > 1) {
    return admitTable({ db, res, ticket, ticketId, partySize, matchedStep, requested: (req.body || {}).admitCount });
  }

  // ── All checks passed — mark as scanned ──────────────────────────────────
  // At this point ticket.status is one of the admissible values that made it
  // past every check above: 'valid', 'comp', or 'reserved'. Match the update
  // against that actual current status (not a hardcoded 'valid') so the
  // race-condition guard works uniformly for every admissible status instead
  // of silently no-op'ing for comp/reserved. Also check the rows actually
  // returned, not just `error` — a zero-row match means another scan (or
  // some other status change) won the race between the read above and this
  // update, and must fail closed rather than report a false VALID.
  const scannedAt = new Date().toISOString();

  const { data: updated, error: updateError } = await db
    .from('tickets')
    .update({ status: 'scanned', scanned_at: scannedAt })
    .eq('id', ticketId)
    .eq('status', ticket.status) // only flip if status hasn't changed since we read it
    .select('id');

  if(updateError) {
    console.error('Update error:', updateError);
    return res.status(500).json({ valid: false, reason: 'Failed to record scan' });
  }

  if(!updated || updated.length === 0) {
    console.warn(`validate-ticket: zero-row update for ${ticketId} (expected status '${ticket.status}') — race condition, failing closed`);
    return res.status(200).json({
      valid:  false,
      reason: 'Scan could not be completed — ticket status changed during validation. Try scanning again.',
    });
  }

  console.log(`✓ Admitted: ${ticketId} · ${ticket.seat} · ${scannedAt}`);

  return res.status(200).json({
    valid:     true,
    scannedAt: scannedAt,
    ticket: {
      id:       ticket.id,
      seat:     ticket.seat,
      seatKey:  ticket.seat_key,
      eventId:  ticket.event_id,
      buyerId:  ticket.buyer_id,
    },
  });
};
