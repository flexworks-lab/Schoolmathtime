"use strict";

const path = require("node:path");
const { createServer } = require("node:http");
const dns = require("node:dns").promises;
const net = require("node:net");
const https = require("node:https");
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 60_000 });
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cheerio = require("cheerio");
const ipaddr = require("ipaddr.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 5;
const DNS_CACHE_TTL_MS = 30_000;
// A ceiling only: memory is used as successful responses are cached, not reserved up front.
const RESPONSE_CACHE_MAX_ENTRIES = 1024;
// Keep the cache bounded for memory-limited hosts such as Render. This is a
// RAM ceiling, not preallocated storage. Ignore invalid values rather than
// letting NaN/negative limits disable eviction or cause an empty-map crash.
const DEFAULT_RESPONSE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const MAX_RESPONSE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const requestedCacheBytes = Number(process.env.RESPONSE_CACHE_MAX_BYTES);
const RESPONSE_CACHE_MAX_BYTES = Number.isSafeInteger(requestedCacheBytes) &&
  requestedCacheBytes >= 16 * 1024 * 1024
  ? Math.min(requestedCacheBytes, MAX_RESPONSE_CACHE_MAX_BYTES)
  : DEFAULT_RESPONSE_CACHE_MAX_BYTES;
const UPSTREAM_COOLDOWN_MS = 2 * 60_000;
const UPSTREAM_MAX_COOLDOWN_MS = 15 * 60_000;
const YOUTUBE_REQUEST_GAP_MS = 350;
const YOUTUBE_MAX_CONCURRENT_REQUESTS = 2;
const YOUTUBE_MAX_QUEUED_REQUESTS = 48;
const YOUTUBE_SEARCH_CACHE_TTL_MS = 10 * 60_000;
const YOUTUBE_SEARCH_CACHE_MAX_ENTRIES = 100;
const YOUTUBE_API_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_SEARCH_WINDOW_MS = 24 * 60 * 60_000;
const requestedYouTubeDailyCap = Number(process.env.YOUTUBE_SEARCH_DAILY_CAP || 80);
const YOUTUBE_SEARCH_DAILY_CAP = Number.isSafeInteger(requestedYouTubeDailyCap)
  ? Math.max(1, Math.min(90, requestedYouTubeDailyCap))
  : 80;
const dnsCache = new Map();
const responseCache = new Map();
const upstreamCooldowns = new Map();
const upstreamQueues = new Map();
const youtubeSearchCache = new Map();
let youtubeSearchWindowStartedAt = Date.now();
let youtubeSearchApiCalls = 0;
let responseCacheBytes = 0;
let ultravioletReady = false;

function parseAllowedHosts(value) {
  return [...new Set(String(value || "").split(",").map((item) =>
    item.trim().toLowerCase().replace(/^\.+|\.$/g, "")
  ).filter((host) => host && !host.includes("/") && !host.includes(":") && !net.isIP(host)))];
}

const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);

if (!ALLOWED_HOSTS.length) {
  console.error("Configuration error: set ALLOWED_HOSTS to at least one approved hostname.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && !process.env.PUBLIC_ORIGIN) {
  console.warn("PUBLIC_ORIGIN is not set. Configure it to your HTTPS origin if deploying behind a proxy.");
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'", "ws:", "wss:"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"]
  }
}}));

// Ultraviolet's BareMux transport constructs an AsyncFunction inside its worker.
// Keep the site's default CSP strict, but allow the required dynamic evaluation
// only on the Ultraviolet shell and the proxy-engine assets that run its code.
app.use((req, res, next) => {
  const pathname = req.path || "/";
  const isUltravioletSurface = pathname === "/ultraviolet.html" ||
    pathname.startsWith("/uv/") ||
    pathname.startsWith("/baremux/") ||
    pathname.startsWith("/epoxy/");
  if (isUltravioletSurface) {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self' data: blob: https:",
      "script-src 'self' 'unsafe-eval' https:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: ws: wss:",
      "worker-src 'self' blob:",
      "child-src 'self' blob: https:",
      "frame-src 'self' blob: https:",
      "font-src 'self' data: https:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join("; "));
  }
  next();
});

app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
const fetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Rate limit reached. Please wait a moment."
});
const youtubeSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many YouTube searches. Please wait a minute and try again." }
});

function allowPublicBrowsing(_req, _res, next) {
  // Access keys are disabled by request. Public routes still retain the rate
  // limit, HTTPS-only policy, public-IP DNS validation, and redirect checks.
  return next();
}

function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("..")) return false;
  if (ALLOWED_HOSTS.includes("*")) return true;
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed));
}

function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function resolveHostAddresses(hostname) {
  // Prefer the system resolver. If it fails transiently, fall back to DNS A/AAAA
  // records while applying the same public-address checks before any connection.
  try {
    const systemAddresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (systemAddresses.length) {
      return systemAddresses.map(({ address, family }) => ({ address, family }));
    }
  } catch {
    // Fall through to explicit A/AAAA queries.
  }

  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname)
  ]);
  const addresses = [];
  if (v4.status === "fulfilled") {
    for (const address of v4.value) addresses.push({ address, family: 4 });
  }
  if (v6.status === "fulfilled") {
    for (const address of v6.value) addresses.push({ address, family: 6 });
  }
  if (!addresses.length) throw new Error("DNS could not resolve this hostname. Check the address or try again.");
  return addresses;
}

async function validateTarget(input) {
  let target;
  try {
    target = new URL(input);
  } catch {
    throw new Error("Enter a complete URL or a search phrase.");
  }
  if (target.protocol !== "https:") throw new Error("Only HTTPS websites are supported.");
  if (target.port && target.port !== "443") throw new Error("Only standard HTTPS websites on port 443 are supported.");
  if (target.username || target.password) throw new Error("URLs containing credentials are not allowed.");
  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || net.isIP(hostname) || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      hostname.endsWith(".internal") || !hostname.includes(".") || !isAllowedHost(hostname)) {
    throw new Error("That domain is not available in this proxy.");
  }
  target.hash = "";

  let addresses;
  const cachedDns = dnsCache.get(hostname);
  if (cachedDns && cachedDns.expiresAt > Date.now()) {
    addresses = cachedDns.addresses;
    dnsCache.delete(hostname);
    dnsCache.set(hostname, cachedDns);
  } else {
    try {
      addresses = await resolveHostAddresses(hostname);
    } catch (error) {
      throw new Error(error.message || "DNS lookup failed. Check the domain or try again.");
    }
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new Error("The destination resolves to a private or reserved network and was blocked.");
    }
    dnsCache.set(hostname, { addresses, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    while (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value);
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("The destination resolves to a private or reserved network and was blocked.");
  }
  return { target, addresses };
}

