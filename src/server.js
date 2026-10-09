"use strict";

const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const crypto = require("node:crypto");
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
  limit: 60,
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

async function validateTarget(input) {
  let target;
  try {
    target = new URL(input);
  } catch {
    throw new Error("Enter a complete URL or a search phrase.");
  }
  if (target.protocol !== "https:") throw new Error("Only HTTPS websites are supported.");
  if (target.username || target.password) throw new Error("URLs containing credentials are not allowed.");
  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || net.isIP(hostname) || !isAllowedHost(hostname)) {
    throw new Error("That domain is not on the operator's approved-domain list.");
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("That domain could not be resolved.");
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("The destination resolves to a private or reserved network and was blocked.");
  }
  return target;
}

function normalizeInput(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Enter a URL or search phrase.");
  if (value.length > 2048) throw new Error("The URL or search phrase is too long.");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(value) && value.includes(".") && !/\s/.test(value)) {
    return "https://" + value;
  }
  if (!isAllowedHost("en.wikipedia.org")) {
    throw new Error("Search phrases require wikipedia.org to be in ALLOWED_HOSTS. You can still enter an approved URL.");
  }
  return "https://en.wikipedia.org/w/index.php?search=" + encodeURIComponent(value);
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

async function fetchApproved(input, maxBytes, redirectCount = 0) {
  const target = await validateTarget(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Schoolmathtime-EducationalGateway/1.0",
        "Accept": "text/html, text/css, image/*, font/*, application/font-woff, application/vnd.ms-fontobject;q=0.8"
      }
    });
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("The remote website took too long to respond.");
    throw new Error("Unable to fetch that website.");
  } finally {
    clearTimeout(timer);
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (response.body) response.body.cancel().catch(() => {});
    if (!location) throw new Error("The remote website sent an invalid redirect.");
    if (redirectCount >= MAX_REDIRECTS) throw new Error("The website redirected too many times.");
    const next = new URL(location, target).toString();
    return fetchApproved(next, maxBytes, redirectCount + 1);
  }
  if (!response.ok) {
    if (response.body) response.body.cancel().catch(() => {});
    throw new Error("The remote website returned HTTP " + response.status + ".");
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    if (response.body) response.body.cancel().catch(() => {});
    throw new Error("The remote response is larger than the configured safety limit.");
  }
  if (!response.body) throw new Error("The remote website returned an empty response.");
  const body = await collectLimited(response.body, maxBytes);
  return { target, contentType, body, status: response.status };
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
  $("script, noscript, iframe, frame, frameset, object, embed, applet, form, base, portal").remove();
  $("meta[http-equiv]").remove();
  $("link[rel='modulepreload'], link[rel='preload'], link[rel='prefetch'], link[rel='prerender']").remove();
  $("*").each((_, element) => {
    const node = $(element);
    const attrs = { ...element.attribs };
    for (const [name, originalValue] of Object.entries(attrs)) {
      const lower = name.toLowerCase();
      const value = String(originalValue || "").trim();
      if (lower.startsWith("on") || ["srcdoc", "action", "formaction", "integrity", "nonce", "crossorigin"].includes(lower)) {
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

  const toolbar = '<div id="schoolmathtime-toolbar" style="position:sticky;top:0;z-index:2147483647;display:flex;gap:10px;align-items:center;padding:10px 14px;background:#17191f;color:#f5f6f8;border-bottom:1px solid #3a3d46;font:13px system-ui,sans-serif;box-shadow:0 2px 10px #0002"><a href="/" style="color:#f5f6f8;text-decoration:none;font-weight:700;white-space:nowrap">SCHOOLMATHTIME</a><form action="/browse" method="get" style="display:flex;gap:8px;flex:1;margin:0"><input name="url" value="' + escapeAttribute(sourceUrl) + '" aria-label="Current website" style="min-width:0;flex:1;padding:9px 11px;border:1px solid #555a65;border-radius:7px;background:#272a32;color:#fff"><button style="padding:8px 14px;border:0;border-radius:7px;background:#d9dee7;color:#17191e;font-weight:700">Go</button></form><a href="/" style="color:#c5c9d2;white-space:nowrap">Home</a></div>';
  $("body").prepend(toolbar);
  if (!$("body").length) $("html").append("<body>" + toolbar + "</body>");
  $("head").append('<meta name="referrer" content="no-referrer">');
  $("title").text(($("title").text() || new URL(sourceUrl).hostname) + " — Schoolmathtime");
  const page = $.html();
  return page.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
    .replace(/<body([^>]*)>/i, '<body$1 style="margin:0">');
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
      res.json({ authenticated: true, allowedHosts: ALLOWED_HOSTS });
    });
  });
});

app.get("/api/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ authenticated: req.session?.authenticated === true, allowedHosts: req.session?.authenticated === true ? ALLOWED_HOSTS : [] });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("schoolmathtime.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    res.status(204).end();
  });
});

app.get("/browse", requireLogin, fetchLimiter, async (req, res) => {
  try {
    const target = normalizeInput(req.query.url);
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
      "Content-Security-Policy": "default-src 'self' data: blob:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
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
    const allowed = css || type.startsWith("image/") || type.startsWith("font/") ||
      ["application/font-woff", "application/vnd.ms-fontobject", "application/x-font-ttf", "application/octet-stream"].includes(type) &&
      /\.(?:woff2?|ttf|otf|eot)(?:$|\?)/i.test(result.target.pathname + result.target.search);
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
