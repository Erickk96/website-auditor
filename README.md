# Website Auditor

An interactive tool that checks whether a website is down or broken. It reports:

- **HTTP status** — is the site returning 200 OK or an error (404 / 500 / unreachable)?
- **Response time** — how fast the server responds, in milliseconds.
- **SSL certificate** — validity, issuer, and days until expiry.
- **Broken links** — scans the page and checks each link's status code.

Supports auditing a **single URL** or a **bulk list** of URLs at once.

## How it works

A small Node.js (Express) backend performs the checks server-side, so there are
no CORS limitations and SSL certificates can be inspected directly. The frontend
is a single static `index.html`.

```
browser (index.html)  →  POST /api/audit  →  Node server  →  target sites
```

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Replit

1. Import this repo into Replit (Create Repl → Import from GitHub).
2. Replit reads `.replit` / `replit.nix` and runs `npm start` automatically.
3. Hit **Run** — your live URL appears at the top.

## Project layout

| File | Purpose |
|------|---------|
| `index.html` | Frontend UI (tabs, results, styling) |
| `server.js`  | Express backend — HTTP probe, SSL inspection, link checker |
| `.replit` / `replit.nix` | Replit run + environment config |
