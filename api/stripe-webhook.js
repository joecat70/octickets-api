// ============================================================
// /api/stripe-webhook.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// Concert venue webhook — handles checkout.session.completed
// for reserved seating purchases across all OCTL venues.
//
// Flow:
//   1. Verify Stripe signature
//   2. Guard: skip bowling sessions (venue_type === 'bowling')
//   3. Confirm payment_status === 'paid'
//   4. Hold-based path: update held tickets → 'valid'
//   5. Upsert buyer record
//   6. Send confirmation email via /api/send (type: email)
//   7. Idempotency: if tickets already valid, skip quietly
// ============================================================

const Stripe           = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: false } };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
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

  // ── 1. Verify Stripe signature ──────────────────────────────────────────────
  let event;
  try {
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Only process completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const meta    = session.metadata || {};

  // ── 2. Guard: skip bowling sessions ────────────────────────────────────────
  // Octix sets venue_type: 'bowling' — OCTL sessions have no venue_type marker
  if (meta.venue_type === 'bowling') {
    console.log('Webhook: bowling session — skipping (not an OCTL concert session):', session.id);
    return res.status(200).json({ received: true });
  }

  // ── 3. Confirm payment ─────────────────────────────────────────────────────
  if (session.payment_status !== 'paid') {
    console.log('Webhook: session not paid, skipping:', session.id);
    return res.status(200).json({ received: true });
  }

  const sessionId  = session.id;
  const email      = session.customer_email || session.customer_details?.email || meta.buyer_email || '';
  const txHash     = 'stripe:' + sessionId;
  const buyerId    = 'stripe-' + sessionId.slice(-8);
  const buyerName  = meta.buyer_name    || '';
  const buyerPhone = meta.buyer_phone   || '';
  const buyerZip   = meta.buyer_zip     || '';
  const ageRange   = meta.buyer_age_range || '';
  const referral   = meta.buyer_referral  || '';
  const optInEmail = meta.opt_in_email === 'true';
  const optInSms   = meta.opt_in_sms   === 'true';
  const payment    = meta.payment       || 'Card';
  const wallet     = meta.wallet        || null;
  const venueUrl   = meta.venue_url     || 'https://theetestsite.eth.limo';
  const holdIds    = meta.hold_ids
    ? meta.hold_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  console.log(`Webhook: session ${sessionId} — holdIds=${holdIds.length}, email=${email}`);

  try {
    const db = getSupabase();

    // ── 4. Hold-based path ──────────────────────────────────────────────────
    if (holdIds.length) {

      // Idempotency — if all tickets already valid, webhook or client got here first
      const { data: existingTickets } = await db
        .from('tickets')
        .select('id, status, totp_seed, seat, seat_key, event_name, price, stripe_fee')
        .in('id', holdIds);

      if (existingTickets?.every(t => t.status === 'valid')) {
        console.log('Webhook: tickets already valid (client ran first) —', sessionId);

        // Check if confirmation email was already sent
        const { data: existingClaim } = await db
          .from('claim_tokens')
          .select('id')
          .eq('ticket_id', existingTickets[0]?.id)
          .maybeSingle();

        if (!existingClaim && email) {
          // Client confirmed tickets but didn't send email — send it now
          await sendConfirmationEmail({ tickets: existingTickets, email, buyerName, venueUrl, sessionId });
        }
        return res.status(200).json({ received: true });
      }

      // Update held tickets → valid
      for (const holdId of holdIds) {
        const existing  = existingTickets?.find(t => t.id === holdId);
        const totpSeed  = existing?.totp_seed || generateTotpSeed();

        const { error: updateErr } = await db
          .from('tickets')
          .update({
            status:      'valid',
            tx_hash:     txHash,
            buyer_id:    buyerId,
            buyer_email: email      || null,
            buyer_name:  buyerName  || null,
            buyer_phone: buyerPhone || null,
            totp_seed:   totpSeed,
            payment,
            wallet:      wallet || null,
          })
          .eq('id', holdId);

        if (updateErr) {
          console.error(`Webhook: failed to update ticket ${holdId}:`, updateErr.message);
        }
      }

      // ── 5. Upsert buyer ───────────────────────────────────────────────────
      if (email) {
        const { data: existingBuyer } = await db
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
          visit_count:  (existingBuyer?.visit_count || 0) + 1,
          updated_at:   new Date().toISOString(),
        }, { onConflict: 'email' });
      }

      // Re-fetch tickets with full detail for email
      const { data: confirmedTickets } = await db
        .from('tickets')
        .select('id, seat, seat_key, event_name, price, totp_seed, status')
        .in('id', holdIds);

      // ── 6. Send confirmation email ────────────────────────────────────────
      if (email && confirmedTickets?.length) {
        await sendConfirmationEmail({
          tickets: confirmedTickets,
          email,
          buyerName,
          venueUrl,
          sessionId,
        });
      }

      console.log(`Webhook: ✓ ${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
      return res.status(200).json({ received: true });
    }

    // ── No hold_ids — log and return ───────────────────────────────────────
    // OCTL concert flow always uses holds. If hold_ids are missing the client
    // will handle ticket creation on Stripe return. Log for debugging only.
    console.warn('Webhook: no hold_ids in metadata — client will handle ticket write:', sessionId);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook processing error:', err);
    // Always return 200 to Stripe — never let webhook retry on app errors
    return res.status(200).json({ received: true, warning: 'Processing error logged' });
  }
};

// ── Send confirmation email via /api/send ──────────────────────────────────────
// Calls send.js internally rather than duplicating email logic here.
// Uses the VERCEL_URL env var (set automatically by Vercel) to self-call.
async function sendConfirmationEmail({ tickets, email, buyerName, venueUrl, sessionId }) {
  try {
    const primaryTicket = tickets[0];
    const ticketIds     = tickets.map(t => t.id);
    const seats         = tickets.map(t => t.seat || t.seat_key || 'Reserved Seat');
    const eventName     = primaryTicket?.event_name || 'Your Event';
    const baseUrl       = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://octickets-api.vercel.app';

    const sendRes = await fetch(`${baseUrl}/api/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:      'email',
        email,
        name:      buyerName || 'Ticket Holder',
        ticketIds,
        seats,
        eventName,
        venueUrl,
        seatCount: tickets.length,
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error('Webhook: send.js email failed:', sendRes.status, errText);
    } else {
      console.log(`Webhook: ✓ confirmation email sent to ${email} — ${tickets.length} ticket(s)`);
    }
  } catch (err) {
    console.error('Webhook: email send exception:', err.message);
  }
}
