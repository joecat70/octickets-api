// ============================================================
// /api/validate-resale-price.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// ZeroScalp Step 3 — Server-side Resale Price Cap Validator
//
// Dual-layer enforcement: frontend caps the input, this endpoint
// rejects anything that bypasses the UI. HTTP 400 on violation.
//
// POST /api/validate-resale-price
// Body: { ticket_id: string, asked_price: number }
// Returns:
//   { allowed: true, resale_rule: string }
//   { allowed: false, max_price: number, reason: string }
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key — bypasses RLS for authoritative reads
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ticket_id, asked_price } = req.body;

  if (!ticket_id || asked_price == null) {
    return res.status(400).json({ error: 'ticket_id and asked_price required' });
  }

  const askedNum = parseFloat(asked_price);
  if (isNaN(askedNum) || askedNum <= 0) {
    return res.status(400).json({ error: 'asked_price must be a positive number' });
  }

  try {
    // ── 1. Load ticket — get original price and stripe_fee ────────────
    const { data: ticket, error: ticketErr } = await supabase
      .from('tickets')
      .select('id, price, stripe_fee, event_id, status')
      .eq('id', ticket_id)
      .maybeSingle();

    if (ticketErr) {
      console.error('Ticket lookup error:', ticketErr.message);
      return res.status(500).json({ error: 'Ticket lookup failed' });
    }
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (ticket.status !== 'valid') {
      return res.status(400).json({ error: 'Ticket is not eligible for resale', status: ticket.status });
    }

    // ── 2. Load event_config — get resale_rule ────────────────────────
    const { data: config, error: configErr } = await supabase
      .from('event_config')
      .select('resale_rule, transfer_enabled')
      .eq('event_id', ticket.event_id)
      .maybeSingle();

    if (configErr) {
      console.error('event_config lookup error:', configErr.message);
      return res.status(500).json({ error: 'Event config lookup failed' });
    }

    // If no event_config row exists, default to open pricing
    const resaleRule      = config?.resale_rule      ?? 'open';
    const transferEnabled = config?.transfer_enabled  ?? true;

    // ── 3. Transfer gate ──────────────────────────────────────────────
    if (!transferEnabled) {
      return res.status(400).json({
        allowed: false,
        reason:  'Transfers are disabled for this event',
      });
    }

    // ── 4. Price cap enforcement ──────────────────────────────────────
    if (resaleRule === 'original_plus_fees') {
      const originalPrice = parseFloat(ticket.price)  || 0;
      const stripeFee     = parseFloat(ticket.stripe_fee) || parseFloat(((originalPrice * 0.029) + 0.30).toFixed(2));
      const maxPrice      = parseFloat((originalPrice + stripeFee).toFixed(2));

      if (askedNum > maxPrice) {
        console.log(`Price cap violation: ticket ${ticket_id} asked $${askedNum} max $${maxPrice}`);
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

    // ── 5. Approved ───────────────────────────────────────────────────
    console.log(`✓ Resale approved: ticket ${ticket_id} at $${askedNum} (rule: ${resaleRule})`);
    return res.status(200).json({
      allowed:     true,
      resale_rule: resaleRule,
      asked_price: askedNum,
    });

  } catch (err) {
    console.error('validate-resale-price error:', err.message);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
