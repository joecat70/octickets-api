const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, ticketId, eventName, seat, venueUrl } = req.body;
  if (!phone || !ticketId) return res.status(400).json({ error: 'Missing phone or ticketId' });

  try {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { error: dbError } = await supabase
      .from('claim_tokens')
      .insert({ token, ticket_id: ticketId, phone, expires_at: expiresAt.toISOString(), claimed: false });

    if (dbError) return res.status(500).json({ error: 'Failed to save token' });

    const claimUrl = `${venueUrl || 'https://theetestsite.eth.limo'}/?claim=${token}`;
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
      body: `Your ticket for ${eventName} (${seat}) is ready!\n\nTap to view: ${claimUrl}\n\nOC Tickets Live`,
    });

    console.log(`SMS sent to ${phone} for ticket ${ticketId}`);
    return res.status(200).json({ success: true, token });
  } catch (err) {
    console.error('send-sms error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
