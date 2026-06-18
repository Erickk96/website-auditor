import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { auditUrl } from './auditor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

// ── Audit a single URL ───────────────────────────────────────────────────────
app.post('/api/audit', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url' });
  }
  const result = await auditUrl(url, { withLinks: true });
  res.json(result);
});

// ── 20i: list owned domains ──────────────────────────────────────────────────
// Reads the general API key from the TWENTYI_API_KEY env var (set as a Replit
// Secret — never committed). The key is base64-encoded into a Bearer token.
app.get('/api/domains', async (req, res) => {
  const key = process.env.TWENTYI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'TWENTYI_API_KEY is not set. Add it as a Replit Secret (Tools → Secrets).'
    });
  }

  const bearer = Buffer.from(key).toString('base64');

  try {
    const r = await fetch('https://api.20i.com/domain', {
      headers: { 'Authorization': 'Bearer ' + bearer, 'Accept': 'application/json' }
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(r.status).json({ error: `20i API returned ${r.status}`, detail: text.slice(0, 300) });
    }

    const data = await r.json();
    const domains = (Array.isArray(data) ? data : []).map(d => d.name).filter(Boolean).sort();
    res.json({ count: domains.length, domains });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach 20i API', detail: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Website Auditor running on http://localhost:${PORT}`);
});
