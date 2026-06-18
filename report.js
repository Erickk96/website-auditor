// Scheduled monitoring report.
// Audits every domain in domains.json and emails a summary.
// Run by GitHub Actions on a cron schedule (see .github/workflows/monitor.yml),
// or manually: `node report.js`.
//
// Email is sent via SMTP using these env vars (set as GitHub Secrets):
//   SMTP_HOST   (default: smtp.gmail.com)
//   SMTP_PORT   (default: 465)
//   SMTP_USER   your full email address (the sender)
//   SMTP_PASS   an app password (NOT your normal password)
//   MAIL_TO     comma-separated recipients
//   MAIL_FROM   optional; defaults to SMTP_USER
// If SMTP_USER/PASS are missing, the report just prints to the console.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nodemailer from 'nodemailer';
import { auditUrl, verdict } from './auditor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = 3; // gentle on shared hosting

async function auditAll(domains) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < domains.length) {
      const idx = i++;
      // withLinks:false — a monitoring sweep just needs up/down/status/SSL,
      // and skipping link scans keeps load off the shared database server.
      results[idx] = await auditUrl(domains[idx], { withLinks: false });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, domains.length) }, worker));
  return results;
}

function classify(results) {
  const up = [], errored = [], down = [], sslWarn = [];
  for (const r of results) {
    const v = verdict(r);
    if (v === 'up') up.push(r); else if (v === 'down') down.push(r); else errored.push(r);
    const days = r.ssl?.daysLeft;
    if (r.ssl && (r.ssl.expired || (r.ssl.valid && typeof days === 'number' && days < 14) || (!r.ssl.valid && r.ssl.protocol !== 'http')))
      sslWarn.push(r);
  }
  return { up, errored, down, sslWarn };
}

function host(r) { try { return new URL(r.url).hostname; } catch { return r.url; } }

function rows(list) {
  return list.map(r => {
    const code = r.status || 'N/A';
    const why = r.diagnosis?.label || r.error || '';
    const ms = r.latency != null ? `${r.latency} ms` : '—';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${host(r)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${code}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${ms}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#b91c1c">${why}</td>
    </tr>`;
  }).join('');
}

function buildEmail({ up, errored, down, sslWarn }, total, stampedAt) {
  const broken = [...down, ...errored];
  const allGood = broken.length === 0;
  const subject = allGood
    ? `✅ Website Monitor: all ${total} sites up`
    : `⚠️ Website Monitor: ${broken.length} of ${total} sites need attention`;

  const section = (title, list) => list.length ? `
    <h3 style="margin:18px 0 6px;font-family:sans-serif">${title} (${list.length})</h3>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px">
      <tr style="text-align:left;color:#666">
        <th style="padding:6px 10px">Site</th><th style="padding:6px 10px;text-align:center">Status</th>
        <th style="padding:6px 10px;text-align:right">Time</th><th style="padding:6px 10px">Diagnosis</th>
      </tr>${rows(list)}
    </table>` : '';

  const html = `
  <div style="font-family:sans-serif;color:#222;max-width:720px">
    <h2 style="margin:0 0 4px">Website Monitor Report</h2>
    <p style="color:#666;margin:0 0 14px">${stampedAt}</p>
    <p style="font-size:15px">
      ✅ <strong>${up.length}</strong> up &nbsp;·&nbsp;
      ⚠️ <strong>${errored.length}</strong> errors &nbsp;·&nbsp;
      🔴 <strong>${down.length}</strong> down &nbsp;·&nbsp;
      🔒 <strong>${sslWarn.length}</strong> SSL issues
      &nbsp;(of ${total} sites)
    </p>
    ${allGood ? '<p style="color:#15803d;font-weight:600">All sites are responding normally. 🎉</p>' : ''}
    ${section('🔴 Down / Unreachable', down)}
    ${section('⚠️ Errors', errored)}
    ${section('🔒 SSL Needs Attention', sslWarn)}
    ${section('✅ Up / Healthy', up)}
    <p style="color:#999;font-size:12px;margin-top:24px">Automated report from your Website Auditor.</p>
  </div>`;

  return { subject, html };
}

async function main() {
  const raw = await readFile(join(__dirname, 'domains.json'), 'utf8');
  const domains = JSON.parse(raw);
  console.log(`Auditing ${domains.length} domains…`);

  const results = await auditAll(domains);
  const buckets = classify(results);
  const stampedAt = new Date().toUTCString();
  const { subject, html } = buildEmail(buckets, domains.length, stampedAt);

  console.log(subject);
  console.log(`up=${buckets.up.length} errored=${buckets.errored.length} down=${buckets.down.length} sslWarn=${buckets.sslWarn.length}`);

  // Use || (not destructuring defaults) so empty-string env vars — which is how
  // GitHub Actions passes secrets that don't exist — fall back correctly.
  const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
  const SMTP_PORT = process.env.SMTP_PORT || '465';
  const { SMTP_USER, SMTP_PASS, MAIL_TO, MAIL_FROM } = process.env;

  if (!SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    console.log('\n[no SMTP credentials set — skipping email, printed summary only]');
    return;
  }

  const port = Number(SMTP_PORT);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: MAIL_TO,
    subject,
    html
  });
  console.log(`Email sent to ${MAIL_TO}`);
}

main().catch(err => {
  console.error('Report failed:', err);
  process.exit(1);
});
