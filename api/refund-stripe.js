// api/refund-stripe.js v2
// v2 | REFUNDED-STATUS WRITEBACK (pre-launch blocker): v1 issued the Stripe
// refund but NEVER updated Supabase — the ticket stayed status='valid', its
// QR still scanned at the door, and the seat still counted as sold. v2 writes
// status='refunded' (+ refund_id, refunded_at) to the tickets row after the
// refund succeeds.
//
// DESIGN (unchanged from the original diagnosis):
// 1. A DB-write failure must NOT be reported as a refund failure. By the time
//    we write to Supabase, the money has already moved at Stripe. Returning
//    an error here would invite a retry that issues a SECOND refund. So: the
//    HTTP response always reports refund success once Stripe confirms it,
//    with an explicit `dbUpdated` flag and a loud console.error (never a
//    silent failure) if the Supabase write itself fails.
// 2. A Stripe refund status of 'pending' still marks the ticket refunded —
//    the funds are already committed from Stripe's side, so the ticket must
//    die immediately rather than waiting for settlement.
//
// ⚠ VERIFY BEFORE DEPLOYING: the SUPABASE_URL / SUPABASE_SERVICE_KEY env var
// names below use the common fallback-chain pattern seen elsewhere in this
// codebase. Confirm they match whatever this project's own stripe-webhook.js
// actually reads — if OCTL's webhook uses different var names (e.g. a
// SUPABASE_EVENTS_* pair, or project-specific names), update the getDB()
// function below to match EXACTLY. A mismatch here means refunds will
// silently fail to write back (reported via dbUpdated:false + a console
// error, per the design above — so it won't cause a double-refund, but it
// also won't do its job until the var names are correct).
//
// Issues a full or partial Stripe refund for a card-purchased ticket, then
// writes the refunded status back to Supabase so the ticket can no longer be
// scanned at the door and the seat is no longer counted as sold.
// Expects POST { sessionId, amountCents, ticketId, reason }
// Returns { success, refundId, amountRefunded, currency, dbUpdated }

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function getDB() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
}

module.exports = async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    return res.writeHead(204, CORS).end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sessionId, amountCents, ticketId, reason } = req.body || {};

  // ── Validate input ──────────────────────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  if (!amountCents || typeof amountCents !== 'number' || amountCents <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive number' });
  }
  if (!ticketId) {
    return res.status(400).json({ error: 'ticketId is required' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY);

  try {
    // ── 1. Retrieve the checkout session ─────────────────────────────
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });

    if (!session) {
      return res.status(404).json({ error: 'Stripe session not found' });
    }

    const paymentIntent = session.payment_intent;

    if (!paymentIntent) {
      return res.status(400).json({ error: 'No payment intent found on session — may not be a card payment' });
    }

    // ── 2. Check payment intent status ───────────────────────────────
    const piStatus = typeof paymentIntent === 'string'
      ? (await stripe.paymentIntents.retrieve(paymentIntent)).status
      : paymentIntent.status;

    if (piStatus !== 'succeeded') {
      return res.status(400).json({
        error: `Cannot refund — payment intent status is "${piStatus}"`,
      });
    }

    const piId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id;

    // ── 3. Check for existing refunds on this PI to avoid over-refunding
    const existingRefunds = await stripe.refunds.list({ payment_intent: piId, limit: 100 });
    const alreadyRefunded = existingRefunds.data.reduce((sum, r) => {
      return r.status === 'succeeded' || r.status === 'pending' ? sum + r.amount : sum;
    }, 0);

    const piObject = typeof paymentIntent === 'object'
      ? paymentIntent
      : await stripe.paymentIntents.retrieve(piId);

    const maxRefundable = piObject.amount - alreadyRefunded;

    if (amountCents > maxRefundable) {
      return res.status(400).json({
        error: `Refund amount ($${(amountCents/100).toFixed(2)}) exceeds refundable balance ($${(maxRefundable/100).toFixed(2)})`,
        alreadyRefundedCents: alreadyRefunded,
        maxRefundableCents: maxRefundable,
      });
    }

    // ── 4. Issue the refund ───────────────────────────────────────────
    const refund = await stripe.refunds.create({
      payment_intent: piId,
      amount: amountCents,   // partial refund for the specific ticket(s)
      reason: reason || 'requested_by_customer',
      metadata: {
        ticket_id:  ticketId,
        session_id: sessionId,
        issued_by:  'OC Tickets Live Venue OS',
      },
    });

    console.log(`Refund issued: ${refund.id} — $${(refund.amount/100).toFixed(2)} for ticket ${ticketId}`);

    // ── 5. Write refunded status back to Supabase ─────────────────────
    // CRITICAL: this runs AFTER the refund already succeeded at Stripe. A
    // failure here must never be reported as a refund failure — the money
    // has moved regardless. We still refund success, but flag dbUpdated so
    // the caller (admin UI) can show a warning to manually verify/update
    // the ticket status if this write failed.
    let dbUpdated = false;
    try {
      const db = getDB();
      const { error: dbErr } = await db
        .from('tickets')
        .update({
          status:      'refunded', // pending refunds are treated as refunded immediately — funds are already committed from Stripe's side
          refund_id:   refund.id,
          refunded_at: new Date().toISOString(),
        })
        .eq('id', ticketId);

      if (dbErr) {
        console.error(`Refund ${refund.id} succeeded at Stripe but Supabase writeback FAILED for ticket ${ticketId}:`, dbErr.message);
      } else {
        dbUpdated = true;
        console.log(`Ticket ${ticketId} marked refunded in Supabase.`);
      }
    } catch (dbEx) {
      console.error(`Refund ${refund.id} succeeded at Stripe but Supabase writeback THREW for ticket ${ticketId}:`, dbEx.message);
    }

    return res.status(200).json({
      success:        true,
      refundId:       refund.id,
      amountRefunded: refund.amount,          // cents
      amountUSD:      (refund.amount / 100).toFixed(2),
      currency:       refund.currency,
      status:         refund.status,          // 'succeeded' | 'pending'
      ticketId,
      sessionId,
      dbUpdated,      // false means: refund succeeded, but the ticket status wasn't updated — check manually
    });

  } catch (err) {
    console.error('Stripe refund error:', err);

    // Surface Stripe-specific errors cleanly
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ error: err.message });
    }
    if (err.type === 'StripeAuthenticationError') {
      return res.status(500).json({ error: 'Stripe authentication failed — check STRIPE_SECRET_KEY' });
    }

    return res.status(500).json({ error: err.message || 'Refund failed' });
  }
};
