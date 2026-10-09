# Schoolmathtime

A browser-style HTTPS proxy with a compact toolbar, responsive pages, and video embed support. It is an independent project.

## Features

- Single-row browser toolbar, navigation buttons, address bar, home page, and bookmarks. The tab strip and passkey prompt are removed.
- Plain-text searches open Google's actual Search website through the Schoolmathtime proxy; website URLs are proxied the same way.
- Proxied websites receive responsive sizing rules so images and layout containers fit the browser width, while wide tables and code can scroll within their own areas.
- `ALLOWED_HOSTS=*` mode accepts any public HTTPS hostname. Alternatively, set a comma-separated host allowlist.
- HTTPS connections are kept alive and reused. DNS lookups are cached for 30 seconds; successful HTML responses are cached for 30 seconds and small assets for up to 10 minutes.
- DNS results are checked and pinned to public IP addresses. Redirects are revalidated; private/reserved addresses, localhost, internal hostnames, and non-standard HTTPS ports are blocked.
- Browsing is public with no passkey; requests remain rate-limited and private/internal IP targets and non-standard HTTPS ports are blocked.

## Google search

Entering a search phrase opens `https://www.google.com/search?q=...` through the normal Schoolmathtime proxy. The proxy fetches Google's page and rewrites supported links and resources to remain inside Schoolmathtime. Google may still return its own consent or automated-traffic verification page, and some Google features may not work through a server-side proxy.

## Video, JavaScript, and security

Direct YouTube watch/Shorts URLs open in a responsive YouTube player below the toolbar. Supported video embeds (including YouTube, Vimeo, Twitch, Dailymotion, Spotify, SoundCloud, Loom, TikTok, and Bilibili) can run in their own frames. HTML5 audio/video sources use a streaming route with byte-range support. Playback still depends on provider rules, CORS, browser APIs, licensing, age restrictions, and whether the uploader permits embedding. No generic proxy can make every site behave exactly as it does on its native origin.

Some site JavaScript, forms, service workers, protected playback, and origin-locked APIs may not work correctly. Since the passkey is removed, the service is public; set `ALLOWED_HOSTS` to a short trusted domain list if it should not browse the entire public web. Keep HTTPS/IP validation and rate limiting enabled. Do not use the proxy for sensitive accounts or private data; third-party page scripts execute in this proxy session. The proxy does not bypass a destination site's access controls.

## Run locally

Requires Node.js 20.9 or later.

```bash
npm ci
cp .env.example .env
```

Set `ALLOWED_HOSTS=*` for any public HTTPS hostnames, or provide a comma-separated allowlist to restrict destinations. No access key or session secret is needed. Then run:

```bash
npm start
```

Open `http://localhost:3000`. Never commit `.env`.

## Deploy on Render

Create a **Web Service** from `flexworks-lab/Schoolmathtime`.

- Build command: `npm ci`
- Start command: `npm start`
- Environment variables: `ALLOWED_HOSTS=*`, `NODE_ENV=production`, `TRUST_PROXY=1`

Render must run the latest commit, and production must use HTTPS. If `ALLOWED_HOSTS` is already defined in Render, update that existing value to `*`; changing `.env.example` in GitHub does not replace Render's configured value.

## Limits

The short-lived caches are stored in memory and are cleared when the service restarts. Free hosting plans can sleep or have limited CPU/network capacity, so they cannot guarantee instant first loads. Dynamic websites may remain incomplete where their behavior depends on browser APIs this proxy does not translate.
