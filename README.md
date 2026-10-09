# Schoolmathtime

A Reflect4-inspired browser-style web gateway. This is an independent project and is not affiliated with Reflect4.

## Features

- Browser-style tabs, navigation buttons, address bar, home page, and bookmarks.
- Search results are displayed inside Schoolmathtime using a Google Programmable Search Element. Search-result links are routed back through the proxy.
- `ALLOWED_HOSTS=*` mode accepts any public HTTPS hostname. Alternatively, set a comma-separated host allowlist.
- HTTPS connections are kept alive and reused. DNS lookups are cached for 30 seconds; successful HTML responses are cached for 30 seconds and small assets for up to 10 minutes.
- DNS results are checked and pinned to public IP addresses. Redirects are revalidated; private/reserved addresses, localhost, internal hostnames, and non-standard HTTPS ports are blocked.
- The server access key is checked server-side and login attempts are rate-limited.

## Google search setup

Google blocks ordinary server-side search fetches with a JavaScript verification page, so Schoolmathtime uses Google's browser-based Programmable Search Element to show results within its own search page.

1. Create a Programmable Search Engine at https://programmablesearchengine.google.com/.
2. Configure the engine to search the entire web (if that option is available in the engine settings).
3. Copy its Search engine ID (`cx`).
4. In Render, open the Schoolmathtime service, go to **Environment**, and add `GOOGLE_CSE_ID` with that ID.
5. Save and redeploy.

No Custom Search JSON API key is used by this embedded search element. Google result clicks are routed through Schoolmathtime where possible; Google account, consent, or other Google-hosted pages may still need to open directly.

## JavaScript compatibility and security

Proxied JavaScript is enabled, including inline scripts and common JavaScript resource types. Forms, frames, and embedded objects remain disabled. Some sites may still fail if they rely on module imports, API calls, strict origin checks, service workers, or other browser features that this gateway cannot fully translate.

**Security note:** Third-party scripts execute in the Schoolmathtime origin. Only browse sites you trust, and avoid using sensitive accounts or entering personal data on proxied pages. Keep the access key private. The gateway does not bypass a destination site's login, paywall, or other access controls.

## Run locally

Requires Node.js 20.9 or later.

```bash
npm ci
cp .env.example .env
```

Set unique values for `PROXY_ACCESS_KEY` (at least 16 characters) and `SESSION_SECRET` (at least 32 characters). Set `ALLOWED_HOSTS=*` for any public HTTPS hostnames, or provide a comma-separated allowlist. Set `GOOGLE_CSE_ID` to the ID of your Programmable Search Engine. Then run:

```bash
npm start
```

Open `http://localhost:3000`. Never commit `.env`.

## Deploy on Render

Create a **Web Service** from `flexworks-lab/Schoolmathtime`.

- Build command: `npm ci`
- Start command: `npm start`
- Environment variables: `PROXY_ACCESS_KEY`, `SESSION_SECRET`, `ALLOWED_HOSTS=*`, `GOOGLE_CSE_ID`, `NODE_ENV=production`, `TRUST_PROXY=1`

Render must run the latest commit, and production must use HTTPS. If `ALLOWED_HOSTS` is already defined in Render, update that existing value to `*`; changing `.env.example` in GitHub does not replace Render's configured value.

## Limits

The short-lived caches are stored in memory and are cleared when the service restarts. Free hosting plans can sleep or have limited CPU/network capacity, so they cannot guarantee instant first loads. Dynamic websites may remain incomplete where their behavior depends on browser APIs this proxy does not translate.
