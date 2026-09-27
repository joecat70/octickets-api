// api/ocr-score.js
// Write path into the SAME octix_live_frames table api/live-score.js already
// writes to — a bowler's self-entered frames and a volunteer's camera-
// extracted frames land in the identical shape, so the existing live
// scoreboard page and shareable scorecard links display either source with
// zero new rendering code. This is a new WRITE path into an existing
// READ/DISPLAY path, not a parallel system (see live-score.js's own header
// comment for the full trust-boundary rationale this inherits — nothing
// here ever touches octix_scores, brackets, standings, or prize money
// either).
//
// Identity here works differently than live-score.js's bowler-claim-token
// model, because there's no single bowler driving this — a phone photo of
// the monitor identifies a registrant by Team # (= that bowler's
// lane_number, confirmed by Joe) + row position (lane_position, A-F)
// rather than by a token belonging to one person. GET below is the narrow
// roster lookup that makes that match possible: id + lane_number +
// lane_position + name only, never a full registrant record — so
// score-capture.html can resolve "Team 5, position B" to a registrant id
// entirely client-side, once per event rather than once per photo.
//
// NOT YET GATED (Joe's explicit call, Sept 2026): no PIN/auth on POST while
// this is solo-tested by Joe only. No PII moves through this endpoint
// either way — frames are just integers — so the actual exposure is
// limited to "someone with the URL could write junk onto a public live
// board," the same unofficial/display-only risk live-score.js already
// accepts, not a data leak. Revisit before this runs at a real tournament
// with the URL sitting on a volunteer's phone rather than just Joe's.
//
// GET  /api/ocr-score?event_id=evt_xxx
//   → { success: true, roster: [{ id, lane_number, lane_position, name }] }
//   Active registrants only (excludes refunded/cancelled, and anyone with
//   no lane_number yet) — same posture as assignNextLane()'s occupancy
//   query in admin.
//
// POST /api/ocr-score   body: { event_id, registrant_id, game_num, frames }
//   → { success: true } | { error: '...' }
//   Same raw-pinfall validation as live-score.js (integer 0-10 per ball,
//   max 3 balls/frame, max 10 frames) — never trusts client-side score math
//   here either. Confirms registrant_id actually belongs to event_id before
//   writing, same cross-event-reuse guard live-score.js applies via its
//   token's registrant, just checked directly since there's no token here.
const { createClient } = require('@supabase/supabase-js');

function getDB() {
  const url = process.env.SUPABASE_EVENTS_URL;
  const key = process.env.SUPABASE_EVENTS_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let sb;
  try { sb = getDB(); } catch (e) { return res.status(500).json({ error: e.message }); }

  if (req.method === 'GET') {
    const { event_id } = req.query || {};
    if (!event_id) return res.status(400).json({ error: 'event_id required' });
    try {
      const { data, error } = await sb
        .from('octix_registrants')
        .select('id, lane_number, lane_position, first_name, last_name')
        .eq('event_id', event_id)
        .not('lane_number', 'is', null)
        .neq('status', 'refunded')
        .neq('status', 'cancelled');
      if (error) throw error;
      const roster = (data || []).map(r => ({
        id: r.id,
        lane_number: r.lane_number,
        lane_position: r.lane_position,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null,
      }));
      return res.status(200).json({ success: true, roster });
    } catch (err) {
      console.error('ocr-score GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { event_id, registrant_id, game_num, frames } = body || {};

    if (!event_id || !registrant_id || !game_num || !Array.isArray(frames)) {
      return res.status(400).json({ error: 'event_id, registrant_id, game_num, and frames[] are required' });
    }
    if (frames.length > 10) return res.status(400).json({ error: 'frames cannot exceed 10' });
    // Same rule as live-score.js: never trust client-side score math, only
    // raw pinfall, validated the identical way.
    for (const f of frames) {
      if (!f || !Array.isArray(f.balls)) return res.status(400).json({ error: 'each frame needs a balls[] array' });
      if (f.balls.length > 3) return res.status(400).json({ error: 'a frame cannot have more than 3 balls' });
      for (const b of f.balls) {
        if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 10) {
          return res.status(400).json({ error: 'each ball must be an integer 0-10' });
        }
      }
    }

    try {
      // Confirm this registrant actually belongs to the event being posted
      // to — same cross-event guard live-score.js applies via its token's
      // registrant, just checked directly here since there's no token.
      const { data: reg, error: regErr } = await sb
        .from('octix_registrants')
        .select('id, event_id')
        .eq('id', registrant_id)
        .maybeSingle();
      if (regErr) throw regErr;
      if (!reg || reg.event_id !== event_id) {
        return res.status(403).json({ error: 'This registrant does not belong to the specified event.' });
      }

      const { error: upsertErr } = await sb.from('octix_live_frames').upsert({
        event_id,
        registrant_id,
        game_num,
        frames,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'event_id,registrant_id,game_num' });
      if (upsertErr) throw upsertErr;

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('ocr-score POST error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
