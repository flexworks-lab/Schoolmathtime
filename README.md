# Schoolmathtime

A Reflect4-inspired, configurable web gateway starter with a simple URL/search home page. This is an independent project and is not affiliated with Reflect4.

## Safety model

- The server only fetches HTTPS pages on domains explicitly configured by the operator.
- Access requires a server-side key; do not place the key in source code or frontend files.
- Redirects are checked at every hop, private/reserved IP targets are rejected, and responses have size/time limits.
- Proxied pages are read-only: scripts, forms, frames, and embedded objects are removed. This intentionally limits compatibility with sites that need JavaScript.
- This is not an unrestricted public proxy. Only enable domains you are authorized to access and serve.

## Run locally

Requires Node.js 20.18+.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set unique `PROXY_ACCESS_KEY` and `SESSION_SECRET` values. Adjust `ALLOWED_HOSTS` to the domains you explicitly approve, comma-separated. Start the app:

```bash
npm start
```

Open `http://localhost:3000`. The default example allowlist is intentionally small and should be adjusted for your deployment. Never commit `.env`.

## Deployment

Deploy as a Node web service (for example, Railway). Set `PROXY_ACCESS_KEY`, `SESSION_SECRET`, `ALLOWED_HOSTS`, and optionally `PORT` as environment variables. Set `NODE_ENV=production` to enable secure session cookies; production must use HTTPS. If your host terminates TLS in front of Node, configure `TRUST_PROXY=1` so secure cookies work behind that trusted proxy. A public deployment should use a strong random key and a small allowlist.

## Current limitations

The gateway provides a sanitized, read-only view. Login, allowlist enforcement, redirect checks, and request limits are server-side. Many modern sites will not work because active scripts/forms are disabled. Do not use this to bypass access controls, school policies, paywalls, or site restrictions.