function normalizeInput(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Enter a URL or search phrase.");
  if (value.length > 2048) throw new Error("The URL or search phrase is too long.");
  if (value.startsWith("https://") || value.startsWith("http://")) return value;
  if (!/\s/.test(value) && value.includes(".")) {
    return "https://" + value;
  }
  return "https://www.google.com/search?gbv=1&q=" + encodeURIComponent(value);
}


function isSupportedMediaFrame(target) {
  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  const path = target.pathname;
  if ((host === "youtube.com" || host.endsWith(".youtube.com")) && /^\/(?:embed|live)\//.test(path)) return true;
  if ((host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) && path.startsWith("/embed/")) return true;
  if (host === "player.vimeo.com" && path.startsWith("/video/")) return true;
  if (host === "open.spotify.com" && path.startsWith("/embed/")) return true;
  if (host === "w.soundcloud.com" && path === "/player/") return true;
  if ((host === "www.dailymotion.com" && path.startsWith("/embed/")) ||
      (host === "geo.dailymotion.com" && path.startsWith("/player/"))) return true;
  if (host === "player.twitch.tv" && (target.searchParams.has("video") || target.searchParams.has("channel") || target.searchParams.has("collection"))) return true;
  if (host === "clips.twitch.tv" && path.startsWith("/embed")) return true;
  if (host === "www.loom.com" && path.startsWith("/embed/")) return true;
  if (host === "www.tiktok.com" && path.startsWith("/embed/")) return true;
  if (host === "www.facebook.com" && path === "/plugins/video.php") return true;
  if (host === "player.bilibili.com" && path === "/player.html") return true;
  return false;
}

async function collectLimited(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("The remote response is larger than the configured safety limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function isYouTubeUpstreamHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\\.$/, "");
  return host === "youtube.com" || host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com") ||
    host === "youtubei.googleapis.com" || host.endsWith(".youtubei.googleapis.com");
}

function upstreamRateLimitKey(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\\.$/, "");
  if (host === "youtubei.googleapis.com" || host.endsWith(".youtubei.googleapis.com")) return "youtubei.googleapis.com";
  if (host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) return "youtube-nocookie.com";
  if (host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube.com";
  return host;
}

function noteUpstreamRateLimit(key, headers = {}) {
  const now = Date.now();
  const raw = String(headers["retry-after"] || "").trim();
  let waitMs = UPSTREAM_COOLDOWN_MS;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      waitMs = Math.max(UPSTREAM_COOLDOWN_MS, Math.min(UPSTREAM_MAX_COOLDOWN_MS, seconds * 1000));
    } else {
      const retryAt = Date.parse(raw);
      if (Number.isFinite(retryAt)) {
        waitMs = Math.max(UPSTREAM_COOLDOWN_MS, Math.min(UPSTREAM_MAX_COOLDOWN_MS, retryAt - now));
      }
    }
  }
  const until = now + waitMs;
  upstreamCooldowns.set(key, Math.max(upstreamCooldowns.get(key) || 0, until));
  while (upstreamCooldowns.size > 500) upstreamCooldowns.delete(upstreamCooldowns.keys().next().value);
  return upstreamCooldowns.get(key);
}

function cooldownError(key) {
  const seconds = Math.max(1, Math.ceil(((upstreamCooldowns.get(key) || Date.now()) - Date.now()) / 1000));
  const error = new Error("YouTube is temporarily rate-limiting requests. Schoolmathtime has paused requests; try again in about " + seconds + " seconds.");
  error.status = 429;
  error.retryAfter = seconds;
  return error;
}

// Pace requests to YouTube-related hosts and cap parallel fetches. If YouTube
// returns 429, pause that upstream and reject queued work rather than retrying
// or continuing to send a burst of requests.
function scheduleYouTubeRequest(hostname, task) {
  const key = upstreamRateLimitKey(hostname);
  return new Promise((resolve, reject) => {
    let state = upstreamQueues.get(key);
    if (!state) {
      state = { pending: [], active: 0, lastStartedAt: 0, timer: null };
      upstreamQueues.set(key, state);
    }
    if (state.pending.length >= YOUTUBE_MAX_QUEUED_REQUESTS) {
      const error = new Error("Too many YouTube resources are waiting to load. Wait a moment and reload the page.");
      error.status = 503;
      reject(error);
      return;
    }
    state.pending.push({ task, resolve, reject });
    pumpYouTubeQueue(key, state);
  });
}

function pumpYouTubeQueue(key, state) {
  if (state.timer || state.active >= YOUTUBE_MAX_CONCURRENT_REQUESTS || !state.pending.length) return;
  const cooldownUntil = upstreamCooldowns.get(key) || 0;
  const cooldownWait = cooldownUntil - Date.now();
  if (cooldownWait > 0) {
    state.timer = setTimeout(() => {
      state.timer = null;
      pumpYouTubeQueue(key, state);
    }, cooldownWait);
    return;
  }
  if (cooldownUntil) upstreamCooldowns.delete(key);

  const wait = YOUTUBE_REQUEST_GAP_MS - (Date.now() - state.lastStartedAt);
  if (wait > 0) {
    state.timer = setTimeout(() => {
      state.timer = null;
      pumpYouTubeQueue(key, state);
    }, wait);
    return;
  }

  const item = state.pending.shift();
  state.active += 1;
  state.lastStartedAt = Date.now();
  Promise.resolve().then(item.task).then((result) => {
    if (result?.status === 429) {
      noteUpstreamRateLimit(key, result.headers || {});
      const error = cooldownError(key);
      while (state.pending.length) state.pending.shift().reject(error);
    }
    item.resolve(result);
  }, item.reject).finally(() => {
    state.active -= 1;
    if (state.pending.length) pumpYouTubeQueue(key, state);
    else if (state.active === 0) {
      if (state.timer) clearTimeout(state.timer);
      upstreamQueues.delete(key);
    }
  });
  // Start the next queued request after the configured gap, without waiting
  // for this response body to finish first.
  pumpYouTubeQueue(key, state);
}

