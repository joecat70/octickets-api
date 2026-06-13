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

  // ── Refunded / cancelled ──────────────────────────────────────────────────
  if(['refunded', 'cancelled', 'held'].includes(ticket.status)) {
    return res.status(200).json({
      valid:  false,
      reason: `Ticket is ${ticket.status} — entry not permitted`,
    });
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
