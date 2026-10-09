"use strict";

const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const crypto = require("node:crypto");
const https = require("node:https");
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 60_000 });
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cheerio = require("cheerio");
const ipaddr = require("ipaddr.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ACCESS_KEY = process.env.PROXY_ACCESS_KEY || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const DNS_CACHE_TTL_MS = 30_000;
const RESPONSE_CACHE_MAX_ENTRIES = 96;
const RESPONSE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const dnsCache = new Map();
const responseCache = new Map();
let responseCacheBytes = 0;

function parseAllowedHosts(value) {
  return [...new Set(String(value || "").split(",").map((item) =>
    item.trim().toLowerCase().replace(/^\.+|\.$/g, "")
  ).filter((host) => host && !host.includes("/") && !host.includes(":") && !net.isIP(host)))];
}

const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);

if (!ACCESS_KEY || ACCESS_KEY.length < 16) {
  console.error("Configuration error: set PROXY_ACCESS_KEY to a value at least 16 characters long.");
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error("Configuration error: set SESSION_SECRET to a random value at least 32 characters long.");
  process.exit(1);
}
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
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"]
  }
}}));
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(session({
  name: "schoolmathtime.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 4 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait and try again." }
});
const fetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Rate limit reached. Please wait a moment."
});

function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated === true) return next();
  if (req.path.startsWith("/api/") || req.path === "/login") {
    return res.status(401).json({ error: "Sign in with the site access key first." });
  }
  return res.redirect("/");
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

function readResponseCache(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    responseCacheBytes -= entry.body.length;
    return null;
  }
  responseCache.delete(key);
  responseCache.set(key, entry);
  return {
    target: new URL(entry.target),
    contentType: entry.contentType,
    body: Buffer.from(entry.body),
    status: entry.status,
    cached: true
  };
}

function writeResponseCache(key, result) {
  const bodySize = result.body?.length || 0;
  const isHtml = result.contentType.includes("text/html") || result.contentType.includes("application/xhtml+xml");
  const maxItemBytes = isHtml ? 2 * 1024 * 1024 : 1024 * 1024;
  if (!bodySize || bodySize > maxItemBytes || bodySize > RESPONSE_CACHE_MAX_BYTES) return;

  const existing = responseCache.get(key);
  if (existing) {
    responseCacheBytes -= existing.body.length;
    responseCache.delete(key);
  }
  const ttl = isHtml ? 30_000 : 10 * 60_000;
  const entry = {
    target: result.target.toString(),
    contentType: result.contentType,
    body: Buffer.from(result.body),
    status: result.status,
    expiresAt: Date.now() + ttl
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
        "Accept": "text/html, text/css, image/*, font/*, application/font-woff, application/vnd.ms-fontobject;q=0.8"
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
      if (error.code === "ETIMEDOUT") finish(new Error("The remote website took too long to respond."));
      else finish(new Error("Unable to fetch that website."));
    });
    request.end();
  });
}

