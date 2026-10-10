# Schoolmathtime

A browser-style HTTPS proxy with a compact toolbar, responsive pages, and video embed support. It is an independent project.

## Features

- Single-row browser toolbar, navigation buttons, address bar, home page, and bookmarks. The tab strip and passkey prompt are removed.
- The homepage sends new browsing sessions through the Ultraviolet service-worker engine, while the original `/browse` proxy remains available as a fallback.
- Proxied websites receive responsive sizing rules so images and layout containers fit the browser width, while wide tables and code can scroll within their own areas.
- `ALLOWED_HOSTS=*` mode accepts any public HTTPS hostname. Alternatively, set a comma-separated host allowlist.
- The classic `/browse` proxy keeps HTTPS connections alive and reuses them. DNS lookups are cached for 30 seconds and successful responses are cached within configured memory limits.
- DNS results are checked and pinned to public IP addresses. Redirects are revalidated; private/reserved addresses, localhost, internal hostnames, and non-standard HTTPS ports are blocked.
- Browsing is public with no passkey; requests remain rate-limited and private/internal IP targets and non-standard HTTPS ports are blocked.

## Google search

Entering a search phrase opens Google's Search page through the Ultraviolet service-worker engine. The classic `/browse` route remains available for troubleshooting and fallback.

## YouTube API search

The home page includes a YouTube search panel backed by the official YouTube Data API v3. Search results and thumbnail metadata are fetched server-side; the API key is read only from the `YOUTUBE_API_KEY` environment variable and is never sent to browser JavaScript. Search result links stay inside Schoolmathtime and open the native YouTube watch page through the Ultraviolet service-worker route. The Data API returns video metadata only; it does not provide video streams.

To enable search:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API v3**, and create an API key.
2. Restrict the key to **YouTube Data API v3** and keep it server-side.
3. In Render, open the Schoolmathtime web service's **Environment** settings and add `YOUTUBE_API_KEY` with your key as the value. Redeploy the service.
4. Return to Schoolmathtime and use the **YouTube video search** panel on the home page.

The default code limit is 80 uncached searches per rolling 24-hour window to preserve quota. It can be lowered or raised up to 90 with `YOUTUBE_SEARCH_DAILY_CAP`. Repeated searches are cached for 10 minutes. The YouTube Data API default quota for `search.list` is 100 calls per day; Google may change project limits. See the [official search.list documentation](https://developers.google.com/youtube/v3/docs/search/list) and [API key security guidance](https://docs.cloud.google.com/docs/authentication/api-keys).

## Official YouTube account connection

The home page can connect a Google account using Google's server-side OAuth authorization-code flow with PKCE. It requests the read-only YouTube scope and displays the connected Google account and YouTube channel details. Google sign-in happens on Google's own page and returns to Schoolmathtime; this is not an attempt to copy Google cookies into the proxy. **This connection does not log the user into the YouTube website inside Ultraviolet.** It only authorizes official YouTube Data API features.

To enable it:

1. In Google Cloud Console, select the project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and add your own Google account as a test user while the app is in Testing.
3. Create an OAuth client of type **Web application**. Add the Schoolmathtime site origin (scheme + hostname only) as an authorized JavaScript origin, and register the exact callback URL as an authorized redirect URI.
4. In Render, add these server-side environment variables:
   - **GOOGLE_OAUTH_CLIENT_ID** — the Web application client ID.
   - **GOOGLE_OAUTH_CLIENT_SECRET** — the client secret; never put this in browser JavaScript or commit it.
   - **GOOGLE_OAUTH_REDIRECT_URI** — the exact callback registered in Cloud Console, ending in /auth/google/callback (for example, https://YOUR-SCHOOLMATHTIME-HOST/auth/google/callback).
5. Redeploy Schoolmathtime and use **Connect with Google** in the YouTube video search panel.

The access token is exchanged and held only in server memory; it is not sent to the browser and is not persisted to disk. The connection expires with the token or a server restart, so the user may need to reconnect. Disconnect attempts to revoke the token with Google's revocation endpoint. Public apps requesting user-data scopes may need Google OAuth verification before use beyond the configured test users; follow the requirements shown in Cloud Console.

## Ultraviolet browser engine

The homepage address bar and YouTube search results use the Ultraviolet service-worker engine. The original server-side proxy at `/browse` remains available using the **Use classic browser** fallback. Ultraviolet assets are served from the installed npm package; the server uses `@mercuryworkshop/wisp-js` for its Wisp transport.

The Wisp transport is limited to TCP port 443, denies direct IP targets and private/loopback addresses, and applies `ALLOWED_HOSTS` as a hostname allowlist when an explicit allowlist is configured. This does not guarantee that all websites or videos will work. Schoolmathtime's `/health` endpoint includes an `ultraviolet` boolean so deployment readiness can be checked.

**Compatibility note:** Ultraviolet-App is marked as superseded by Scramjet by its maintainers. This integration is an experimental test of Ultraviolet, not a promise of compatibility with every browser or YouTube's anti-abuse systems. If the Wisp connection is unavailable or a website refuses the request, use the classic browser or the website's supported access method.

## Video, JavaScript, and security

YouTube search is backed by the official Data API. Search-result clicks open the native YouTube watch URL in the Ultraviolet-based browser shell inside Schoolmathtime, without an external redirect or YouTube iframe player. Ultraviolet uses a browser service worker and Wisp transport instead of the classic server-side HTML fetch, but YouTube can still restrict playback based on its policies, IP reputation, or network controls.

Supported video embeds (including Vimeo, Twitch, Dailymotion, Spotify, SoundCloud, Loom, TikTok, and Bilibili) can run in their own frames. HTML5 audio/video sources use a streaming route with byte-range support. Playback still depends on provider rules, CORS, browser APIs, licensing, age restrictions, and whether the uploader permits embedding. No generic proxy can make every site behave exactly as it does on its native origin.

Some site JavaScript, forms, service workers, protected playback, and origin-locked APIs may not work correctly. Since the passkey is removed, the service is public; set `ALLOWED_HOSTS` to a short trusted domain list if it should not browse the entire public web. Keep HTTPS/IP validation and rate limiting enabled. Do not use the proxy for sensitive accounts or private data; third-party page scripts execute in this proxy session. The proxy does not bypass a destination site's access controls.

## Run locally

Requires Node.js 24 or later, as specified in package.json.

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
