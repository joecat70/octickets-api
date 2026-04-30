const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, ticketId, eventName, seat, venueUrl } = req.body;

  if (!email || !ticketId) {
    return res.status(400).json({ error: 'Missing email or ticketId' });
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );

  const { error: dbError } = await db.from('claim_tokens').insert({
    token,
    ticket_id: ticketId,
    phone: email,
    expires_at: expiresAt.toISOString(),
    claimed: false,
  });

  if (dbError) {
    console.error('DB error:', dbError);
    return res.status(500).json({ error: 'Failed to save token' });
  }

  const claimUrl = `${venueUrl || 'https://theetestsite.eth.limo'}/?claim=${token}`;

  const { error: emailError } = await resend.emails.send({
    from: 'OC Tickets Live <tickets@octicketslive.com>',
    to: email,
    subject: `Your ticket for ${eventName || 'the event'} is ready`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a1a; color: #ffffff; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #d4af37; font-size: 28px; margin: 0;">OC Tickets Live</h1>
          <p style="color: #888; margin: 8px 0 0;">Your ticket is confirmed</p>
        </div>
        <div style="background: #1a1a2e; border: 1px solid #d4af37; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
          <h2 style="color: #d4af37; margin: 0 0 16px; font-size: 20px;">${eventName || 'Event'}</h2>
          <p style="margin: 0 0 8px; color: #ccc;"><strong style="color: #fff;">Seat:</strong> ${seat || 'General Admission'}</p>
          <p style="margin: 0; color: #ccc;"><strong style="color: #fff;">Ticket ID:</strong> ${ticketId}</p>
        </div>
        <div style="text-align: center; margin-bottom: 32px;">
          <p style="color: #ccc; margin-bottom: 16px;">Tap the button below to view your ticket. Your QR code refreshes every 15 seconds — screenshots won't work at the door.</p>
          <a href="${claimUrl}" style="background: #d4af37; color: #000000; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">View My Ticket</a>
        </div>
        <div style="border-top: 1px solid #333; padding-top: 24px; text-align: center;">
          <p style="color: #666; font-size: 12px; margin: 0;">This link expires in 7 days. To resell your ticket, use the Ticket Exchange.</p>
          <p style="color: #666; font-size: 12px; margin: 8px 0 0;">OC Tickets Live · Powered by Ethereum · TICKET Act 2026 compliant</p>
        </div>
      </div>
    `,
  });

  if (emailError) {
    console.error('Email error:', emailError);
    return res.status(500).json({ error: 'Failed to send email' });
  }

  return res.status(200).json({ success: true, token });
};
