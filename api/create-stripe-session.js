const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { seats, eventName, venueUrl, buyerEmail, serviceFee } = req.body;

  if (!seats || !seats.length) {
    return res.status(400).json({ error: 'No seats provided' });
  }

  try {
    const lineItems = seats.map(seat => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: eventName + ' - ' + seat.label,
          description: seat.tier + ' - Secured by OC Tickets Live',
        },
        unit_amount: Math.round(seat.price * 100),
      },
      quantity: 1,
    }));

    if (serviceFee && serviceFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Service Fee',
            description: 'OC Tickets Live platform fee',
          },
          unit_amount: Math.round(serviceFee * seats.length * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: buyerEmail || undefined,
      success_url: (venueUrl || 'https://theetestsite.eth.limo') + '/?stripe_success=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (venueUrl || 'https://theetestsite.eth.limo') + '/?stripe_cancel=true',
      metadata: {
        eventName: eventName || '',
        seatCount: seats.length.toString(),
        seats: JSON.stringify(seats.map(s => s.key)),
      },
    });

    return res.status(200).json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    return res.status(500).json({ error: 'Failed to create payment session', detail: err.message });
  }
};
