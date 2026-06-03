// ============================================================
// /api/zeroscalp.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// Consolidated from: validate-resale-price.js, check-transfer-eligibility.js
//
// Routes by req.body.action:
//   'validate_price'        → resale price cap enforcement
//   'check_eligibility'     → transfer eligibility gate
//
// All response shapes preserved exactly from original files.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required: validate_price | check_eligibility' });

  // ============================================================
  // ACTION: validate_price
  // Server-side resale price cap validator.
  // Dual-layer: frontend caps input, this is the authoritative gate.
  // Body: { action, ticket_id, asked_price }
  // ============================================================
  if (action === 'validate_price') {
    const { ticket_id, asked_price } = req.body;

    if (!ticket_id || asked_price == null) {
      return res.status(400).json({ error: 'ticket_id and asked_price required' });
    }

    const askedNum = parseFloat(asked_price);
    if (isNaN(askedNum) || askedNum <= 0) {
      return res.status(400).json({ error: 'asked_price must be a positive number' });
    }

    try {
      const { data: ticket, error: ticketErr } = await supabase
        .from('tickets')
        .select('id, price, stripe_fee, event_id, status')
        .eq('id', ticket_id)
        .maybeSingle();

      if (ticketErr) {
        console.error('zeroscalp/validate_price: ticket lookup error:', ticketErr.message);
        return res.status(500).json({ error: 'Ticket lookup failed' });
      }
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.status !== 'valid') {
        return res.status(400).json({ error: 'Ticket is not eligible for resale', status: ticket.status });
      }

      const { data: config, error: configErr } = await supabase
        .from('event_config')
        .select('resale_rule, transfer_enabled')
        .eq('event_id', ticket.event_id)
        .maybeSingle();

      if (configErr) {
        console.error('zeroscalp/validate_price: event_config lookup error:', configErr.message);
        return res.status(500).json({ error: 'Event config lookup failed' });
      }

      const resaleRule      = config?.resale_rule      ?? 'open';
      const transferEnabled = config?.transfer_enabled  ?? true;

      if (!transferEnabled) {
        return res.status(400).json({
          allowed: false,
          reason:  'Transfers are disabled for this event',
        });
      }

      if (resaleRule === 'original_plus_fees') {
        const originalPrice = parseFloat(ticket.price)      || 0;
        const stripeFee     = parseFloat(ticket.stripe_fee) || parseFloat(((originalPrice * 0.029) + 0.30).toFixed(2));
        const maxPrice      = parseFloat((originalPrice + stripeFee).toFixed(2));

        if (askedNum > maxPrice) {
          console.log(`zeroscalp/validate_price: cap violation ticket ${ticket_id} asked $${askedNum} max $${maxPrice}`);
          return res.status(400).json({
            allowed:     false,
            max_price:   maxPrice,
            original:    originalPrice,
            stripe_fee:  stripeFee,
            resale_rule: resaleRule,
            reason:      `Resale price capped at original price + Stripe fee ($${maxPrice.toFixed(2)})`,
          });
        }
      }

      console.log(`zeroscalp/validate_price: ✓ approved ticket ${ticket_id} at $${askedNum} (rule: ${resaleRule})`);
      return res.status(200).json({
        allowed:     true,
        resale_rule: resaleRule,
        asked_price: askedNum,
      });

    } catch (err) {
      console.error('zeroscalp/validate_price error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  // ============================================================
  // ACTION: check_eligibility
  // Transfer eligibility gate for exchange listing and gift flows.
  // Body: { action, ticket_id }
  // ============================================================
  if (action === 'check_eligibility') {
    const { ticket_id } = req.body;

    if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });

    try {
      const { data: ticket, error: ticketErr } = await supabase
        .from('tickets')
        .select('id, event_id, status, price, stripe_fee')
        .eq('id', ticket_id)
        .maybeSingle();

      if (ticketErr) {
        console.error('zeroscalp/check_eligibility: ticket lookup error:', ticketErr.message);
        return res.status(500).json({ error: 'Ticket lookup failed' });
      }
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.status !== 'valid') {
        return res.status(200).json({
          eligible: false,
          reason:   `Ticket status is '${ticket.status}' — only valid tickets can be transferred`,
        });
      }

      const { data: config, error: configErr } = await supabase
        .from('event_config')
        .select('transfer_enabled, resale_rule, price_cap_bps, doors_open')
        .eq('event_id', ticket.event_id)
        .maybeSingle();

      if (configErr) {
        console.error('zeroscalp/check_eligibility: event_config lookup error:', configErr.message);
        return res.status(500).json({ error: 'Event config lookup failed' });
      }

      const transferEnabled = config?.transfer_enabled ?? true;
      const resaleRule      = config?.resale_rule      ?? 'open';

      if (!transferEnabled) {
        console.log(`zeroscalp/check_eligibility: blocked ticket ${ticket_id} — transfers disabled`);
        return res.status(200).json({
          eligible:           false,
          transfer_enabled:   false,
          reason:             'Transfers are disabled for this event. You may request an exception transfer through the platform.',
          exception_eligible: true,
        });
      }

      const originalPrice = parseFloat(ticket.price)      || 0;
      const stripeFee     = parseFloat(ticket.stripe_fee) || parseFloat(((originalPrice * 0.029) + 0.30).toFixed(2));
      const maxPrice      = resaleRule === 'original_plus_fees'
        ? parseFloat((originalPrice + stripeFee).toFixed(2))
        : null;

      console.log(`zeroscalp/check_eligibility: ✓ eligible ticket ${ticket_id} (rule: ${resaleRule})`);
      return res.status(200).json({
        eligible:         true,
        transfer_enabled: true,
        resale_rule:      resaleRule,
        max_price:        maxPrice,
        original_price:   originalPrice,
        stripe_fee:       stripeFee,
      });

    } catch (err) {
      console.error('zeroscalp/check_eligibility error:', err.message);
      return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}. Must be validate_price | check_eligibility` });
};
