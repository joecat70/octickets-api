// api/refund-stripe.js
// Issues a full or partial Stripe refund for a card-purchased ticket.
// Expects POST { sessionId, amountCents, ticketId, reason }
// Returns { success, refundId, amountRefunded, currency }

const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

    return res.status(200).json({
      success:        true,
      refundId:       refund.id,
      amountRefunded: refund.amount,          // cents
      amountUSD:      (refund.amount / 100).toFixed(2),
      currency:       refund.currency,
      status:         refund.status,          // 'succeeded' | 'pending'
      ticketId,
      sessionId,
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
