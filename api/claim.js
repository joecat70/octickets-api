// api/claim.js
// Magic link claim handler — device token binding + OTP verification for new devices.
//
// GET  ?token=xxx                    — first claim or same-device re-access
// GET  ?token=xxx&device_token=yyy   — re-access attempt with stored device token
// GET  ?action=send_otp&token=xxx    — trigger OTP SMS to buyer's phone
// POST { token, otp }                — verify OTP, issue new device token

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports.config = { api: { bodyParser: true } };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
}

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskPhone(phone) {
  if (!phone) return 'your phone';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) {
    return '(***) ***-' + digits.slice(-4);
  }
  return phone.slice(0, 2) + '****' + phone.slice(-2);
}

async function sendOTPviaTwilio(to, code) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    console.warn('claim.js: Twilio env vars not set — OTP not sent');
    return false;
  }

  const body = `Your OC Tickets Live verification code is: ${code}. Valid for 10 minutes.`;
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });

  const data = await res.json();
  if (data.sid) {
    console.log('claim.js: OTP sent via Twilio —', data.sid);
    return true;
  }
  console.error('claim.js: Twilio error —', data);
  return false;
}

async function loadTicketsForClaim(db, claimRow) {
  const primaryTicketId = claimRow.ticket_id;

  const { data: primary } = await db
    .from('tickets')
    .select('tx_hash, id, event_id, event_name, seat, seat_key, tier_name, tier_id, price, payment, status, purchased_at, wallet, totp_seed')
    .eq('id', primaryTicketId)
    .maybeSingle();

  if (!primary) return null;

  let tickets = [primary];

  if (primary.tx_hash) {
    const { data: siblings } = await db
      .from('tickets')
      .select('id, event_id, event_name, seat, seat_key, tier_name, tier_id, price, payment, status, purchased_at, wallet, totp_seed, tx_hash')
      .eq('tx_hash', primary.tx_hash)
      .neq('id', primaryTicketId);

    if (siblings?.length) tickets = [primary, ...siblings];
  }

  return tickets;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = getSupabase();

    // ── POST — verify OTP and issue new device token ───────────────────────
    if (req.method === 'POST') {
      const { token, otp } = req.body || {};
      if (!token || !otp) return res.status(400).json({ error: 'Missing token or otp' });

      const { data: claimRow, error } = await db
        .from('claim_tokens')
        .select('*')
        .eq('token', token)
        .maybeSingle();

      if (error || !claimRow) return res.status(404).json({ error: 'Invalid claim token' });
      if (new Date(claimRow.expires_at) < new Date()) return res.status(410).json({ error: 'Claim link has expired' });

      if (!claimRow.otp_code || claimRow.otp_code !== String(otp).trim()) {
        return res.status(401).json({ error: 'Incorrect code. Please try again.' });
      }
      if (!claimRow.otp_expires_at || new Date(claimRow.otp_expires_at) < new Date()) {
        return res.status(401).json({ error: 'Code has expired. Please request a new one.' });
      }

      const newDeviceToken = generateToken();
      await db.from('claim_tokens').update({
        claimed:          true,
        claimed_at:       new Date().toISOString(),
        device_token:     newDeviceToken,
        otp_code:         null,
        otp_expires_at:   null,
        reaccess_count:   (claimRow.reaccess_count || 0) + 1,
        last_reaccess_at: new Date().toISOString(),
      }).eq('token', token);

      const tickets = await loadTicketsForClaim(db, claimRow);
      if (!tickets) return res.status(404).json({ error: 'Tickets not found' });

      return res.status(200).json({
        success:      true,
        device_token: newDeviceToken,
        tickets,
        ticket:       tickets[0],
        phone:        claimRow.phone,
      });
    }

    // ── GET ────────────────────────────────────────────────────────────────
    const { token, device_token, action } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const { data: claimRow, error } = await db
      .from('claim_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error || !claimRow) return res.status(404).json({ error: 'Invalid claim token' });
    if (new Date(claimRow.expires_at) < new Date()) return res.status(410).json({ error: 'Claim link has expired' });

    // ── GET ?action=send_otp ───────────────────────────────────────────────
    if (action === 'send_otp') {
      const phone = claimRow.phone;
      if (!phone) return res.status(400).json({ error: 'No phone number on record for this claim' });

      const otp       = generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await db.from('claim_tokens').update({
        otp_code:       otp,
        otp_expires_at: expiresAt,
      }).eq('token', token);

      const sent = await sendOTPviaTwilio(phone, otp);
      if (!sent) {
        if (process.env.NODE_ENV !== 'production') {
          return res.status(200).json({ sent: true, devotp: otp });
        }
        return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
      }

      return res.status(200).json({ sent: true });
    }

    // ── GET ?token=xxx — first claim or re-access ─────────────────────────
    if (device_token && claimRow.device_token && device_token === claimRow.device_token) {
      await db.from('claim_tokens').update({
        reaccess_count:   (claimRow.reaccess_count || 0) + 1,
        last_reaccess_at: new Date().toISOString(),
      }).eq('token', token);

      const tickets = await loadTicketsForClaim(db, claimRow);
      if (!tickets) return res.status(404).json({ error: 'Tickets not found' });

      return res.status(200).json({
        success:      true,
        device_token: claimRow.device_token,
        tickets,
        ticket:       tickets[0],
        phone:        claimRow.phone,
      });
    }

    if (claimRow.claimed && claimRow.device_token) {
      return res.status(200).json({
        requiresVerification: true,
        maskedPhone: maskPhone(claimRow.phone),
      });
    }

    // First claim
    const newDeviceToken = generateToken();
    await db.from('claim_tokens').update({
      claimed:      true,
      claimed_at:   new Date().toISOString(),
      device_token: newDeviceToken,
    }).eq('token', token);

    const tickets = await loadTicketsForClaim(db, claimRow);
    if (!tickets) return res.status(404).json({ error: 'Tickets not found' });

    console.log(`claim.js: ✓ first claim — token ${token.slice(0, 8)}… — ${tickets.length} ticket(s)`);

    return res.status(200).json({
      success:      true,
      device_token: newDeviceToken,
      tickets,
      ticket:       tickets[0],
      phone:        claimRow.phone,
    });

  } catch (err) {
    console.error('claim.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
