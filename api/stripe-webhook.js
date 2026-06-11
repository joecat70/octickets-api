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

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');


module.exports.config = { api: { bodyParser: false } };

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Supabase env vars not set');
    return createClient(url, key);
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();

    const stripeKey = process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripeKey || !webhookSecret) {
        console.error('stripe-webhook: missing env vars');
        return res.status(500).end();
    }

    const stripe = Stripe(stripeKey);

    // ── 1. Collect raw body bytes, then verify Stripe signature ───────────────
    let event;
    try {
        const rawBody = await new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
        const sig = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ── 2. Only handle checkout.session.completed ─────────────────────────────
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

    console.log(`Webhook: session ${sessionId} — holdIds=${holdIds.length}, txHash=${txHash}`);

    try {
        const db = getSupabase();

        // ── 3a. If hold_ids present: use the hold-based flow ──────────────────
        if (holdIds.length) {
            const { data: existingTickets } = await db
                .from('tickets')
                .select('id, status, totp_seed')
                .in('id', holdIds);

            const alreadyValid = existingTickets?.every(t => t.status === 'valid');
            if (alreadyValid) {
                console.log('Webhook: tickets already valid (client ran first) —', sessionId);
                return res.status(200).json({ received: true });
            }

            for (const holdId of holdIds) {
                const existing  = existingTickets?.find(t => t.id === holdId);
                const totpSeed  = existing?.totp_seed || generateTotpSeed();
                const { error: updateErr } = await db
                    .from('tickets')
                    .update({
                        status: 'valid', tx_hash: txHash, buyer_id: buyerId,
                        buyer_email: email || null, buyer_name: buyerName || null,
                        totp_seed: totpSeed, payment, wallet: wallet || null,
                    })
                    .eq('id', holdId);
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
                await sendTicketEmail({ tickets: ticketRows, email, name: buyerName || 'Guest', txHash, sessionId });
            }

            console.log(`Webhook: ✓ ${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
            return res.status(200).json({ received: true });
        }

        // ── 3b. No hold_ids — retry lookup to handle client-side race condition ─
        // Client writes tickets directly; webhook may fire before they're written.
        // Retry up to 5 times with 2s delay (max 10s — within Vercel limit).
        console.log('Webhook: no hold_ids — looking up tickets by tx_hash:', txHash);

        let txTickets = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            const { data } = await db
                .from('tickets')
                .select('id, event_id, event_name, tier_name, seat, seat_key, price, totp_seed, status, buyer_email')
                .eq('tx_hash', txHash);

            if (data?.length) {
                txTickets = data;
                console.log(`Webhook: found ${data.length} ticket(s) on attempt ${attempt}`);
                break;
            }

            console.log(`Webhook: attempt ${attempt}/5 — no tickets yet, waiting 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }

        if (txTickets?.length) {
            const ticketEmail = email || txTickets[0]?.buyer_email || '';
            console.log(`Webhook: sending email to ${ticketEmail} for ${txTickets.length} ticket(s)`);

            if (ticketEmail) {
                await sendTicketEmail({
                    tickets: txTickets, email: ticketEmail,
                    name: buyerName || 'Guest', txHash, sessionId,
                });
            }

            console.log(`Webhook: ✓ ${txTickets.length} ticket(s) confirmed via tx_hash — session ${sessionId}`);
            return res.status(200).json({ received: true });
        }

        console.warn('Webhook: no tickets found after 5 attempts for session', sessionId);
        return res.status(200).json({ received: true });

    } catch (err) {
        console.error('Webhook processing error:', err);
        return res.status(200).json({ received: true, warning: 'Processing error logged' });
    }
};

// ── Helpers ────────────────────────────────────────────────────────────────

function generateTotpSeed() {
    const bytes = [];
    for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function sendTicketEmail({ tickets, email, name, txHash, sessionId }) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) { console.warn('Webhook: RESEND_API_KEY not set – skipping email'); return; }

    const ticketLines = tickets.map(t => `
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">${t.event_name || ''}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">${t.seat || t.seat_key || ''}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">${t.tier_name || ''}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right">$${(t.price||0).toFixed(2)}</td>
        </tr>`).join('');

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
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="background:#0d0f12;color:#e8eaf0;font-family:'Helvetica Neue',Arial,sans-serif;padding:32px;max-width:600px;margin:0 auto">
        <div style="text-align:center;margin-bottom:32px">
            <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#c9a84c;margin-bottom:8px">OC TICKETS</p>
            <h1 style="font-size:28px;font-weight:700;margin:0">You're confirmed!</h1>
            <p style="color:#a8adb8;margin-top:8px">Hi ${name}, your tickets are ready below.</p>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px">
            <thead>
                <tr style="background:#1a1e25">
                    <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#5c6270">EVENT</th>
                    <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#5c6270">SEAT</th>
                    <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:1px;color:#5c6270">TIER</th>
                    <th style="padding:10px 12px;text-align:right;font-size:11px;letter-spacing:1px;color:#5c6270">PRICE</th>
                </tr>
            </thead>
            <tbody>${ticketLines}</tbody>
        </table>
        <div style="text-align:center;margin:32px 0">
            <p style="font-size:13px;color:#a8adb8;margin-bottom:16px">Scan at the door:</p>
            ${qrBlocks}
        </div>
        <p style="font-size:11px;color:#5c6270;text-align:center;margin-top:32px">
            Order ref: ${txHash}<br>
            Keep this email — you'll need it at the venue.
        </p>
    </body>
    </html>`;

    const subject = tickets.length === 1
        ? `Your ticket for ${tickets[0].event_name}`
        : `Your ${tickets.length} tickets`;

    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'OC Tickets <tickets@octicketslive.com>',
            to: [email],
            subject,
            html,
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        console.error('Webhook: Resend error', resp.status, body);
    } else {
        console.log('Webhook: email sent to', email, 'for', tickets.length, 'ticket(s)');
    }
}
