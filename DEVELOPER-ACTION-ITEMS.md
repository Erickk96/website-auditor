# Developer Action Items — Hosting / Database Stability

**Date:** 2026-06-17
**Server:** 20iCloud managed server `vps-56aee9.mvps.stackcp.net` (host `kvmhost75.dfw.stackcp.net`) — 4 cores / 4 GB RAM, Dallas TX
**Scope:** ~90 WordPress sites share this ONE server and ONE database service (MariaDB).

## The problem (observed)
Many sites intermittently return **"Error establishing a database connection"** (HTTP 500) and/or are **unreachable / very slow** (responses up to 20+ seconds). 20i restarted MariaDB once, which recovered some sites temporarily, but database errors returned. This points to a **database that is unstable / overloaded under load**, not a one-time crash. With ~90 WordPress sites on a single 4 GB database, the most likely causes are connection limits, memory pressure, or query/plugin load.

---

## Priority 1 — Database stability (root cause)
- [ ] Review **MariaDB error logs** on the server for crashes, out-of-memory (OOM) kills, and "Too many connections" events.
- [ ] Check and, if needed, raise **`max_connections`**; verify it's appropriate for ~90 sites.
- [ ] Tune **`innodb_buffer_pool_size`** and other MariaDB memory settings for the workload.
- [ ] Identify any **single site / plugin running runaway or slow queries** that's exhausting DB resources (slow query log).
- [ ] Confirm with 20i whether **4 GB RAM is sufficient for ~90 WordPress sites**, or whether the server needs to be upgraded.

## Priority 2 — Reduce database load at the WordPress level
- [ ] Enable **caching** so pages don't hit the database on every request (page cache + object cache, e.g. Redis if available on 20i).
- [ ] Audit and remove/replace **heavy or poorly-coded plugins**.
- [ ] **Clean up databases**: expired transients, post revisions, spam comments, bloated `wp_options` autoload data (a very common cause of slow WP sites).

## Priority 3 — Sites still down individually
After the database is stable, re-check the sites that were **Unreachable** (e.g. fruit-palace.com, elmuchachoalegre2.com, mariscoselpercheron.com, amigostakos.com, tltacotruckclovis.com, tobaccoleafcorporation.com, tacosdonmarcos.com) to confirm whether they recover or have a separate issue (missing files, broken .htaccess, DNS).

## Priority 4 — Missing SSL certificates
Several domains have **no SSL certificate installed** and are serving 20i's default `*.stackcp.com` cert (e.g. **mjpupuseria.com**). In the 20i hosting panel these show an **"Add"** button under SSL.
- [ ] Install free **Let's Encrypt SSL** for every domain currently missing a certificate.

## Priority 5 — Remove the single point of failure (longer term)
- [ ] Evaluate **splitting sites across multiple servers/packages**, or moving higher-traffic sites off the shared box, so one database outage can't take down all ~90 client sites at once.

---

## Business note (not for developer)
Two domains are set to **NOT renew** and will expire — decide whether to keep them:
- `laprimera.online` — expires 2026-10-03
- `tampastylecubans.com` — expires 2026-07-21

## Monitoring
An automated auditor checks all sites and flags status, response time, SSL, and a plain-English diagnosis of any failure. Use it to confirm fixes and catch recurrences.