async function fetchApproved(input, maxBytes, redirectCount = 0) {
  const { target, addresses } = await validateTarget(input);
  const cacheKey = target.toString();
  const cached = readResponseCache(cacheKey);
  if (cached) return cached;

  const response = await requestPinned(target, addresses, maxBytes);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (!response.location) throw new Error("The remote website sent an invalid redirect.");
    if (redirectCount >= MAX_REDIRECTS) throw new Error("The website redirected too many times.");
    const next = new URL(response.location, target).toString();
    const redirected = await fetchApproved(next, maxBytes, redirectCount + 1);
    writeResponseCache(cacheKey, redirected);
    return redirected;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error("The remote website returned HTTP " + response.status + ".");
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
  $("noscript, iframe, frame, frameset, object, embed, applet, base, portal").remove();
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
        node.removeAttr(name);
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
          node.attr(name, safeProxyPath("/resource", absolute.toString()));
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
  const toolbar = `<div id="stm-browser-chrome" role="region" aria-label="Schoolmathtime browser controls">
    <div class="stm-tab-strip">
      <span class="stm-mini-logo" aria-hidden="true">S</span>
      <div class="stm-tab">
        <span class="stm-tab-icon" aria-hidden="true">S</span>
        <span class="stm-tab-title">${hostLabel}</span>
        <button id="stm-close-tab" class="stm-tab-close" type="button" aria-label="Close tab" title="Close tab">×</button>
      </div>
      <button id="stm-new-tab" class="stm-new-tab" type="button" aria-label="Open new tab" title="New tab">+</button>
      <div class="stm-window-actions" aria-hidden="true"><span class="stm-window-action"></span><span class="stm-window-action square"></span><span class="stm-window-action close"></span></div>
    </div>
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
  $("head").append('<link rel="stylesheet" href="/browser-chrome.css?v=browser-ui-1"><link rel="stylesheet" href="/proxy-fit.css?v=toolbar-offset-2"><script src="/proxy-chrome.js?v=google-search-form-fix-3" defer></script>');
  $("body").prepend(toolbar);
  if (!$("body").length) $("html").append("<body>" + toolbar + "</body>");
  $("head").append('<meta name="referrer" content="no-referrer">');
  $("title").text(($("title").text() || new URL(sourceUrl).hostname) + " — Schoolmathtime");
  const page = $.html();
  return page.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
    .replace(/<body([^>]*)>/i, '<body$1 class="stm-proxied-page" style="margin:0">');
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/login", loginLimiter, (req, res, next) => {
  const attempt = typeof req.body?.accessKey === "string" ? req.body.accessKey : "";
  const correct = attempt.length <= 512 && crypto.timingSafeEqual(
    Buffer.from(crypto.createHash("sha256").update(attempt).digest()),
    Buffer.from(crypto.createHash("sha256").update(ACCESS_KEY).digest())
  );
  if (!correct) return res.status(401).json({ error: "That access key was not accepted." });
  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.authenticated = true;
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.json({ authenticated: true, allowedHosts: ALLOWED_HOSTS.filter((host) => host !== "*"), browseAllPublicDomains: ALLOWED_HOSTS.includes("*") });
    });
  });
});

app.get("/api/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ authenticated: req.session?.authenticated === true, allowedHosts: req.session?.authenticated === true ? ALLOWED_HOSTS.filter((host) => host !== "*") : [], browseAllPublicDomains: req.session?.authenticated === true && ALLOWED_HOSTS.includes("*") });
});

app.get("/search", requireLogin, (req, res) => {
  // Compatibility route for cached pages: explicitly proxy Google's real search URL.
  const query = String(req.query.q || "").trim().slice(0, 300);
  if (!query) return res.redirect(302, "/");
  const target = "https://www.google.com/search?gbv=1&q=" + encodeURIComponent(query);
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  return res.redirect(302, "/browse?url=" + encodeURIComponent(target));
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("schoolmathtime.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    res.status(204).end();
  });
});

app.get("/browse", requireLogin, fetchLimiter, async (req, res) => {
  try {
    const rawInput = String(req.query.url || "").trim();
    if (!rawInput) throw new Error("Enter a URL or search phrase.");

    // Plain text is normalized to https://www.google.com/search?q=...;
    // then fetched and rendered through the same Schoolmathtime proxy as URLs.
    const target = normalizeInput(rawInput);
    const result = await fetchApproved(target, MAX_PAGE_BYTES);
    if (!result.contentType.includes("text/html") && !result.contentType.includes("application/xhtml+xml")) {
      return res.status(415).send(errorDocument("That resource is not an HTML page.", "Try opening a page URL instead."));
    }
    const html = proxyDocument(result.body.toString("utf8"), result.target.toString(), "");
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https: wss:; object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; worker-src 'self' blob:"
    });
    res.status(200).send(html);
  } catch (error) {
    res.status(400).send(errorDocument(error.message || "The page could not be opened.", "Return home and choose another approved destination."));
  }
});

app.get("/resource", requireLogin, fetchLimiter, async (req, res) => {
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
    res.status(400).type("text/plain").send(error.message || "Resource blocked.");
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Schoolmathtime listening on port " + PORT);
  console.log("Approved host entries: " + ALLOWED_HOSTS.length);
});
