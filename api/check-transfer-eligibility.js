// ============================================================
// /api/check-transfer-eligibility.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// ZeroScalp Step 3 — Server-side Transfer Eligibility Gate
//
// Called when a buyer opens the List on Exchange or Send as Gift
// modal. Server-side gate ensures transfer restrictions can't be
// bypassed by manipulating the UI or calling the API directly.
//
// POST /api/check-transfer-eligibility
// Body: { ticket_id: string }
// Returns:
//   { eligible: true, resale_rule: string, transfer_enabled: bool }
//   { eligible: false, reason: string }
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ticket_id } = req.body;

  if (!ticket_id) {
    return res.status(400).json({ error: 'ticket_id required' });
  }

  try {
    // ── 1. Load ticket ────────────────────────────────────────────────
    const { data: ticket, error: ticketErr } = await supabase
      .from('tickets')
      .select('id, event_id, status, price, stripe_fee')
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
      return res.status(200).json({
        eligible: false,
        reason:   `Ticket status is '${ticket.status}' — only valid tickets can be transferred`,
      });
    }

    // ── 2. Load event_config ──────────────────────────────────────────
    const { data: config, error: configErr } = await supabase
      .from('event_config')
      .select('transfer_enabled, resale_rule, price_cap_bps, doors_open')
      .eq('event_id', ticket.event_id)
      .maybeSingle();

    if (configErr) {
      console.error('event_config lookup error:', configErr.message);
      return res.status(500).json({ error: 'Event config lookup failed' });
    }

    // No event_config row = open event, all transfers permitted
    const transferEnabled = config?.transfer_enabled ?? true;
    const resaleRule      = config?.resale_rule      ?? 'open';

    // ── 3. Transfer gate ──────────────────────────────────────────────
    if (!transferEnabled) {
      console.log(`Transfer blocked: ticket ${ticket_id} — event has transfers disabled`);
      return res.status(200).json({
        eligible:         false,
        transfer_enabled: false,
        reason:           'Transfers are disabled for this event. You may request an exception transfer through the platform.',
        exception_eligible: true,   // signals HTML to show exception request flow (Step 5)
      });
    }

    // ── 4. Eligible — return config so frontend can apply cap UI ──────
    const originalPrice = parseFloat(ticket.price) || 0;
    const stripeFee     = parseFloat(ticket.stripe_fee) || parseFloat(((originalPrice * 0.029) + 0.30).toFixed(2));
    const maxPrice      = resaleRule === 'original_plus_fees'
      ? parseFloat((originalPrice + stripeFee).toFixed(2))
      : null;

    console.log(`✓ Transfer eligible: ticket ${ticket_id} (rule: ${resaleRule})`);
    return res.status(200).json({
      eligible:         true,
      transfer_enabled: true,
      resale_rule:      resaleRule,
      max_price:        maxPrice,     // null if open pricing, number if capped
      original_price:   originalPrice,
      stripe_fee:       stripeFee,
    });

  } catch (err) {
    console.error('check-transfer-eligibility error:', err.message);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
