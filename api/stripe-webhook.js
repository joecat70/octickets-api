// api/stripe-webhook.js
const Stripe        = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { Resend }    = require('resend');
const { v4: uuidv4 } = require('uuid');

module.exports.config = { api: { bodyParser: false } };

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Supabase env vars not set');
    return createClient(url, key);
}
}

async function sendConfirmationEmail({ db, tickets, email, name, venueUrl }) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) { console.warn('Webhook: RESEND_API_KEY not set'); return; }

    // Filter to REG-FEE ticket only — bracket tickets are not door tickets
    const regTicket = tickets.find(t =>
        t.seat_key && (t.seat_key.includes('REG-FEE') || t.seat_key.startsWith('REG-'))
    ) || tickets.find(t => !t.seat_key?.startsWith('BKT-') && !t.seat_key?.startsWith('BRACKET'));

    if (!regTicket) { console.warn('Webhook: no REG ticket found in', tickets.map(t => t.seat_key)); return; }

    const baseUrl    = (venueUrl || 'https://octlregistration.eth.limo').replace(/\/+$/, '');
    const buyerName  = name || 'Bowler';
    const eventName  = regTicket.event_name || 'Tournament';
    const seat       = regTicket.seat || regTicket.seat_key || 'Tournament Registration';

    // Create claim token
    const token     = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: dbErr } = await db.from('claim_tokens').insert({
        id:         uuidv4(),
        token,
        ticket_id:  regTicket.id,
        phone:      email,
        expires_at: expiresAt,
        claimed:    false,
    });

    if (dbErr) {
        console.error('Webhook: claim token insert failed:', dbErr.message);
        return;
    }

    const claimUrl = `${baseUrl}/#claim=${token}`;
    const resend   = new Resend(resendKey);

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Registration — OC Tickets Live</title></head>
<body style="margin:0;padding:0;background:#0a0900;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0900;padding:32px 16px">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-radius:8px 8px 0 0;padding:24px 32px;text-align:center;border-bottom:1px solid #c9a84c40">
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f5f0e6;letter-spacing:4px;text-transform:uppercase">OC Tickets Live</div>
        <div style="font-size:11px;color:#8a7f5c;letter-spacing:1px;margin-top:4px;font-family:monospace">Bowling Tournament Registration</div>
      </td>
    </tr>
    <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent)"></td></tr>
    <tr>
      <td style="background:#0e0c08;border:1px solid #2a2310;border-top:none;padding:32px">
        <p style="margin:0 0 24px;font-size:15px;color:#d4c88a;line-height:1.6">
          Hi ${buyerName},<br><br>
          Your registration is confirmed. Tap the button below to access your ticket and rotating QR code for door entry.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:16px;border-bottom:1px solid #1e1c14">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Tournament</div>
            <div style="font-size:18px;font-weight:700;color:#f5f0e6;font-family:Georgia,serif">${eventName}</div>
          </td></tr>
          <tr><td style="padding:16px">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px">Registration</div>
            <div style="font-size:14px;color:#f5f0e6">${seat}</div>
            <div style="font-size:11px;color:#8a7f5c;font-family:monospace;margin-top:4px">${regTicket.id}</div>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr><td align="center">
            <a href="${claimUrl}" style="display:inline-block;background:#c9a84c;color:#000;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:1px;padding:14px 36px;border-radius:4px;text-transform:uppercase">
              Access My Ticket →
            </a>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#13110a;border:1px solid #2a2310;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:16px">
            <div style="font-size:10px;color:#8a7f5c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px">Secure Ticket Link</div>
            <div style="font-size:11px;color:#c9a84c;word-break:break-all;font-family:monospace;line-height:1.6">${claimUrl}</div>
            <div style="font-size:11px;color:#4a4530;margin-top:8px">Valid for 7 days · Tap or copy into your browser</div>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0a;border:1px solid #1e1c14;border-radius:6px">
          <tr><td style="padding:14px 16px">
            <div style="font-size:11px;color:#6a6040;line-height:1.7;font-family:monospace">
              🔒 Your ticket includes a rotating QR code that refreshes every 15 seconds.<br>
              Screenshots are not valid at the door — always open your live ticket link.<br>
              Do not share this email or your claim link with anyone.
            </div>
          </td></tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="background:#080700;border:1px solid #2a2310;border-top:none;border-radius:0 0 8px 8px;padding:20px 32px;text-align:center">
        <div style="font-size:10px;color:#4a4530;font-family:monospace;line-height:1.8">
          OC Tickets Live · octicketslive.com<br>
          This link was sent to ${email}
        </div>
      </td>
    </tr>
  </table>
  </td></tr>
