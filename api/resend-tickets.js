const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

const headers = {
  'apikey': supabaseKey,
  'Authorization': `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, venueUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const base = venueUrl || 'https://theetestsite.eth.limo';

  try {
    // 1. Find buyer by email
    const buyerRes = await fetch(
      `${supabaseUrl}/rest/v1/buyers?email=eq.${encodeURIComponent(email)}&select=id`,
      { headers }
    );
    const buyers = await buyerRes.json();

    if (!buyers || buyers.length === 0) {
      await sendNotFoundEmail(email);
      return res.status(200).json({ success: true, ticketsFound: 0 });
    }

    const buyerIds = buyers.map(b => `"${b.id}"`).join(',');

    // 2. Find all valid tickets for this buyer
    const ticketsRes = await fetch(
      `${supabaseUrl}/rest/v1/tickets?buyer_id=in.(${buyerIds})&status=eq.valid&select=id,seat,event_id,event_name,tier_name,price,payment`,
      { headers }
    );
    const tickets = await ticketsRes.json();

    if (!tickets || tickets.length === 0) {
      await sendNotFoundEmail(email);
      return res.status(200).json({ success: true, ticketsFound: 0 });
    }

    // 3. Generate fresh claim token for each ticket
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const ticketLinks = [];

    for (const ticket of tickets) {
      const token = crypto.randomUUID();
      const sbRes = await fetch(`${supabaseUrl}/rest/v1/claim_tokens`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ token, ticket_id: ticket.id, phone: email, expires_at: expires, claimed: false })
      });
      if (sbRes.ok) {
        ticketLinks.push({ ...ticket, claimUrl: `${base}/?claim=${token}` });
      }
    }

    if (ticketLinks.length === 0) {
      return res.status(500).json({ error: 'Failed to generate ticket links' });
    }

    // 4. Send consolidated email
    const ticketCards = ticketLinks.map((t, i) => `
      <div style="background:#0a0a0f;border:1px solid #2a2a3a;border-radius:8px;padding:20px;margin-bottom:12px;">
        <div style="margin-bottom:14px;">
          <div style="font-size:10px;letter-spacing:2px;color:#d4af37;text-transform:uppercase;margin-bottom:4px;">Ticket ${i + 1} of ${ticketLinks.length}</div>
          <div style="font-size:16px;font-weight:600;color:#ffffff;">${t.event_name || t.event_id || 'Event'}</div>
          <div style="font-size:13px;color:#9090b0;margin-top:3px;">${t.seat || 'General Admission'} ${t.tier_name ? '· ' + t.tier_name : ''}</div>
          <div style="font-size:11px;color:#555570;margin-top:3px;font-family:monospace;">${t.id}</div>
        </div>
        <a href="${t.claimUrl}" style="display:block;background:linear-gradient(135deg,#d4af37,#f0c842);color:#000000;text-decoration:none;text-align:center;padding:13px 24px;border-radius:6px;font-weight:700;font-size:14px;">
          View Ticket ${i + 1} →
        </a>
      </div>
    `).join('');

    const { data, error } = await resend.emails.send({
      from: 'OC Tickets Live <tickets@octicketslive.com>',
      to: email,
      subject: `Your ${ticketLinks.length} ticket${ticketLinks.length > 1 ? 's' : ''} — OC Tickets Live`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#0a0a0f;font-family:'Helvetica Neue',Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
          <div style="text-align:center;margin-bottom:32px;">
            <div style="font-size:13px;letter-spacing:3px;color:#d4af37;text-transform:uppercase;margin-bottom:8px;">OC Tickets Live</div>
            <div style="width:48px;height:1px;background:#d4af37;margin:0 auto;"></div>
          </div>
          <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;overflow:hidden;margin-bottom:20px;">
            <div style="height:4px;background:linear-gradient(90deg,#d4af37,#f0c842,#d4af37);"></div>
            <div style="padding:24px 32px;">
              <div style="font-size:11px;letter-spacing:2px;color:#d4af37;text-transform:uppercase;margin-bottom:8px;">Your Tickets</div>
              <div style="font-size:20px;font-weight:700;color:#ffffff;">${ticketLinks.length} ticket${ticketLinks.length > 1 ? 's' : ''} found</div>
              <div style="font-size:13px;color:#9090b0;margin-top:6px;">Each button opens your individual ticket with a rotating QR code for door entry.</div>
            </div>
          </div>
          ${ticketCards}
          <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:8px;padding:16px;margin-top:8px;margin-bottom:24px;">
            <div style="font-size:12px;color:#9090b0;line-height:1.6;">
              🔒 <strong style="color:#ffffff;">Each link is single-use.</strong>
              First tap activates your rotating QR code. Links expire in 7 days.
            </div>
          </div>
          <div style="text-align:center;"><div style="font-size:11px;color:#555570;">OC Tickets Live · Powered by Ethereum</div></div>
        </div></body></html>`
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send email', detail: error.message });
    }

    return res.status(200).json({ success: true, ticketsFound: ticketLinks.length, emailId: data.id });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};

async function sendNotFoundEmail(email) {
  try {
    await resend.emails.send({
      from: 'OC Tickets Live <tickets@octicketslive.com>',
      to: email,
      subject: 'OC Tickets Live — Ticket lookup',
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0f;font-family:'Helvetica Neue',Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
          <div style="text-align:center;margin-bottom:32px;">
            <div style="font-size:13px;letter-spacing:3px;color:#d4af37;text-transform:uppercase;margin-bottom:8px;">OC Tickets Live</div>
            <div style="width:48px;height:1px;background:#d4af37;margin:0 auto;"></div>
          </div>
          <div style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;padding:32px;text-align:center;">
            <div style="font-size:32px;margin-bottom:16px;">🎫</div>
            <div style="font-size:18px;color:#ffffff;margin-bottom:12px;">No tickets found</div>
            <div style="font-size:14px;color:#9090b0;line-height:1.6;">We couldn't find any active tickets for this email address.<br><br>If you used a different email at checkout, please try again with that address.</div>
          </div>
          <div style="text-align:center;margin-top:24px;"><div style="font-size:11px;color:#555570;">OC Tickets Live · Powered by Ethereum</div></div>
        </div></body></html>`
    });
  } catch(e) { console.warn('Could not send not-found email:', e.message); }
}
