const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_V2 || process.env.STRIPE_SECRET_KEY);

// Payment split: 90% Venue, 10% OC Tickets Live
const PLATFORM_FEE_PERCENT = 0.10;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const {
    seats,
    eventName,
    venueUrl,
    buyerEmail,
    serviceFee,
    venueStripeAccountId
  } = req.body;

  if (!seats || !seats.length) {
    return res.status(400).json({ error: 'No seats provided' });
  }

  try {
    // Build line items — one per ticket
    const lineItems = seats.map(seat => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: (eventName || 'Event Ticket') + ' - ' + seat.label,
          description: seat.tier + ' - Secured by OC Tickets Live',
        },
        unit_amount: Math.round(seat.price * 100),
      },
      quantity: 1,
    }));

    // Flat service fee as separate line item
    if (serviceFee && serviceFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Service Fee',
            description: 'OC Tickets Live platform fee (' + seats.length + ' ticket' + (seats.length > 1 ? 's' : '') + ')',
          },
          unit_amount: Math.round(serviceFee * seats.length * 100),
        },
        quantity: 1,
      });
    }

    // Calculate total for split
    const ticketTotal = seats.reduce((sum, s) => sum + Math.round(s.price * 100), 0);
    const feeTotal = serviceFee ? Math.round(serviceFee * seats.length * 100) : 0;
    const grandTotal = ticketTotal + feeTotal;

    // Platform fee = 10% of ticket total (not service fee)
    // OC Tickets Live keeps 10%, venue receives 90%
    const applicationFeeAmount = Math.round(ticketTotal * PLATFORM_FEE_PERCENT);

    // Build session options
    const sessionOptions = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: buyerEmail || undefined,
      success_url: ((venueUrl || 'https://theetestsite.eth.limo').replace(/\/+$/, '') || 'https://theetestsite.eth.limo') + '/#stripe_success=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (venueUrl || 'https://theetestsite.eth.limo') + '/#stripe_cancel=true',
      metadata: {
        eventName: eventName || '',
        seatCount: seats.length.toString(),
        seats: JSON.stringify(seats.map(s => s.key)),
        splitVenue: '90%',
        splitPlatform: '10%',
      },
    };

    // Add Connect split if venue has a Stripe account
    // venueStripeAccountId is the venue's connected Stripe account ID (acct_xxx)
    if (venueStripeAccountId) {
      sessionOptions.payment_intent_data = {
        application_fee_amount: applicationFeeAmount,
        transfer_data: {
          destination: venueStripeAccountId,
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionOptions);

    return res.status(200).json({
      sessionId: session.id,
      url: session.url,
      split: {
        total: grandTotal,
        platformFee: applicationFeeAmount,
        venueAmount: grandTotal - applicationFeeAmount,
      }
    });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    return res.status(500).json({ error: 'Failed to create payment session', detail: err.message });
  }
};
