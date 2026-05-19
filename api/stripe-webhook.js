// api/stripe-webhook.js
//
// Stripe sends a POST to this endpoint the moment a checkout.session.completed
// event fires — completely independent of what the buyer's browser does.
//
// This guarantees tickets are written to Supabase even if:
//   - The buyer's internet dropped after payment
//   - The browser was closed before the redirect completed
//   - The client-side return handler threw an error
//
// Idempotency: the hold records were inserted BEFORE Stripe checkout started.
// This handler UPDATEs those holds from 'held' → 'valid'. If the client-side
// return handler already ran first, this is a harmless repeat write.
// If this runs first, the client-side handler detects tickets are already
// 'valid' and skips the duplicate email.
//
// IMPORTANT: Vercel's body parser must be disabled for this route so that
// Stripe can verify its signature against the raw request bytes.
// The export below tells Vercel not to parse the body automatically.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── Vercel config: disable automatic body parsing ──────────────────────────
// Without this, req.body is a parsed object and stripe.webhooks.constructEvent()
// will always throw — it needs the raw Buffer to verify the signature.
export const config = { api: { bodyParser: false } };

// Supabase client using the SERVICE KEY (bypasses RLS) — webhook writes are
// server-authoritative and must not be blocked by row-level security policies.
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripeKey     = process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET; // whsec_... from Stripe dashboard

  if (!stripeKey || !webhookSecret) {
    console.error('stripe-webhook: missing env vars');
    return res.status(500).end();
  }

  const stripe = Stripe(stripeKey);

  // ── 1. Collect raw body bytes, then verify Stripe signature ───────────────
  // bodyParser is disabled via export config above, so we stream manually.
  // Stripe's constructEvent needs the exact raw bytes to verify the signature.
  let event;
  try {
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end',  ()    => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── 2. Only handle checkout.session.completed ──────────────────────────────
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true }); // ACK other events, do nothing
  }

  const session = event.data.object;

  // Must be paid — could be 'unpaid' for certain session modes
  if (session.payment_status !== 'paid') {
    console.log('Webhook: session not paid, skipping:', session.id);
    return res.status(200).json({ received: true });
  }

  const meta      = session.metadata || {};
  const sessionId = session.id;
  const email     = session.customer_email || session.customer_details?.email || meta.buyer_email || '';

  // Parse hold IDs — these are the ticket rows already in Supabase with status='held'
  const holdIds = meta.hold_ids
    ? meta.hold_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  if (!holdIds.length) {
    // No hold IDs means this was created before the webhook upgrade.
    // Log it and return — client-side handler is the only path for old sessions.
    console.warn('Webhook: no hold_ids in metadata for session', sessionId);
    return res.status(200).json({ received: true });
  }

  console.log(`Webhook: processing session ${sessionId} — ${holdIds.length} seat(s)`);

  try {
    const db          = getSupabase();
    const txHash      = 'stripe:' + sessionId;
    const buyerId     = 'stripe-' + sessionId.slice(-8);
    const buyerName   = meta.buyer_name   || '';
    const buyerPhone  = meta.buyer_phone  || '';
    const buyerZip    = meta.buyer_zip    || '';
    const ageRange    = meta.buyer_age_range || '';
    const referral    = meta.buyer_referral  || '';
    const optInEmail  = meta.opt_in_email === 'true';
    const optInSms    = meta.opt_in_sms   === 'true';
    const payment     = meta.payment      || 'Card';
    const wallet      = meta.wallet       || null;

    // ── 3. Check if tickets are already valid (client-side ran first) ─────────
    const { data: existingTickets } = await db
      .from('tickets')
      .select('id, status, totp_seed')
      .in('id', holdIds);

    const alreadyValid = existingTickets?.every(t => t.status === 'valid');

    if (alreadyValid) {
      // Client-side return handler already completed. Nothing to do.
      console.log('Webhook: tickets already valid (client ran first) —', sessionId);
      return res.status(200).json({ received: true });
    }

    // ── 4. Update holds → valid ────────────────────────────────────────────────
    // Generate TOTP seeds for any ticket that doesn't already have one.
    // (Tickets created after the HTML upgrade will have seeds from hold time;
    //  older holds won't — generate here as fallback.)
    for (const holdId of holdIds) {
      const existing = existingTickets?.find(t => t.id === holdId);
      const totpSeed = existing?.totp_seed || generateTotpSeed();

      const { error: updateErr } = await db
        .from('tickets')
        .update({
          status:      'valid',
          tx_hash:     txHash,
          buyer_id:    buyerId,
          buyer_email: email   || null,
          buyer_name:  buyerName || null,
          totp_seed:   totpSeed,
          payment,
          wallet:      wallet || null,
        })
        .eq('id', holdId);

      if (updateErr) {
        console.error(`Webhook: failed to update ticket ${holdId}:`, updateErr.message);
      }
    }

    // ── 5. Upsert buyer profile ────────────────────────────────────────────────
    if (email) {
      const { data: existing } = await db
        .from('buyers')
        .select('visit_count')
        .eq('email', email)
        .maybeSingle();

      await db.from('buyers').upsert({
        id:          buyerId,
        email,
        name:        buyerName  || null,
        phone:       buyerPhone || null,
        wallet:      wallet     || null,
        zip:         buyerZip   || null,
        age_range:   ageRange   || null,
        referral:    referral   || null,
        opt_in_email: optInEmail,
        opt_in_sms:   optInSms,
        visit_count:  (existing?.visit_count || 0) + 1,
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'email' });
    }

    // ── 6. Fetch completed tickets to send email ───────────────────────────────
    const { data: ticketRows } = await db
      .from('tickets')
      .select('id, event_id, event_name, tier_name, seat, seat_key, price, totp_seed, status')
      .in('id', holdIds);

    // ── 7. Send confirmation email via Resend ──────────────────────────────────
    if (email && ticketRows?.length) {
      await sendTicketEmail({
        tickets: ticketRows,
        email,
        name:    buyerName || 'Guest',
        phone:   buyerPhone || null,
        txHash,
        sessionId,
      });
    }

    console.log(`Webhook: ✓ ${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook processing error:', err);
    // Always return 200 to Stripe — returning 5xx causes Stripe to retry
    // indefinitely, which could cause duplicate writes on transient errors.
    // Log the error and investigate via Stripe dashboard instead.
    return res.status(200).json({ received: true, warning: 'Processing error logged' });
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateTotpSeed() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function sendTicketEmail({ tickets, email, name, txHash, sessionId }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.warn('Webhook: RESEND_API_KEY not set — skipping email'); return; }

  const ticketLines = tickets.map(t =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">${t.event_name || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">${t.seat || t.seat_key || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">${t.tier_name || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right">$${(t.price||0).toFixed(2)}</td>
    </tr>`
  ).join('');

  // Build QR URLs for each ticket using TOTP seeds
  const qrBlocks = tickets.map(t => {
    const qrData = encodeURIComponent(JSON.stringify({ id: t.id, seed: t.totp_seed }));
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${qrData}`;
    return `
      <div style="margin:16px 0;text-align:center">
        <p style="margin:0 0 8px;font-size:13px;color:#aaa">${t.seat || t.seat_key}</p>
        <img src="${qrUrl}" width="160" height="160" alt="QR Code" style="border-radius:8px"/>
        <p style="margin:6px 0 0;font-size:11px;color:#666">Ticket ID: ${t.id}</p>
      </div>`;
  }).join('');

  const html = `
    <div style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;max-width:600px;margin:0 auto;border-radius:12px;overflow:hidden">
      <div style="background:#C9A84C;padding:24px 32px">
        <h1 style="margin:0;font-size:22px;color:#000">🎟 Your Tickets Are Confirmed</h1>
      </div>
      <div style="padding:28px 32px">
        <p style="margin:0 0 20px">Hi ${name},<br><br>
          Your purchase is complete. Present the QR code(s) below at the door.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#1a1a1a;color:#C9A84C">
              <th style="padding:8px 12px;text-align:left">Event</th>
              <th style="padding:8px 12px;text-align:left">Seat</th>
              <th style="padding:8px 12px;text-align:left">Tier</th>
              <th style="padding:8px 12px;text-align:right">Price</th>
            </tr>
          </thead>
          <tbody>${ticketLines}</tbody>
        </table>
        ${qrBlocks}
        <p style="margin:24px 0 0;font-size:12px;color:#666">
          Order ref: ${sessionId}<br>
          Can't find your tickets? Visit the site and use "Can't find your tickets?" to resend.
        </p>
      </div>
    </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    'OC Tickets Live <tickets@octicketslive.com>',
        to:      [email],
        subject: `Your tickets — ${tickets[0]?.event_name || 'OC Tickets Live'}`,
        html,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('Webhook: Resend error:', err);
    } else {
      console.log('Webhook: confirmation email sent to', email);
    }
  } catch (err) {
    console.error('Webhook: email send failed:', err.message);
  }
}
