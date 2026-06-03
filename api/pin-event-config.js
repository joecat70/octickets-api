// ============================================================
// /api/pin-event-config.js
// OC Tickets Live · Ten-20-22 Holdings LLC
// ZeroScalp Step 2 — IPFS Event Config Pinning
//
// Receives the combined event + ZeroScalp config blob from the
// Add Event flow, pins it to IPFS via Pinata, and returns the CID.
// Pinata API key stays server-side — never exposed in client HTML.
//
// POST /api/pin-event-config
// Body: { configBlob: { ...full event + zeroscalp config object } }
// Returns: { cid: "Qm..." } on success
// ============================================================

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { configBlob } = req.body;

  if (!configBlob || !configBlob.event_id) {
    return res.status(400).json({ error: 'configBlob with event_id required' });
  }

  const PINATA_JWT = process.env.PINATA_JWT;
  if (!PINATA_JWT) {
    console.error('PINATA_JWT environment variable not set');
    return res.status(500).json({ error: 'Pinata not configured' });
  }

  try {
    const pinataRes = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PINATA_JWT}`,
      },
      body: JSON.stringify({
        pinataContent: configBlob,
        pinataMetadata: {
          name: `zeroscalp-config-${configBlob.event_id}`,
          keyvalues: {
            event_id:  configBlob.event_id,
            venue_id:  configBlob.venue_id  || 'unknown',
            schema:    configBlob.schema_version || '1.0',
            type:      'zeroscalp_event_config',
          },
        },
        pinataOptions: {
          cidVersion: 1,   // CIDv1 — base32 encoded, more future-proof than CIDv0
        },
      }),
    });

    if (!pinataRes.ok) {
      const errText = await pinataRes.text();
      console.error('Pinata error:', pinataRes.status, errText);
      return res.status(502).json({ error: 'Pinata pin failed', detail: errText });
    }

    const pinataData = await pinataRes.json();
    const cid = pinataData.IpfsHash;

    if (!cid) {
      console.error('Pinata returned no IpfsHash:', pinataData);
      return res.status(502).json({ error: 'Pinata returned no CID' });
    }

    console.log(`✓ ZeroScalp config pinned: ${configBlob.event_id} → ${cid}`);
    return res.status(200).json({ cid });

  } catch (err) {
    console.error('pin-event-config error:', err.message);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
