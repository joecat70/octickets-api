// api/send-verify.js
// Sends a 6-digit verification code email for ticket exchange listing confirmation.
// Expects POST { email, code, eventName, seats }

const { Resend } = require('resend');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  if(req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, code, eventName, seats } = req.body || {};
  if(!email || !code) return res.status(400).json({ error: 'email and code are required' });

  const resend = new Resend(process.env.RESEND_API_KEY);
  const seatList = Array.isArray(seats) ? seats.join(', ') : (seats || 'Reserved Seat');

  try {
    const { error } = await resend.emails.send({
      from:    'OC Tickets Live <tickets@octicketslive.com>',
      to:      email,
      subject: `Your listing verification code: ${code}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <div style="font-size:13px;font-weight:700;letter-spacing:2px;color:#C9A84C;text-transform:uppercase;margin-bottom:16px">OC Tickets Live</div>
          <h2 style="font-size:20px;margin:0 0 8px">Ticket Exchange Listing</h2>
          <p style="font-size:14px;color:#555;margin:0 0 24px">
            You requested to list the following ticket(s) on the OC Tickets Exchange:
          </p>
          <div style="background:#f5f5f5;border-radius:6px;padding:16px;margin-bottom:24px">
            <div style="font-size:13px;color:#333;font-weight:600">${eventName || 'Upcoming Event'}</div>
            <div style="font-size:12px;color:#666;margin-top:4px">Seats: ${seatList}</div>
          </div>
          <p style="font-size:14px;color:#555;margin:0 0 12px">Enter this code to confirm your listing:</p>
          <div style="background:#1a1a1a;color:#C9A84C;font-size:36px;font-weight:900;letter-spacing:10px;text-align:center;padding:20px;border-radius:8px;margin-bottom:24px;font-family:monospace">
            ${code}
          </div>
          <p style="font-size:12px;color:#999;margin:0">
            This code expires in 10 minutes. If you did not request this, you can ignore this email — your tickets remain safe.
          </p>
        </div>
      `,
    });

    if(error) {
      console.error('Resend error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`✓ Verification code sent to ${email} for listing`);
    return res.status(200).json({ success: true });

  } catch(e) {
    console.error('send-verify error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
