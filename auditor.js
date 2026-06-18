// Shared audit logic — used by both the web server (server.js) and the
// scheduled report (report.js) so they run the exact same checks.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import tls from 'node:tls';
import { URL } from 'node:url';

// ── Low-level HTTP probe ─────────────────────────────────────────────────────
// Returns { status, latency, headers, body } or throws.
export function probe(targetUrl, { method = 'GET', maxRedirects = 5, timeout = 10000 } = {}) {
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

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && maxRedirects > 0) {
          res.resume();
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
        const MAX = 2 * 1024 * 1024;

        res.on('data', chunk => {
          if (collectBody && size < MAX) {
            body += chunk;
            size += chunk.length;
          }
        });
        res.on('end', () => {
          const latency = Number(process.hrtime.bigint() - t0) / 1e6;
          resolve({ status, latency: Math.round(latency), headers: res.headers, body: collectBody ? body : '' });
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── SSL certificate inspection ───────────────────────────────────────────────
export function inspectSSL(targetUrl, timeout = 10000) {
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
      { host: url.hostname, port: url.port || 443, servername: url.hostname, timeout },
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
export function extractLinks(html, baseUrl) {
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

// ── Diagnose common failure pages ────────────────────────────────────────────
export function diagnosePage({ status, body = '', error = '' }) {
  const text = (body || '').toLowerCase();

  if (/enotfound/i.test(error)) return { code: 'dns', label: 'Domain does not resolve (DNS) — check the domain is registered and pointed correctly.' };
  if (/econnrefused/i.test(error)) return { code: 'refused', label: 'Connection refused — the web server is not accepting connections.' };
  if (/timeout/i.test(error)) return { code: 'timeout', label: 'Timed out — server reachable (SSL ok) but not responding in time. Often a database/PHP hang.' };
  if (/cert|tls|ssl/i.test(error)) return { code: 'tls', label: 'SSL/TLS problem — certificate may be invalid or expired.' };

  if (text.includes('error establishing a database connection'))
    return { code: 'wp-db', label: 'WordPress can\'t reach its database (MySQL down or overloaded).' };
  if (text.includes('there has been a critical error'))
    return { code: 'wp-critical', label: 'WordPress critical error — usually a broken plugin or PHP fault.' };
  if (/account.{0,20}suspended|site.{0,20}suspended|suspended.{0,20}page/i.test(text))
    return { code: 'suspended', label: 'Hosting account/site appears SUSPENDED — billing or policy issue with the host.' };
  if (/maintenance|briefly unavailable for scheduled maintenance/i.test(text))
    return { code: 'maintenance', label: 'Site is in maintenance mode.' };

  if (status === 0) return { code: 'unreachable', label: 'Unreachable — no response from the server.' };
  if (status >= 500) return { code: 'server-error', label: `Server error (${status}) — the site\'s server failed to handle the request.` };
  if (status === 403) return { code: 'forbidden', label: 'Forbidden (403) — access blocked by the server.' };
  if (status === 404) return { code: 'notfound', label: 'Not found (404) — the page/site is missing.' };
  return null;
}

// ── Concurrency-limited link checker ─────────────────────────────────────────
export async function checkLinks(links, { limit = 8, max = 25 } = {}) {
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
      } catch {
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

// ── High-level: audit one URL ────────────────────────────────────────────────
// Set withLinks=false (e.g. for scheduled reports) to skip the per-page link
// scan and just check up/down/status/SSL — much lighter on the target server.
export async function auditUrl(rawUrl, { withLinks = true } = {}) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const result = { url, status: null, latency: null, ssl: null, links: null, error: null };

  async function probeWithRetry() {
    try {
      return await probe(url, { method: 'GET', timeout: 30000 });
    } catch (err) {
      if (/timeout/i.test(err.message)) return await probe(url, { method: 'GET', timeout: 30000 });
      throw err;
    }
  }

  const [probeResult, sslResult] = await Promise.allSettled([probeWithRetry(), inspectSSL(url)]);

  let body = '';
  if (probeResult.status === 'fulfilled') {
    const p = probeResult.value;
    result.status = p.status;
    result.latency = p.latency;
    result.finalUrl = p.finalUrl || url;
    result.redirected = !!p.redirected;
    result.server = p.headers?.server || null;
    result.contentType = p.headers?.['content-type'] || null;
    body = p.body || '';

    if (withLinks && p.body && p.status >= 200 && p.status < 400) {
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
  result.diagnosis = diagnosePage({ status: result.status, body, error: result.error || '' });
  return result;
}

// Health verdict helper used by the report.
export function verdict(r) {
  if (r.status >= 200 && r.status < 400) return 'up';
  if (r.status === 0) return 'down';
  return 'error';
}
