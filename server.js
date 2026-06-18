import express from 'express';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import tls from 'node:tls';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

// ── Low-level HTTP probe ─────────────────────────────────────────────────────
// Returns { status, latency, headers, body } or throws.
function probe(targetUrl, { method = 'GET', maxRedirects = 5, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch {
      return reject(new Error('Invalid URL'));
    }

    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const t0 = process.hrtime.bigint();

    const req = reqFn(
      url,
      {
        method,
        timeout,
        headers: {
          'User-Agent': 'WebsiteAuditor/1.0 (+https://github.com)',
          'Accept': 'text/html,application/xhtml+xml,*/*'
        }
      },
      (res) => {
        const status = res.statusCode;

        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && maxRedirects > 0) {
          res.resume(); // drain
          const nextUrl = new URL(res.headers.location, url).href;
          return resolve(
            probe(nextUrl, { method, maxRedirects: maxRedirects - 1, timeout })
              .then(r => ({ ...r, redirected: true, finalUrl: nextUrl }))
              .catch(reject)
          );
        }

        let body = '';
        const collectBody = method === 'GET';
        let size = 0;
        const MAX = 2 * 1024 * 1024; // 2MB cap

        res.on('data', chunk => {
          if (collectBody && size < MAX) {
            body += chunk;
            size += chunk.length;
          }
        });
        res.on('end', () => {
          const latency = Number(process.hrtime.bigint() - t0) / 1e6;
          resolve({
            status,
            latency: Math.round(latency),
            headers: res.headers,
            body: collectBody ? body : ''
          });
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── SSL certificate inspection ───────────────────────────────────────────────
function inspectSSL(targetUrl, timeout = 10000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch {
      return resolve({ valid: false, error: 'Invalid URL' });
    }

    if (url.protocol !== 'https:') {
      return resolve({ valid: false, protocol: 'http', note: 'No SSL (HTTP)' });
    }

    const socket = tls.connect(
      {
        host: url.hostname,
        port: url.port || 443,
        servername: url.hostname,
        timeout
      },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.end();

        if (!cert || !cert.valid_to) {
          return resolve({ valid: false, error: 'No certificate' });
        }

        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.round((validTo - new Date()) / (1000 * 60 * 60 * 24));

        resolve({
          valid: authorized,
          issuer: cert.issuer?.O || cert.issuer?.CN || 'Unknown',
          subject: cert.subject?.CN || url.hostname,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysLeft,
          expired: daysLeft < 0,
          authError: socket.authorizationError?.toString() || null
        });
      }
    );

    socket.on('error', (err) => resolve({ valid: false, error: err.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ valid: false, error: 'TLS timeout' }); });
  });
}

// ── Link extraction ──────────────────────────────────────────────────────────
function extractLinks(html, baseUrl) {
  const links = new Set();
  const regex = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      const href = new URL(m[1], baseUrl).href;
      if (/^https?:\/\//.test(href)) links.add(href);
    } catch {}
  }
  return [...links];
}

// ── Concurrency-limited link checker ─────────────────────────────────────────
async function checkLinks(links, { limit = 8, max = 25 } = {}) {
  const slice = links.slice(0, max);
  const results = [];
  let i = 0;

  async function worker() {
    while (i < slice.length) {
      const idx = i++;
      const link = slice[idx];
      try {
        const r = await probe(link, { method: 'HEAD', timeout: 8000 });
        results[idx] = { url: link, code: r.status, status: r.status >= 400 ? 'err' : 'ok' };
      } catch (err) {
        // Some servers reject HEAD — retry with GET once
        try {
          const r = await probe(link, { method: 'GET', timeout: 8000 });
          results[idx] = { url: link, code: r.status, status: r.status >= 400 ? 'err' : 'ok' };
        } catch (e2) {
          results[idx] = { url: link, code: 'ERR', status: 'err', error: e2.message };
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, slice.length) }, worker));
  return { results, total: links.length, checked: slice.length };
}

// ── API endpoint ─────────────────────────────────────────────────────────────
app.post('/api/audit', async (req, res) => {
  let { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url' });
  }
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const result = { url, status: null, latency: null, ssl: null, links: null, error: null };

  // Probe with one retry: slow shared hosts often time out on the first hit
  // (especially under concurrent load) but answer fine on a second attempt.
  async function probeWithRetry() {
    try {
      return await probe(url, { method: 'GET', timeout: 30000 });
    } catch (err) {
      if (/timeout/i.test(err.message)) {
        return await probe(url, { method: 'GET', timeout: 30000 });
      }
      throw err;
    }
  }

  // Run main probe + SSL in parallel
  const [probeResult, sslResult] = await Promise.allSettled([
    probeWithRetry(),
    inspectSSL(url)
  ]);

  if (probeResult.status === 'fulfilled') {
    const p = probeResult.value;
    result.status = p.status;
    result.latency = p.latency;
    result.finalUrl = p.finalUrl || url;
    result.redirected = !!p.redirected;
    result.server = p.headers?.server || null;
    result.contentType = p.headers?.['content-type'] || null;

    if (p.body && p.status >= 200 && p.status < 400) {
      const links = extractLinks(p.body, result.finalUrl);
      result.links = await checkLinks(links);
    } else {
      result.links = { results: [], total: 0, checked: 0 };
    }
  } else {
    result.status = 0;
    result.error = probeResult.reason?.message || 'Unreachable';
    result.links = { results: [], total: 0, checked: 0 };
  }

  result.ssl = sslResult.status === 'fulfilled' ? sslResult.value : { valid: false, error: 'SSL check failed' };

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
      headers: {
        'Authorization': 'Bearer ' + bearer,
        'Accept': 'application/json'
      }
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(r.status).json({
        error: `20i API returned ${r.status}`,
        detail: text.slice(0, 300)
      });
    }

    const data = await r.json();
    // /domain returns an array of objects with a `name` field.
    const domains = (Array.isArray(data) ? data : [])
      .map(d => d.name)
      .filter(Boolean)
      .sort();

    res.json({ count: domains.length, domains });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach 20i API', detail: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Website Auditor running on http://localhost:${PORT}`);
});
