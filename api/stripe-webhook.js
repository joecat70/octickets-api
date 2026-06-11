// api/stripe-webhook.js
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: false } };

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Supabase env vars not set');
    return createClient(url, key);
}

// Call /api/send with the correct email style (gold claim link + rotating QR)
// Only sends for the REG-FEE ticket — not bracket add-ons
async function sendConfirmationEmail({ tickets, email, name, venueUrl }) {
    const regTicket = tickets.find(t =>
        t.seat_key && (t.seat_key.includes('REG-FEE') || t.seat_key.includes('REG-'))
    ) || tickets[0];

    if (!regTicket) {
        console.warn('Webhook: no REG-FEE ticket found — skipping email');
        return;
    }

    const allTicketIds = tickets.map(t => t.id);
    const allSeats     = tickets.map(t => t.seat || t.seat_key || 'Registration');

    const payload = {
        type:      'email',
        email,
        name,
        ticketId:  regTicket.id,
        ticketIds: [regTicket.id], // only REG-FEE for claim link
        eventName: regTicket.event_name,
        seat:      regTicket.seat || regTicket.seat_key,
        seats:     [regTicket.seat || regTicket.seat_key],
        seatCount: 1,
        venueUrl:  venueUrl || 'https://octlregistration.eth.limo',
    };

    const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'https://octickets-api.vercel.app';

    const resp = await globalThis.fetch(`${baseUrl}/api/send`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    });

    if (!resp.ok) {
        const body = await resp.text();
        console.error('Webhook: /api/send error', resp.status, body);
    } else {
        console.log('Webhook: confirmation email sent to', email, 'via /api/send');
    }
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

    // ── 1. Verify Stripe signature ────────────────────────────────────────────
    let event;
    try {
        const rawBody = await new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end',  () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
        event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
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

    const meta       = session.metadata || {};
    const sessionId  = session.id;
    const email      = session.customer_email || session.customer_details?.email || meta.buyer_email || '';
    const holdIds    = meta.hold_ids ? meta.hold_ids.split(',').map(s => s.trim()).filter(Boolean) : [];
    const txHash     = 'stripe:' + sessionId;
    const buyerId    = 'stripe-' + sessionId.slice(-8);
    const buyerName  = meta.buyer_name  || '';
    const buyerPhone = meta.buyer_phone || '';
    const buyerZip   = meta.buyer_zip   || '';
    const ageRange   = meta.buyer_age_range || '';
    const referral   = meta.buyer_referral  || '';
    const optInEmail = meta.opt_in_email === 'true';
    const optInSms   = meta.opt_in_sms   === 'true';
    const payment    = meta.payment || 'Card';
    const wallet     = meta.wallet  || null;
    const venueUrl   = meta.venue_url || 'https://octlregistration.eth.limo';

    console.log(`Webhook: session ${sessionId} — holdIds=${holdIds.length}, txHash=${txHash}`);

    try {
        const db = getSupabase();

        // ── 3a. Hold-based flow ───────────────────────────────────────────────
        if (holdIds.length) {
            const { data: existingTickets } = await db
                .from('tickets').select('id, status, totp_seed').in('id', holdIds);

            if (existingTickets?.every(t => t.status === 'valid')) {
                console.log('Webhook: tickets already valid (client ran first) —', sessionId);
                return res.status(200).json({ received: true });
            }

            for (const holdId of holdIds) {
                const existing = existingTickets?.find(t => t.id === holdId);
                const totpSeed = existing?.totp_seed || generateTotpSeed();
                const { error: updateErr } = await db.from('tickets').update({
                    status: 'valid', tx_hash: txHash, buyer_id: buyerId,
                    buyer_email: email || null, buyer_name: buyerName || null,
                    totp_seed: totpSeed, payment, wallet: wallet || null,
                }).eq('id', holdId);
                if (updateErr) console.error(`Webhook: failed to update ticket ${holdId}:`, updateErr.message);
            }

            if (email) {
                const { data: existing } = await db.from('buyers').select('visit_count').eq('email', email).maybeSingle();
                await db.from('buyers').upsert({
                    id: buyerId, email, name: buyerName || null, phone: buyerPhone || null,
                    wallet: wallet || null, zip: buyerZip || null, age_range: ageRange || null,
                    referral: referral || null, opt_in_email: optInEmail, opt_in_sms: optInSms,
                    visit_count: (existing?.visit_count || 0) + 1,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'email' });
            }

            const { data: ticketRows } = await db
                .from('tickets')
                .select('id, event_id, event_name, tier_name, seat, seat_key, price, totp_seed, status')
                .in('id', holdIds);

            if (email && ticketRows?.length) {
                await sendConfirmationEmail({ tickets: ticketRows, email, name: buyerName || 'Guest', venueUrl });
            }

            console.log(`Webhook: ✓ ${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
            return res.status(200).json({ received: true });
        }

        // ── 3b. No hold_ids — retry lookup for client-side race condition ─────
        console.log('Webhook: no hold_ids — looking up tickets by tx_hash:', txHash);

        let txTickets = null;
        for (let attempt = 1; attempt <= 10; attempt++) {
            const { data } = await db
                .from('tickets')
                .select('id, event_id, event_name, tier_name, seat, seat_key, price, totp_seed, status, buyer_email')
                .eq('tx_hash', txHash);

            if (data?.length) {
                txTickets = data;
                console.log(`Webhook: found ${data.length} ticket(s) on attempt ${attempt}`);
                break;
            }

            console.log(`Webhook: attempt ${attempt}/10 — no tickets yet, waiting 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }

        if (txTickets?.length) {
            const ticketEmail = email || txTickets[0]?.buyer_email || '';
            if (ticketEmail) {
                await sendConfirmationEmail({
                    tickets: txTickets, email: ticketEmail,
                    name: buyerName || 'Guest', venueUrl,
                });
            }
            console.log(`Webhook: ✓ ${txTickets.length} ticket(s) confirmed via tx_hash — session ${sessionId}`);
            return res.status(200).json({ received: true });
        }

        console.warn('Webhook: no tickets found after 10 attempts for session', sessionId);
        return res.status(200).json({ received: true });

    } catch (err) {
        console.error('Webhook processing error:', err);
        return res.status(200).json({ received: true, warning: 'Processing error logged' });
    }
};

function generateTotpSeed() {
    const bytes = [];
    for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