</table>
</body></html>`;

    try {
        const { error: emailErr } = await resend.emails.send({
            from:    'OC Tickets Live <tickets@octicketslive.com>',
            to:      email,
            subject: `Your Registration — ${eventName}`,
            html,
        });
        if (emailErr) console.error('Webhook: Resend error:', emailErr);
        else console.log('Webhook: ✓ confirmation email sent to', email);
    } catch(e) {
        console.error('Webhook: email send exception:', e.message);
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

    console.log(`Webhook: session ${sessionId} — holdIds=${holdIds.length}, txHash=${txHash}, email=${email}`);

    try {
        const db = getSupabase();

        // ── 3a. Hold-based flow ───────────────────────────────────────────────
        if (holdIds.length) {
            const { data: existingTickets } = await db
                .from('tickets').select('id, status, totp_seed').in('id', holdIds);

            if (existingTickets?.every(t => t.status === 'valid')) {
                console.log('Webhook: tickets already valid (client ran first) —', sessionId);
                // Still send email if not already sent — check claim_tokens
                const { data: existingClaim } = await db
                    .from('claim_tokens')
                    .select('id')
                    .eq('ticket_id', existingTickets[0]?.id)
                    .maybeSingle();
                if (!existingClaim && email) {
                    const { data: ticketRows } = await db
                        .from('tickets')
                        .select('id, event_id, event_name, tier_name, seat, seat_key, price, totp_seed, status')
                        .in('id', holdIds);
                    if (ticketRows?.length) {
                        await sendConfirmationEmail({ db, tickets: ticketRows, email, name: buyerName || 'Guest', venueUrl });
                    }
                }
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
                await sendConfirmationEmail({ db, tickets: ticketRows, email, name: buyerName || 'Guest', venueUrl });
            }

            console.log(`Webhook: ✓ ${holdIds.length} ticket(s) confirmed — session ${sessionId}`);
            return res.status(200).json({ received: true });
        }

        // ── 3b. No hold_ids — polling loop for client-side ticket write ───────
        // The bowling flow writes tickets client-side after Stripe returns.
        // We poll until tickets appear, using the full 55s budget on Pro plan.
        // Retry config: 20 attempts × 2.5s = 50s total (under 55s safe limit)
        console.log('Webhook: no hold_ids — polling for tx_hash:', txHash);

        const MAX_ATTEMPTS  = 20;
        const RETRY_DELAY   = 2500; // ms
        let txTickets = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const { data, error } = await db
                .from('tickets')
                .select('id, event_id, event_name, tier_name, seat, seat_key, price, totp_seed, status, buyer_email')
                .eq('tx_hash', txHash)
                .neq('seat_key', 'PROCESSING-FEE'); // exclude fee line items if any

            if (error) console.error(`Webhook: DB error on attempt ${attempt}:`, error.message);

            if (data?.length) {
                txTickets = data;
                console.log(`Webhook: found ${data.length} ticket(s) on attempt ${attempt} (${attempt * RETRY_DELAY / 1000}s)`);
                break;
            }

            if (attempt < MAX_ATTEMPTS) {
                console.log(`Webhook: attempt ${attempt}/${MAX_ATTEMPTS} — no tickets yet, waiting ${RETRY_DELAY}ms...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY));
            }
        }

        if (txTickets?.length) {
            // Deduplicate — don't send if claim token already exists for this REG ticket
            const regTicket = txTickets.find(t =>
                t.seat_key && (t.seat_key.includes('REG-FEE') || t.seat_key.startsWith('REG-'))
            ) || txTickets[0];

            const { data: existingClaim } = await db
                .from('claim_tokens')
                .select('id')
                .eq('ticket_id', regTicket.id)
                .maybeSingle();

            if (existingClaim) {
                console.log('Webhook: claim token already exists — email already sent by client, skipping');
                return res.status(200).json({ received: true });
            }

            const ticketEmail = email || txTickets[0]?.buyer_email || '';
            if (ticketEmail) {
                await sendConfirmationEmail({ db, tickets: txTickets, email: ticketEmail, name: buyerName || 'Guest', venueUrl });
            } else {
                console.warn('Webhook: no email address available for session', sessionId);
            }

            console.log(`Webhook: ✓ ${txTickets.length} ticket(s) confirmed via tx_hash — session ${sessionId}`);
            return res.status(200).json({ received: true });
        }

        console.warn(`Webhook: no tickets found after ${MAX_ATTEMPTS} attempts (${MAX_ATTEMPTS * RETRY_DELAY / 1000}s) for session`, sessionId);
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