function readResponseCache(key, allowStale = false) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now && (!allowStale || (entry.staleUntil || entry.expiresAt) <= now)) {
    if ((entry.staleUntil || entry.expiresAt) <= now) {
      responseCache.delete(key);
      responseCacheBytes -= entry.body.length;
    }
    return null;
  }
  if (entry.expiresAt <= now && !allowStale) return null;
  responseCache.delete(key);
  responseCache.set(key, entry);
  return {
    target: new URL(entry.target),
    contentType: entry.contentType,
    body: Buffer.from(entry.body),
    status: entry.status,
    cached: true,
    stale: entry.expiresAt <= now
  };
}

function writeResponseCache(key, result) {
  const bodySize = result.body?.length || 0;
  const isHtml = result.contentType.includes("text/html") || result.contentType.includes("application/xhtml+xml");
  const maxItemBytes = isHtml ? MAX_PAGE_BYTES : 2 * 1024 * 1024;
  if (!bodySize || bodySize > maxItemBytes || bodySize > RESPONSE_CACHE_MAX_BYTES) return;

  const existing = responseCache.get(key);
  if (existing) {
    responseCacheBytes -= existing.body.length;
    responseCache.delete(key);
  }
  const ttl = isHtml ? 2 * 60_000 : 30 * 60_000;
  const entry = {
    target: result.target.toString(),
    contentType: result.contentType,
    body: Buffer.from(result.body),
    status: result.status,
    expiresAt: Date.now() + ttl,
    // Keep successful pages available for fallback during temporary upstream
    // throttling or timeouts. This is a stale-cache window, not a retry loop.
    staleUntil: Date.now() + ttl + (isHtml ? 6 * 60 * 60_000 : 24 * 60 * 60_000)
  };
  responseCache.set(key, entry);
  responseCacheBytes += entry.body.length;
  while (responseCache.size > RESPONSE_CACHE_MAX_ENTRIES || responseCacheBytes > RESPONSE_CACHE_MAX_BYTES) {
    const oldestKey = responseCache.keys().next().value;
    const oldest = responseCache.get(oldestKey);
    responseCache.delete(oldestKey);
    responseCacheBytes -= oldest.body.length;
  }
}

