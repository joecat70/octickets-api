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
//   4. Upsert buyer record FIRST (see fix note below)
//   5. Hold-based path: update held tickets → 'valid'
//   6. Send confirmation email via /api/send (type: email)
//   7. Idempotency: if tickets already valid, skip quietly
//
// FIX (this revision): buyer upsert and ticket update were in the wrong
// order. Tickets.update() set buyer_id to a brand-new buyer ID before that
// buyer row existed in the buyers table — confirmed via Postgres logs as a
// 23503 foreign key violation ("Key (buyer_id)=(stripe-XXXXXXXX) is not
// present in table buyers"), firing on every hold-based purchase, 6 times
// in the same second for a 6-ticket order. Since the ticket update never
// checked for an error (also fixed here), this failed completely silently
// — Stripe charged successfully, the buyer row got created moments later,
// but the tickets themselves were never marked valid. Swapped the order:
// buyer now exists before anything references its ID.
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

      // FIX: upsert the buyer record BEFORE updating tickets — the ticket
      // update sets buyer_id to this buyer's ID, which violates the
      // tickets_buyer_id_fkey constraint if that buyer row doesn't exist
      // yet. This was previously done after the ticket loop (see header).
      if (email) {
        const { data: existingBuyer } = await db
          .from('buyers')
          .select('visit_count')
          .eq('email', email)
          .maybeSingle();

        const { error: buyerErr } = await db.from('buyers').upsert({
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

        if (buyerErr) {
          // FIX: this was never checked before. If the buyer upsert fails,
          // continuing to update tickets with this buyer_id will just hit
          // the same FK violation again — fail loudly instead of silently.
          console.error(`Webhook: buyer upsert failed for ${email} — aborting ticket update:`, buyerErr.message);
          return res.status(500).json({ received: true, error: 'Buyer upsert failed', detail: buyerErr.message });
        }
      }

      // Update held tickets → valid (buyer row is now guaranteed to exist)
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

        // FIX: this error was already being checked and logged — but the
        // loop continued regardless, and nothing downstream knew any ticket
        // had failed. Track failures so the response actually reflects reality.
        if (updateErr) {
          console.error(`Webhook: failed to update ticket ${holdId}:`, updateErr.message);
        }
      }

      // Re-fetch tickets with full detail for email — also confirms which
      // tickets actually made it to 'valid' status after the updates above.
      const { data: confirmedTickets } = await db
        .from('tickets')
        .select('id, seat, seat_key, event_name, price, totp_seed, status')
        .in('id', holdIds);

      const actuallyValid = (confirmedTickets || []).filter(t => t.status === 'valid');
      if (actuallyValid.length < holdIds.length) {
        console.error(`Webhook: ${holdIds.length - actuallyValid.length} of ${holdIds.length} tickets failed to confirm for session ${sessionId} — check logs above for the specific error`);
      }

      // ── 6. Send confirmation email — only for tickets that actually confirmed ──
      if (email && actuallyValid.length) {
        await sendConfirmationEmail({
          tickets: actuallyValid,
          email,
          buyerName,
          venueUrl,
          sessionId,
        });
      } else if (email) {
        console.error(`Webhook: no confirmation email sent for session ${sessionId} — zero tickets actually confirmed`);
      }

      console.log(`Webhook: ✓ ${actuallyValid.length}/${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
      return res.status(200).json({ received: true, confirmed: actuallyValid.length, attempted: holdIds.length });
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
