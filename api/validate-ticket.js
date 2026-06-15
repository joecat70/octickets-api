// api/validate-ticket.js
// Validates a scanned QR ticket payload (ticketId:totpCode) against Supabase.
// Performs TOTP verification using Node crypto — no external libraries needed.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── TOTP verification (RFC 6238 / HMAC-SHA1) ─────────────────────────────────
// Accepts current time step and ±1 step to account for clock drift and scan delay
function verifyTOTP(hexSeed, code) {
  const key       = Buffer.from(hexSeed, 'hex');
  const timeStep  = Math.floor(Date.now() / 1000 / 30);

  for(const step of [timeStep, timeStep - 1, timeStep + 1]) {
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

    if(String(otp).padStart(6, '0') === String(code).padStart(6, '0')) return true;
  }
  return false;
}

// ── Scan window constants ─────────────────────────────────────────────────────
// Scanning opens 2 hours before doors and closes 4 hours after doors.
// Adjust these if venues need a different window.
const SCAN_WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000; // 2 hours before doors
const SCAN_WINDOW_AFTER_MS  = 4 * 60 * 60 * 1000; // 4 hours after doors

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

  // ── Already scanned ───────────────────────────────────────────────────────
  if(ticket.status === 'scanned') {
    return res.status(200).json({
      valid:      false,
      reason:     'Already scanned — duplicate entry blocked',
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
  if(!ticket.totp_seed) {
    // No seed on record — legacy ticket or data issue — allow entry but flag it
    console.warn(`Ticket ${ticketId} has no totp_seed — allowing entry without TOTP check`);
  } else {
    const totpValid = verifyTOTP(ticket.totp_seed, totpCode);
    if(!totpValid) {
      return res.status(200).json({
        valid:  false,
        reason: 'QR code expired or invalid — ask guest to refresh their ticket',
      });
    }
  }

  // ── All checks passed — mark as scanned ──────────────────────────────────
  const scannedAt = new Date().toISOString();

  const { error: updateError } = await db
    .from('tickets')
    .update({ status: 'scanned', scanned_at: scannedAt })
    .eq('id', ticketId)
    .eq('status', 'valid'); // Safety: only update if still valid (prevents race condition)

  if(updateError) {
    console.error('Update error:', updateError);
    return res.status(500).json({ valid: false, reason: 'Failed to record scan' });
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