function requestPinned(target, addresses, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };

    const selected = addresses.find((entry) => entry.family === 4) || addresses[0];
    const request = https.request({
      protocol: "https:",
      hostname: target.hostname,
      port: 443,
      servername: target.hostname,
      method: "GET",
      path: target.pathname + target.search,
      maxHeaderSize: 16 * 1024,
      agent: upstreamAgent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/css,*/*;q=0.8"
      },
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      }
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        response.once("end", () => finish(null, { status, location, headers: response.headers, body: Buffer.alloc(0) }));
        response.once("error", (error) => finish(error));
        return;
      }

      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > maxBytes) {
        response.destroy();
        finish(new Error("The remote response is larger than the configured safety limit."));
        return;
      }
      collectLimited(response, maxBytes).then((body) => {
        finish(null, { status, headers: response.headers, body });
      }).catch(finish);
    });

    const timeout = setTimeout(() => {
      const error = new Error("The remote website took too long to respond.");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    }, FETCH_TIMEOUT_MS);
    request.on("error", (error) => {
      if (error.code === "ETIMEDOUT") {
        const timeoutError = new Error("The remote website took too long to respond.");
        timeoutError.code = "ETIMEDOUT";
        timeoutError.status = 504;
        finish(timeoutError);
      } else {
        const fetchError = new Error("Unable to fetch that website.");
        fetchError.code = error.code || "UPSTREAM_FETCH_FAILED";
        fetchError.status = 502;
        finish(fetchError);
      }
    });
    request.end();
  });
}

async function fetchApproved(input, maxBytes, redirectCount = 0) {
  const { target, addresses } = await validateTarget(input);
  const cacheKey = target.toString();
  const cached = readResponseCache(cacheKey);
  if (cached) return cached;

  // Respect shared cooldowns across YouTube subdomains and serve stale content
  // when available instead of making another upstream request.
  const rateLimitKey = upstreamRateLimitKey(target.hostname);
  const cooldownUntil = upstreamCooldowns.get(rateLimitKey);
  if (cooldownUntil && cooldownUntil > Date.now()) {
    const stale = readResponseCache(cacheKey, true);
    if (stale) return stale;
    throw cooldownError(rateLimitKey);
  }
  if (cooldownUntil) upstreamCooldowns.delete(rateLimitKey);

  let response;
  try {
    const request = () => requestPinned(target, addresses, maxBytes);
    response = isYouTubeUpstreamHost(target.hostname)
      ? await scheduleYouTubeRequest(target.hostname, request)
      : await request();
  } catch (error) {
    // A previously successful page is more useful than a transient upstream
    // timeout. Do not retry the origin here; use the bounded stale cache.
    const stale = readResponseCache(cacheKey, true);
    if (stale) return stale;
    if (!Number.isInteger(error.status)) error.status = error.code === "ETIMEDOUT" ? 504 : 502;
    error.upstreamHost = target.hostname;
    throw error;
  }
  if (response.status === 429) {
    // The request scheduler has already set the shared cooldown and stopped
    // queued requests. Prefer a previously fetched copy if one remains usable.
    const stale = readResponseCache(cacheKey, true);
    if (stale) return stale;
    const error = new Error("The remote website is temporarily rate-limiting requests (HTTP 429). Please wait before trying again.");
    error.status = 429;
    error.upstreamHost = target.hostname;
    error.retryAfter = Math.max(1, Math.ceil(((upstreamCooldowns.get(rateLimitKey) || Date.now() + UPSTREAM_COOLDOWN_MS) - Date.now()) / 1000));
    throw error;
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (!response.location) throw new Error("The remote website sent an invalid redirect.");
    if (redirectCount >= MAX_REDIRECTS) throw new Error("The website redirected too many times.");
    const next = new URL(response.location, target).toString();
    const redirected = await fetchApproved(next, maxBytes, redirectCount + 1);
    writeResponseCache(cacheKey, redirected);
    return redirected;
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error("The remote website returned HTTP " + response.status + ".");
    error.status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    error.upstreamHost = target.hostname;
    throw error;
  }
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (!response.body?.length) throw new Error("The remote website returned an empty response.");
  const result = { target, contentType, body: response.body, status: response.status };
  writeResponseCache(cacheKey, result);
  return result;
}

function safeProxyPath(pathname, value) {
  return pathname + "?url=" + encodeURIComponent(value);
}

async function streamRemoteMedia(input, req, res, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    if (!res.headersSent) res.status(502).end("The media source redirected too many times.");
    return;
  }
  const { target, addresses } = await validateTarget(input);
  const mediaRateLimitKey = upstreamRateLimitKey(target.hostname);
  if (isYouTubeUpstreamHost(target.hostname)) {
    const cooldownUntil = upstreamCooldowns.get(mediaRateLimitKey) || 0;
    if (cooldownUntil > Date.now()) {
      const error = cooldownError(mediaRateLimitKey);
      if (!res.headersSent) {
        res.set("Retry-After", String(error.retryAfter));
        res.status(429).type("text/plain").send(error.message);
        return;
      }
      throw error;
    }
    if (cooldownUntil) upstreamCooldowns.delete(mediaRateLimitKey);
  }

  await new Promise((resolve) => {
    const selected = addresses.find((entry) => entry.family === 4) || addresses[0];
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "video/*,audio/*,image/*,application/octet-stream;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "identity"
    };
    const range = String(req.headers.range || "");
    if (/^bytes=\d*-\d*(?:,\d*-\d*)?$/.test(range)) headers.Range = range;
    if (headers.Range && typeof req.headers["if-range"] === "string") {
      headers["If-Range"] = req.headers["if-range"].slice(0, 300);
    }

    let timeout;
    const request = https.request({
      protocol: "https:",
      hostname: target.hostname,
      port: 443,
      servername: target.hostname,
      method: req.method === "HEAD" ? "HEAD" : "GET",
      path: target.pathname + target.search,
      maxHeaderSize: 16 * 1024,
      agent: upstreamAgent,
      headers,
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      }
    }, (upstream) => {
      clearTimeout(timeout);
      const status = upstream.statusCode || 502;
      const location = upstream.headers.location;
      if (isYouTubeUpstreamHost(target.hostname)) {
        const contentType = String(upstream.headers["content-type"] || "unknown").split(";")[0];
        console.info(
          "Proxy /media upstream response:",
          "host=" + target.hostname,
          "status=" + status,
          "type=" + contentType,
          "method=" + (req.method || "GET"),
          "range=" + (headers.Range ? "requested" : "none"),
          "redirect=" + (location ? "yes" : "no")
        );
      }
      if (status === 429 && isYouTubeUpstreamHost(target.hostname)) {
        noteUpstreamRateLimit(mediaRateLimitKey, upstream.headers);
        const error = cooldownError(mediaRateLimitKey);
        upstream.resume();
        if (!res.headersSent) {
          res.set("Retry-After", String(error.retryAfter));
          res.status(429).type("text/plain").send(error.message);
        }
        resolve();
        return;
      }
      if ([301, 302, 303, 307, 308].includes(status)) {
        upstream.resume();
        upstream.once("end", () => {
          if (!location) {
            if (!res.headersSent) res.status(502).end("The media source sent an invalid redirect.");
            resolve();
            return;
          }
          let next;
          try { next = new URL(location, target).toString(); }
          catch {
            if (!res.headersSent) res.status(502).end("The media source sent an invalid redirect.");
            resolve();
            return;
          }
          streamRemoteMedia(next, req, res, redirectCount + 1).then(resolve).catch((error) => {
            if (!res.headersSent) res.status(502).end(error.message || "Media could not be loaded.");
            else res.destroy(error);
            resolve();
          });
        });
        return;
      }

      if (![200, 206, 416].includes(status)) {
        upstream.resume();
        if (!res.headersSent) res.status(status >= 400 ? status : 502).end("The media source returned HTTP " + status + ".");
        resolve();
        return;
      }

      res.status(status);
      const contentType = String(upstream.headers["content-type"] || "application/octet-stream").split(";")[0];
      res.set("Content-Type", contentType);
      res.set("Accept-Ranges", upstream.headers["accept-ranges"] || "bytes");
      for (const header of ["content-length", "content-range", "last-modified", "etag"]) {
        const value = upstream.headers[header];
        if (typeof value === "string" && !/[\r\n]/.test(value)) res.set(header, value);
      }
      res.set("Cache-Control", "private, max-age=120");
      res.set("X-Content-Type-Options", "nosniff");
      if (req.method === "HEAD" || status === 416) {
        upstream.resume();
        res.end();
        resolve();
        return;
      }
      upstream.on("error", (error) => {
        if (!res.headersSent) res.status(502).end("The media stream failed.");
        else res.destroy(error);
        resolve();
      });
      res.on("close", () => upstream.destroy());
      upstream.pipe(res);
      upstream.once("end", resolve);
    });

    timeout = setTimeout(() => request.destroy(new Error("Media source timed out.")), FETCH_TIMEOUT_MS);
    request.on("error", (error) => {
      clearTimeout(timeout);
      if (!res.headersSent) res.status(502).type("text/plain").send(error.message || "Media could not be loaded.");
      else res.destroy(error);
      resolve();
    });
    request.end();
  });
}


function rewriteCss(css, sourceUrl) {
  const rewrite = (raw) => {
    const candidate = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
    if (!candidate || candidate.startsWith("#") || /^data:image\//i.test(candidate)) return candidate;
    try {
      const absolute = new URL(candidate, sourceUrl);
      if (!["https:", "http:"].includes(absolute.protocol)) return "";
      if (!isAllowedHost(absolute.hostname)) return "";
      return safeProxyPath("/resource", absolute.toString());
    } catch {
      return "";
    }
  };
  let output = String(css || "");
  output = output.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    const rewritten = rewrite(value);
    return rewritten ? "url('" + rewritten.replace(/'/g, "%27") + "')" : 'url("")';
  });
  output = output.replace(/@import\s+(['"])(.*?)\1\s*;/gi, (match, quote, value) => {
    const rewritten = rewrite(value);
    return rewritten ? "@import url('" + rewritten.replace(/'/g, "%27") + "');" : "";
  });
  return output;
}

function proxyDocument(remoteHtml, sourceUrl, origin) {
  const $ = cheerio.load(remoteHtml);
  $("noscript, frame, frameset, object, embed, applet, base, portal").remove();
  $("meta[http-equiv]").remove();
  $("link[rel='modulepreload'], link[rel='preload'], link[rel='prefetch'], link[rel='prerender']").remove();
  $("*").each((_, element) => {
    const node = $(element);
    const attrs = { ...element.attribs };
    for (const [name, originalValue] of Object.entries(attrs)) {
      const lower = name.toLowerCase();
      const value = String(originalValue || "").trim();
      if (["srcdoc", "action", "formaction", "integrity", "nonce", "crossorigin"].includes(lower)) {
        node.removeAttr(name);
        continue;
      }
      if (lower === "style") {
        node.attr(name, rewriteCss(value, sourceUrl));
        continue;
      }
      if (lower === "srcset") {
        // Preserve responsive image candidates; cross-origin HTTPS images are
        // explicitly allowed by the proxied page's CSP.
        continue;
      }

      if (lower === "src" && element.tagName === "iframe") {
        try {
          const frameUrl = new URL(value, sourceUrl);
          if (frameUrl.protocol !== "https:" || !isAllowedHost(frameUrl.hostname) || !isSupportedMediaFrame(frameUrl)) {
            node.remove();
            continue;
          }
          node.attr(name, frameUrl.toString());
          node.attr("loading", "lazy");
          node.attr("referrerpolicy", "strict-origin-when-cross-origin");
          node.attr("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
          node.attr("allowfullscreen", "");
        } catch { node.remove(); }
        continue;
      }
      if (lower === "href") {
        if (value.startsWith("#")) continue;
        if (/^(?:javascript|vbscript|file|data):/i.test(value)) {
          node.removeAttr(name);
          continue;
        }
        if (element.tagName === "link") {
          if (!/stylesheet|icon/i.test(String(attrs.rel || ""))) {
            node.removeAttr(name);
            continue;
          }
          try {
            const absolute = new URL(value, sourceUrl);
            if (!["https:", "http:"].includes(absolute.protocol) || !isAllowedHost(absolute.hostname)) {
              node.remove();
              continue;
            }
            node.attr(name, safeProxyPath("/resource", absolute.toString()));
          } catch { node.remove(); }
          continue;
        }
        try {
          const absolute = new URL(value, sourceUrl);
          if (!["https:", "http:"].includes(absolute.protocol) || !isAllowedHost(absolute.hostname)) {
            node.removeAttr(name);
            continue;
          }
          node.attr(name, safeProxyPath("/browse", absolute.toString()));
          node.attr("rel", "noreferrer noopener");
        } catch { node.removeAttr(name); }
        continue;
      }
      if (["src", "poster"].includes(lower)) {
        if (/^(?:javascript|vbscript|file):/i.test(value)) {
          node.removeAttr(name);
          continue;
        }
        try {
          const absolute = new URL(value, sourceUrl);
          if (!["https:", "http:"].includes(absolute.protocol) || !isAllowedHost(absolute.hostname)) {
            node.removeAttr(name);
            continue;
          }
          const mediaElement = lower === "src" && ["video", "audio", "source", "track"].includes(element.tagName);
          node.attr(name, safeProxyPath(mediaElement ? "/media" : "/resource", absolute.toString()));
          node.attr("referrerpolicy", "no-referrer");
        } catch { node.removeAttr(name); }
      }
    }
  });

  const source = new URL(sourceUrl);
  const hostLabel = escapeAttribute(source.hostname);
  // Google Search's native form must be routed back through the proxy. Since
  // generic form actions are intentionally stripped, intercept Google search
  // submits and construct a fresh Google URL instead of submitting to /browse
  // as /browse?url=jk&sei=... .
  if (/(^|\.)google\.com$/i.test(source.hostname) && source.pathname.startsWith("/search")) {
    $("head").append('<script>(function(){document.addEventListener("submit",function(event){var form=event.target;if(!form||!form.querySelector)return;var field=form.querySelector("input[name=q]");if(!field)return;var query=String(field.value||"").trim();if(!query)return;event.preventDefault();var target=new URL("https://www.google.com/search");target.searchParams.set("gbv","1");target.searchParams.set("q",query);["tbm","hl","safe","num","start","udm"].forEach(function(name){var option=Array.prototype.find.call(form.elements,function(el){return el.name===name});if(option&&option.value)target.searchParams.set(name,option.value)});window.location.assign("/browse?url="+encodeURIComponent(target.toString()))},true)})();</script>');
  }
  // Route origin-relative searches through the proxy because upstream form actions
  // are stripped for safety before this handler is injected.
  // Route origin-relative searches through the proxy because upstream form actions
  // are intentionally stripped for safety before this handler is injected.
  if (/(^|\.)youtube\.com$/i.test(source.hostname)) {
    $("head").append('<script>(function(){function go(event){var form=event.target;if(!form||!form.querySelector)return;var field=form.querySelector("input[name=search_query],input#search");if(!field)return;var query=String(field.value||"").trim();if(!query)return;event.preventDefault();event.stopImmediatePropagation();var target=new URL("https://www.youtube.com/results");target.searchParams.set("search_query",query);window.location.assign("/browse?url="+encodeURIComponent(target.toString()))}document.addEventListener("submit",go,true);document.addEventListener("keydown",function(event){if(event.key!=="Enter")return;var field=event.target;if(!field||!field.matches||!field.matches("input[name=search_query],input#search")||!field.form)return;go({target:field.form,preventDefault:function(){event.preventDefault()},stopImmediatePropagation:function(){event.stopImmediatePropagation()}})},true)})();</script>');
  }

  if (/(^|\.)tiktok\.com$/i.test(source.hostname)) {
    $("head").append('<script>(function(){function go(event){var form=event.target;if(!form||!form.querySelector)return;var field=form.querySelector("input[name=q],input[name=keyword],input[data-e2e=search-user-input],input[placeholder*=Search]");if(!field)return;var query=String(field.value||"").trim();if(!query)return;event.preventDefault();event.stopImmediatePropagation();var target=new URL("https://www.tiktok.com/search");target.searchParams.set("q",query);window.location.assign("/browse?url="+encodeURIComponent(target.toString()))}document.addEventListener("submit",go,true);document.addEventListener("keydown",function(event){if(event.key!=="Enter")return;var field=event.target;if(!field||!field.matches||!field.matches("input[name=q],input[name=keyword],input[data-e2e=search-user-input],input[placeholder*=Search]")||!field.form)return;go({target:field.form,preventDefault:function(){event.preventDefault()},stopImmediatePropagation:function(){event.stopImmediatePropagation()}})},true)})();</script>');
  }

  const toolbar = `<div id="stm-browser-chrome" role="region" aria-label="Schoolmathtime browser controls">
    <div class="stm-toolbar-row">
      <div class="stm-controls">
        <button id="stm-back" class="stm-control" type="button" title="Back" aria-label="Back">←</button>
        <button id="stm-forward" class="stm-control" type="button" title="Forward" aria-label="Forward">→</button>
        <button id="stm-refresh" class="stm-control" type="button" title="Reload" aria-label="Reload">↻</button>
        <a class="stm-control home" href="/" title="Home" aria-label="Home">⌂</a>
      </div>
      <form id="stm-address-form" class="stm-address-form" action="/browse" method="get" role="search">
        <span class="stm-address-security" aria-hidden="true">◈</span>
        <input id="stm-address" name="url" value="${escapeAttribute(sourceUrl)}" aria-label="Search or enter an address" spellcheck="false" autocomplete="url">
        <button class="stm-address-go" type="submit">Go ↵</button>
      </form>
      <button id="stm-bookmark" class="stm-control" type="button" title="Bookmark page" aria-label="Bookmark page">☆</button>
      <button id="stm-menu" class="stm-control" type="button" title="Browser information" aria-label="Browser information">⋮</button>
    </div>
    <div id="stm-browser-notice" class="stm-browser-notice" role="status" aria-live="polite" hidden></div>
  </div>`;
  $("head").append('<link rel="stylesheet" href="/browser-chrome.css?v=single-toolbar-2"><link rel="stylesheet" href="/proxy-fit.css?v=layout-preserve-2"><script src="/proxy-chrome.js?v=ultraviolet-engine-1" defer></script>');
  $("body").prepend(toolbar);
  if (!$("body").length) $("html").append("<body>" + toolbar + "</body>");
  // Only apply the YouTube masthead offset when the upstream page actually
  // contains YouTube's site header (not the custom video-player fallback).
  if ((source.hostname === "youtube.com" || source.hostname.endsWith(".youtube.com")) &&
      $("ytd-app, ytm-app, #masthead-container, ytd-masthead, ytm-mobile-topbar-renderer").length) {
    $("body").addClass("stm-proxied-youtube-page");
  }
  $("body").addClass("stm-proxied-page");
  const originalBodyStyle = $("body").attr("style") || "";
  $("body").attr("style", [originalBodyStyle, "margin:0"].filter(Boolean).join(";"));
  $("head").append('<meta name="referrer" content="no-referrer">');
  $("title").text(($("title").text() || new URL(sourceUrl).hostname) + " — Schoolmathtime");
  const page = $.html();
  return page.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">');
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.use(express.static(path.join(__dirname, "..", "public"), {
  index: "index.html",
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  setHeaders(res, filePath) {
    // Keep HTML and the service-worker entry/config fresh. A stale uv.config.js
    // can make /uv/sw.js recursively import itself after a configuration fix.
    if (/\.html?$/i.test(filePath) ||
        /[/\\\\]uv[/\\\\](?:uv\.config\.js|sw\.js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

app.get("/health", (_req, res) => res.json({ ok: true, ultraviolet: ultravioletReady }));

app.get("/api/youtube/search", allowPublicBrowsing, youtubeSearchLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const query = String(req.query.q || "").trim().replace(/\\s+/g, " ").slice(0, 120);
  if (!query) return res.status(400).json({ error: "Enter something to search for." });
  if (query.length < 2) return res.status(400).json({ error: "Enter at least two characters." });

  const apiKey = String(process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(503).json({
      error: "YouTube API is not configured yet. Add YOUTUBE_API_KEY to the Schoolmathtime server environment."
    });
  }

  const cacheKey = query.toLocaleLowerCase("en-US");
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    youtubeSearchCache.delete(cacheKey);
    youtubeSearchCache.set(cacheKey, cached);
    return res.json({ query, items: cached.items, cached: true });
  }
  if (cached) youtubeSearchCache.delete(cacheKey);

  if (Date.now() - youtubeSearchWindowStartedAt >= YOUTUBE_SEARCH_WINDOW_MS) {
    youtubeSearchWindowStartedAt = Date.now();
    youtubeSearchApiCalls = 0;
  }
  if (youtubeSearchApiCalls >= YOUTUBE_SEARCH_DAILY_CAP) {
    return res.status(429).json({
      error: "Schoolmathtime's daily YouTube search limit has been reached. Try again later."
    });
  }

  try {
    const endpoint = new URL(YOUTUBE_API_ENDPOINT);
    endpoint.searchParams.set("part", "snippet");
    endpoint.searchParams.set("type", "video");
    endpoint.searchParams.set("maxResults", "12");
    endpoint.searchParams.set("safeSearch", "moderate");
    endpoint.searchParams.set("regionCode", "US");
    endpoint.searchParams.set("q", query);

    // Keep the server-side API key out of the request URL and its access logs.
    // Google supports sending API keys in the x-goog-api-key header.
    // Each uncached search request uses YouTube Data API quota.
    youtubeSearchApiCalls += 1;
    const upstream = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-goog-api-key": apiKey
      },
      signal: AbortSignal.timeout(12_000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const reason = String(payload?.error?.errors?.[0]?.reason || payload?.error?.status || "");
      if (["quotaExceeded", "dailyLimitExceeded", "userRateLimitExceeded"].includes(reason)) {
        return res.status(429).json({
          error: "YouTube API search quota has been reached. Searches will work again when Google's quota resets."
        });
      }
      if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
        console.warn("YouTube Data API configuration rejected the search:", upstream.status, reason || "unknown reason");
        return res.status(503).json({
          error: "YouTube API rejected the server key. Check that YouTube Data API v3 is enabled and the key is configured correctly in Render."
        });
      }
      console.warn("YouTube Data API request failed:", upstream.status, reason || "unknown reason");
      return res.status(502).json({ error: "YouTube search is temporarily unavailable. Try again later." });
    }

    const items = (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
      const id = String(item?.id?.videoId || "");
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return [];
      const snippet = item.snippet || {};
      const rawThumbnail = snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "";
      let thumbnail = "";
      try {
        const parsedThumbnail = new URL(rawThumbnail);
        const thumbHost = parsedThumbnail.hostname.toLowerCase();
        if (parsedThumbnail.protocol === "https:" &&
            (thumbHost === "ytimg.com" || thumbHost.endsWith(".ytimg.com") ||
             thumbHost === "ggpht.com" || thumbHost.endsWith(".ggpht.com"))) {
          thumbnail = parsedThumbnail.toString();
        }
      } catch {}
      return [{
        id,
        title: String(snippet.title || "Untitled video").slice(0, 300),
        description: String(snippet.description || "").slice(0, 700),
        channelTitle: String(snippet.channelTitle || "").slice(0, 160),
        publishedAt: String(snippet.publishedAt || ""),
        thumbnail: thumbnail ? "/resource?url=" + encodeURIComponent(thumbnail) : "",
        // Keep the navigation on Schoolmathtime; don't send a new tab directly
        // to YouTube and don't put an API key in any browser-visible URL.
        watchUrl: "/ultraviolet.html?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id)
      }];
    });

    youtubeSearchCache.set(cacheKey, { items, expiresAt: Date.now() + YOUTUBE_SEARCH_CACHE_TTL_MS });
    while (youtubeSearchCache.size > YOUTUBE_SEARCH_CACHE_MAX_ENTRIES) {
      youtubeSearchCache.delete(youtubeSearchCache.keys().next().value);
    }
    return res.json({ query, items, cached: false });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return res.status(504).json({ error: "YouTube search timed out. Please try again." });
    }
    console.warn("YouTube Data API request failed:", error?.message || "unknown error");
    return res.status(502).json({ error: "Unable to contact the YouTube Data API right now." });
  }
});

app.get("/api/session", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    authenticated: true,
    allowedHosts: ALLOWED_HOSTS.filter((host) => host !== "*"),
    browseAllPublicDomains: ALLOWED_HOSTS.includes("*")
  });
});

app.get("/search", allowPublicBrowsing, (req, res) => {
  // Compatibility route for cached pages: explicitly proxy Google's real search URL.
  const query = String(req.query.q || "").trim().slice(0, 300);
  if (!query) return res.redirect(302, "/");
  const target = "https://www.google.com/search?gbv=1&q=" + encodeURIComponent(query);
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  return res.redirect(302, "/ultraviolet.html?url=" + encodeURIComponent(target));
});

app.get("/youtube-player", allowPublicBrowsing, (req, res) => {
  // Compatibility for stale search-result URLs created before the native
  // watch-page route was restored. Do not embed or redirect to YouTube itself.
  const videoId = String(req.query.id || "");
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    return res.status(400).type("text/plain").send("A valid YouTube video ID is required.");
  }
  const target = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  return res.redirect(302, "/ultraviolet.html?url=" + encodeURIComponent(target));
});

app.get("/watch", allowPublicBrowsing, (req, res) => {
  // YouTube's client-side navigation can resolve /watch against Schoolmathtime's
  // origin after its page has been proxied. Send that local route back through
  // the proxy with the original video/query parameters intact.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value != null) {
      params.set(key, String(value));
    }
  }
  if (!params.get("v")) return res.redirect(302, "/");
  const target = "https://www.youtube.com/watch?" + params.toString();
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  return res.redirect(302, "/ultraviolet.html?url=" + encodeURIComponent(target));
});

app.get("/browse", allowPublicBrowsing, fetchLimiter, async (req, res) => {
  try {
    const rawInput = String(req.query.url || "").trim();
    // Opening /browse directly without a destination should return to the app,
    // not produce an error page that can be mistaken for a broken route.
    if (!rawInput) return res.redirect(302, "/");

    // Plain text is normalized to https://www.google.com/search?q=...;
    // then fetched and rendered through the same Schoolmathtime proxy as URLs.
    const target = normalizeInput(rawInput);

    // TikTok's desktop landing page is more reliable at /foryou than the bare
    // root when fetched server-side. Change only the bare homepage; preserve
    // every supplied profile and video URL.
    let fetchTarget = target;
    try {
      const parsed = new URL(target);
      const host = parsed.hostname.toLowerCase();
      const isTikTok = host === "tiktok.com" || host.endsWith(".tiktok.com");
      if (isTikTok && parsed.pathname === "/" && !parsed.search) {
        parsed.hostname = "www.tiktok.com";
        parsed.pathname = "/foryou";
        parsed.searchParams.set("lang", "en");
        fetchTarget = parsed.toString();
      }
    } catch {}

    // YouTube watch pages now follow the standard proxy path like other sites.
    // This keeps the native watch-page UI, rather than returning an iframe-only page.

    let html;
    const result = await fetchApproved(fetchTarget, MAX_PAGE_BYTES);
    if (!result.contentType.includes("text/html") && !result.contentType.includes("application/xhtml+xml")) {
      return res.status(415).send(errorDocument("That resource is not an HTML page.", "Try opening a page URL instead."));
    }
    html = proxyDocument(result.body.toString("utf8"), result.target.toString(), "");
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; connect-src 'self' https: wss:; object-src 'none'; frame-src https://*.youtube.com https://*.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com https://*.dailymotion.com https://player.twitch.tv https://clips.twitch.tv https://www.loom.com https://www.tiktok.com https://www.facebook.com https://player.bilibili.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; worker-src 'self' blob:"
    });
    res.status(200).send(html);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
    if (status === 429 && Number.isFinite(error.retryAfter)) res.set("Retry-After", String(error.retryAfter));
    console.warn("Proxy /browse failed:", status, error.upstreamHost || "", error.message || "unknown error");
    res.status(status).send(errorDocument(error.message || "The page could not be opened.", "Return home and try again, or choose another approved destination."));
  }
});

app.all("/media", allowPublicBrowsing, fetchLimiter, async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).set("Allow", "GET, HEAD").end();
  try {
    const input = String(req.query.url || "");
    if (!input) return res.status(400).type("text/plain").send("A media URL is required.");
    await streamRemoteMedia(input, req, res);
  } catch (error) {
    let upstreamHost = "unknown";
    try { upstreamHost = new URL(String(req.query.url || "")).hostname; } catch {}
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
    console.warn(
      "Proxy /media failed:",
      status,
      "host=" + upstreamHost,
      "method=" + req.method,
      "range=" + (req.headers.range ? "requested" : "none"),
      error.message || "unknown error"
    );
    if (status === 429 && Number.isFinite(error.retryAfter)) res.set("Retry-After", String(error.retryAfter));
    if (!res.headersSent) res.status(status).type("text/plain").send(error.message || "Media could not be loaded.");
    else res.destroy(error);
  }
});

app.get("/resource", allowPublicBrowsing, fetchLimiter, async (req, res) => {
  try {
    const result = await fetchApproved(String(req.query.url || ""), MAX_RESOURCE_BYTES);
    const type = result.contentType.split(";")[0].trim();
    const css = type === "text/css";
    const javascript = [
      "application/javascript",
      "text/javascript",
      "application/ecmascript",
      "text/ecmascript",
      "application/x-javascript"
    ].includes(type);
    const wasm = type === "application/wasm";
    const allowed = css || javascript || wasm || type.startsWith("image/") || type.startsWith("font/") ||
      type.startsWith("audio/") || type.startsWith("video/") ||
      ["application/font-woff", "application/vnd.ms-fontobject", "application/x-font-ttf", "application/octet-stream"].includes(type) &&
      /\.(?:woff2?|ttf|otf|eot|wasm)(?:$|\?)/i.test(result.target.pathname + result.target.search);
    if (!allowed) return res.status(415).send("Resource type blocked.");
    const body = css ? rewriteCss(result.body.toString("utf8"), result.target.toString()) : result.body;
    res.set({
      "Content-Type": css ? "text/css; charset=utf-8" : type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    });
    res.status(200).send(body);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
    if (status === 429 && Number.isFinite(error.retryAfter)) res.set("Retry-After", String(error.retryAfter));
    console.warn("Proxy /resource failed:", status, error.upstreamHost || "", error.message || "unknown error");
    res.status(status).type("text/plain").send(error.message || "Resource blocked.");
  }
});

function errorDocument(message, detail) {
  const safeMessage = escapeAttribute(message);
  const safeDetail = escapeAttribute(detail);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page unavailable — Schoolmathtime</title><style>body{margin:0;background:#111318;color:#eff1f5;font:15px system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}.card{max-width:540px;margin:24px;padding:34px;border:1px solid #373a44;border-radius:18px;background:#1c1f27}h1{letter-spacing:-.04em}p{color:#a7acb8;line-height:1.7}a{display:inline-block;margin-top:10px;padding:11px 15px;background:#d9dee7;color:#17191e;border-radius:8px;text-decoration:none;font-weight:700}</style></head><body><main class="card"><div style="font-size:10px;letter-spacing:.14em;color:#9aa2b2">SCHOOLMATHTIME</div><h1>That page could not be opened.</h1><p>' + safeMessage + '</p><p>' + safeDetail + '</p><a href="/">Return home</a></main></body></html>';
}

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error && error.message ? error.message : error);
  if (res.headersSent) return;
  res.status(500).json({ error: "An internal error occurred." });
});

async function startServer() {
  const server = createServer();
  let wispServer = null;
  let activeWispConnections = 0;
  const MAX_WISP_CONNECTIONS = 80;

  try {
    const [uvModule, epoxyModule, baremuxModule, wispModule] = await Promise.all([
      import("@titaniumnetwork-dev/ultraviolet"),
      import("@mercuryworkshop/epoxy-transport"),
      import("@mercuryworkshop/bare-mux/node"),
      import("@mercuryworkshop/wisp-js/server")
    ]);
    const uvPath = uvModule.uvPath;
    const epoxyPath = epoxyModule.epoxyPath;
    const baremuxPath = baremuxModule.baremuxPath;
    wispServer = wispModule.server;
    if (!uvPath || !epoxyPath || !baremuxPath || !wispServer ||
        typeof wispServer.routeRequest !== "function") {
      throw new Error("A required Ultraviolet/Wisp package export is missing.");
    }

    // Bound the tunnel to HTTPS and deny private/loopback IP targets. If
    // ALLOWED_HOSTS is explicit, apply the same host restrictions to Wisp.
    wispServer.options.allow_direct_ip = false;
    wispServer.options.allow_private_ips = false;
    wispServer.options.allow_loopback_ips = false;
    wispServer.options.allow_udp_streams = false;
    wispServer.options.allow_tcp_streams = true;
    wispServer.options.port_whitelist = [443];
    wispServer.options.stream_limit_per_host = 8;
    wispServer.options.stream_limit_total = 32;
    if (!ALLOWED_HOSTS.includes("*")) {
      wispServer.options.hostname_whitelist = ALLOWED_HOSTS.map((host) => {
        const escaped = host.split(".").map((part) =>
          part.replace(/[.*+?^$()|[\]\\]/g, (character) => "\\" + character)
        ).join("\\.");
        return new RegExp("^(?:[^.]+\\.)*" + escaped + "$", "i");
      });
    }

    // The local config takes precedence over package assets; other UV, Epoxy,
    // and BareMux files are served from the installed packages.
    app.use("/uv/", express.static(uvPath, { fallthrough: true, index: false }));
    app.use("/epoxy/", express.static(epoxyPath, { fallthrough: true, index: false }));
    app.use("/baremux/", express.static(baremuxPath, { fallthrough: true, index: false }));
    ultravioletReady = true;
    console.log("Ultraviolet assets mounted.");
  } catch (error) {
    console.error("Ultraviolet could not initialize; the classic proxy remains available:",
      error && error.message ? error.message : error);
  }

  server.on("request", (req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    app(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    let requestPath = "";
    try { requestPath = new URL(req.url || "/", "http://localhost").pathname; } catch {}
    if (!ultravioletReady || requestPath !== "/wisp/") {
      socket.destroy();
      return;
    }
    if (activeWispConnections >= MAX_WISP_CONNECTIONS) {
      socket.end();
      return;
    }
    activeWispConnections += 1;
    socket.once("close", () => { activeWispConnections = Math.max(0, activeWispConnections - 1); });
    try {
      wispServer.routeRequest(req, socket, head);
    } catch (error) {
      console.warn("Wisp upgrade failed:", error && error.message ? error.message : error);
      socket.destroy();
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log("Schoolmathtime listening on port " + PORT);
    console.log("Approved host entries: " + ALLOWED_HOSTS.length);
    console.log("Ultraviolet ready: " + ultravioletReady);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Server startup failed:", error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  normalizeInput,
  isSupportedMediaFrame,
  isAllowedHost,
  isPublicAddress,
  scheduleYouTubeRequest
};