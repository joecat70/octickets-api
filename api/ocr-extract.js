// api/ocr-extract.js
// Server-side vision extraction for the camera-based scoreboard capture
// project. This is the piece score-capture.html needs that a claude.ai
// published artifact structurally can't provide on its own: a plain page
// hosted on sflscholarshiptour.com can't reach an external API through
// Claude's own `sample` mechanism (that only runs inside a claude.ai-hosted
// artifact view) — so the vision call happens here instead, using Joe's
// own Anthropic API key. This is a straight port of the same prompt/schema
// already validated in the disposable chat test tools, not a new design.
//
// Requires ANTHROPIC_API_KEY set as a Vercel env var (console.anthropic.com
// -> API Keys). Each call costs a small, real amount on that account — a
// few cents at most per image on Sonnet — separate from and unrelated to
// Joe's Claude.ai subscription usage.
//
// POST /api/ocr-extract   body: { image_base64: string, media_type: string }
//   -> { success: true, extraction: {...} } | { error: '...' }
//   "extraction" is the same shape the chat test tools already validated:
//   { team_number, lane_number, game_number, bowlers: [{ name_or_initials,
//   frames: [{balls:[...]}], monitor_total, row_notes }], notes }
//
// Deliberately stateless and read-only — this never touches Supabase.
// score-capture.html calls this first, does the Team#/position match and
// parity cross-check client-side exactly as the test tool already does,
// then POSTs the matched result to api/ocr-score.js separately to write.

const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const PROMPT = `You're looking at a photo of a bowling tournament scoreboard monitor. It may show one lane's worth of bowlers (up to 6, stacked top to bottom, one row each), across up to 10 frames of a game. Two numbers matter beyond the score grid itself, usually visible near the top: a "Team #" for the lane group (this represents the bowlers' starting/home lane) and the game number ("G. #"). A lane-number placard may also be visible, mounted above the monitor, in-frame or off to the side.

For each bowler row, read the frames exactly as displayed and convert every mark into the actual number of pins knocked down per ball thrown so far (0-10 each) — not the display symbol. Standard scoresheet notation: "X" = strike = one ball worth 10. A frame shown like "N/" (a digit or dash, then a slash) = spare: ball 1 = N (0 if dash), ball 2 = 10 - N. A frame shown as two plain values like "N,M" or "N M" = open frame: ball 1 = N, ball 2 = M (0 for a dash/miss), no spare. A single lone value with nothing after it = only one ball thrown so far in that frame. Apply the same per-ball logic to the 10th frame's up to three balls, including any bonus ball after a strike or spare — each is still just a 0-10 pin count.

Reply with ONLY a JSON object in this exact shape, no other text:

{
  "team_number": string or null,
  "lane_number": string or null,
  "game_number": string or null,
  "bowlers": [
    {
      "name_or_initials": string,
      "frames": [ { "balls": [number, ...] }, ... ],
      "monitor_total": number or null,
      "row_notes": string or null
    }
  ],
  "notes": string
}

List bowler rows top-to-bottom exactly as they appear on screen — their on-screen order is meaningful and must be preserved as given. "frames" has one entry per frame column visible for that bowler, in order; a frame with no ball thrown yet is { "balls": [] }. "monitor_total" is whatever running/cumulative score the screen itself displays for that bowler right now, if any — null if the screen shows none. Put anything blurry, cut off, glare-obscured, or ambiguous into the relevant notes field. If this doesn't clearly show a bowling scoreboard, say so in "notes" and leave the rest empty.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { image_base64, media_type } = body || {};

  if (!image_base64 || !media_type) {
    return res.status(400).json({ error: 'image_base64 and media_type are required' });
  }
  if (!ALLOWED_MEDIA_TYPES.includes(media_type)) {
    return res.status(400).json({ error: 'media_type must be one of: ' + ALLOWED_MEDIA_TYPES.join(', ') });
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1536,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image_base64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('ocr-extract: Anthropic API error:', data);
      return res.status(502).json({ error: (data && data.error && data.error.message) || 'Vision request failed' });
    }

    const textBlock = (data.content || []).find(c => c.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No text in vision response' });

    let raw = textBlock.text.trim();
    // Defensive parsing, same as any structured-output call — strip a
    // ```json fence if the model wrapped the reply in one.
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let extraction;
    try {
      extraction = JSON.parse(raw);
    } catch (e) {
      console.error('ocr-extract: could not parse JSON from model output:', raw);
      return res.status(502).json({ error: 'Could not parse extraction result' });
    }

    return res.status(200).json({ success: true, extraction });
  } catch (err) {
    console.error('ocr-extract error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
