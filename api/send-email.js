// api/stripe-webhook.js
// Stripe server-side webhook — confirms tickets on checkout.session.completed.
// Calls /api/send-email for ticket delivery (same template as client path).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// Disable Vercel's default body parser — Stripe needs the raw body to verify signature
module.exports.config = { api: { bodyParser: false } };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
}

// Resolve our own Vercel API base URL for internal fetch to /api/send-email.
// VERCEL_URL is injected automatically by Vercel (no https:// prefix).
// Override with API_BASE_URL env var if you need a fixed URL.
function getApiBase() {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_URL)   return `https://${process.env.VERCEL_URL}`;
  return 'https://octickets-api.vercel.app'; // known fallback
}

function generateTotpSeed() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripeKey     = process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    console.error('stripe-webhook: missing env vars');
    return res.status(500).end();
  }

  const stripe = Stripe(stripeKey);

  // ── 1. Verify Stripe signature ─────────────────────────────────────────────
  let event;
  try {
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  if (session.payment_status !== 'paid') {
    console.log('Webhook: session not paid, skipping:', session.id);
    return res.status(200).json({ received: true });
  }

  // ── 2. Parse metadata ──────────────────────────────────────────────────────
  const meta      = session.metadata || {};
  const sessionId = session.id;
  const email     = session.customer_email
                 || session.customer_details?.email
                 || meta.buyer_email
                 || '';

  const holdIds = meta.hold_ids
    ? meta.hold_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  if (!holdIds.length) {
    console.warn('Webhook: no hold_ids in metadata for session', sessionId);
    return res.status(200).json({ received: true });
  }

  console.log(`Webhook: processing session ${sessionId} — ${holdIds.length} seat(s)`);

  try {
    const db = getSupabase();

    const txHash    = 'stripe:' + sessionId;
    const buyerId   = 'stripe-' + sessionId.slice(-8);
    const buyerName = meta.buyer_name    || '';
    const buyerPhone= meta.buyer_phone   || '';
    const buyerZip  = meta.buyer_zip     || '';
    const ageRange  = meta.buyer_age_range || '';
    const referral  = meta.buyer_referral  || '';
    const optInEmail= meta.opt_in_email === 'true';
    const optInSms  = meta.opt_in_sms   === 'true';
    const payment   = meta.payment       || 'Card';
    const wallet    = meta.wallet        || null;
    const eventName = meta.event_name    || '';
    const venueUrl  = meta.venue_url     || 'https://octicketslive.eth.limo';

    // ── 3. Idempotency check — skip if client path already confirmed ───────
    const { data: existingTickets } = await db
      .from('tickets')
      .select('id, status, totp_seed, seat, seat_key')
      .in('id', holdIds);

    const alreadyValid = existingTickets?.every(t => t.status === 'valid');
    if (alreadyValid) {
      console.log('Webhook: tickets already valid (client ran first) —', sessionId);
      return res.status(200).json({ received: true });
    }

    // ── 4. Confirm tickets — update holds → valid ──────────────────────────
    // Use Promise.all for parallel updates instead of sequential loop
    await Promise.all(holdIds.map(async holdId => {
      const existing  = existingTickets?.find(t => t.id === holdId);
      const totpSeed  = existing?.totp_seed || generateTotpSeed();

      const { error: updateErr } = await db
        .from('tickets')
        .update({
          status:      'valid',
          tx_hash:     txHash,
          buyer_id:    buyerId,
          buyer_email: email     || null,
          buyer_name:  buyerName || null,
          totp_seed:   totpSeed,
          payment,
          wallet:      wallet    || null,
        })
        .eq('id', holdId);

      if (updateErr) {
        console.error(`Webhook: failed to update ticket ${holdId}:`, updateErr.message);
      }
    }));

    // ── 5. Upsert buyer profile ────────────────────────────────────────────
    if (email) {
      const { data: existing } = await db
        .from('buyers')
        .select('visit_count')
        .eq('email', email)
        .maybeSingle();

      await db.from('buyers').upsert({
        id:           buyerId,
        email,
        name:         buyerName  || null,
        phone:        buyerPhone || null,
        wallet:       wallet     || null,
        zip:          buyerZip   || null,
        age_range:    ageRange   || null,
        referral:     referral   || null,
        opt_in_email: optInEmail,
        opt_in_sms:   optInSms,
        visit_count:  (existing?.visit_count || 0) + 1,
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'email' });
    }

    // ── 6. Send ticket email via /api/send-email (shared template) ─────────
    if (email) {
      const { data: ticketRows } = await db
        .from('tickets')
        .select('id, seat, seat_key, event_name, tier_name, price')
        .in('id', holdIds);

      const seats     = (ticketRows || []).map(t => t.seat || t.seat_key || '');
      const resolvedEventName = eventName
                             || ticketRows?.[0]?.event_name
                             || '';

      const apiBase = getApiBase();

      try {
        const emailRes = await fetch(`${apiBase}/api/send-email`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            name:      buyerName || 'Guest',
            ticketIds: holdIds,
            ticketId:  holdIds[0],
            seats,
            seat:      seats[0] || '',
            seatCount: holdIds.length,
            eventName: resolvedEventName,
            venueUrl,
          }),
        });
        const emailData = await emailRes.json();
        if (emailData.success) {
          console.log(`Webhook: ✓ email sent to ${email} for ${holdIds.length} ticket(s)`);
        } else {
          console.warn('Webhook: send-email returned error:', emailData.error);
        }
      } catch (emailErr) {
        console.error('Webhook: send-email fetch failed:', emailErr.message);
        // Non-fatal — ticket is confirmed in DB regardless
      }
    }

    console.log(`Webhook: ✓ ${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook processing error:', err);
    // Always return 200 so Stripe doesn't retry endlessly
    return res.status(200).json({ received: true, warning: 'Processing error logged' });
  }
};
