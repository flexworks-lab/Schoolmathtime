# Schoolmathtime

A Reflect4-inspired, configurable web gateway starter with a simple URL/search home page. This is an independent project and is not affiliated with Reflect4.

## Safety model

`ALLOWED_HOSTS=*` allows any public HTTPS hostname; otherwise use a comma-separated allowlist. Only standard HTTPS port 443 is supported.
- Access requires a server-side key; do not place the key in source code or frontend files.
Redirects are revalidated at every hop, DNS answers are checked and pinned to public addresses, private/reserved IP targets are rejected, and responses have size/time limits.
- Proxied pages are read-only: scripts, forms, frames, and embedded objects are removed. This intentionally limits compatibility with sites that need JavaScript.
Keep the access key private. This gateway does not bypass a destination site's own login, paywall, or access controls.

## Run locally

Requires Node.js 20.18+.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set unique `PROXY_ACCESS_KEY` and `SESSION_SECRET` values. Set `ALLOWED_HOSTS=*` to accept any public HTTPS hostname, or enter a comma-separated list. Start the app:

```bash
npm start
```

Open `http://localhost:3000`. Never commit `.env`.

## Deployment

Deploy as a Node web service (for example, Render). Set `PROXY_ACCESS_KEY`, `SESSION_SECRET`, `ALLOWED_HOSTS`, and optionally `PORT` as environment variables. Set `NODE_ENV=production` to enable secure session cookies; production must use HTTPS. If your host terminates TLS in front of Node, configure `TRUST_PROXY=1` so secure cookies work behind that trusted proxy. Any public deployment should use a strong random key. Wildcard host mode broadens which public websites can be fetched.

## Current limitations

The gateway caches successful HTML responses in memory for 30 seconds, small assets for up to 10 minutes, and validated DNS answers for 30 seconds to make repeat browsing faster. Caches clear when the service restarts. The gateway provides a sanitized, read-only view: active scripts and forms are disabled, so sites that depend on them will not fully work. This does not bypass a website's own access controls.
