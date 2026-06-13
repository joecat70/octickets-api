// /api/pin-event-config.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { configBlob } = req.body;
  const eventId = configBlob?.event_id || configBlob?.id;
  if (!configBlob || !eventId) {
    return res.status(400).json({ error: 'configBlob with event_id or id required' });
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
          name: `zeroscalp-config-${eventId}`,
          keyvalues: {
            event_id: eventId,
            venue_id: configBlob.venue_id || 'unknown',
            schema:   configBlob.schema_version || '1.0',
            type:     'zeroscalp_event_config',
          },
        },
        pinataOptions: { cidVersion: 1 },
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

    console.log(`✓ ZeroScalp config pinned: ${eventId} → ${cid}`);
    return res.status(200).json({ cid });

  } catch (err) {
    console.error('pin-event-config error:', err.message);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};
