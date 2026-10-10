"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId("uv-address-form");
  const address = byId("uv-address");
  const status = byId("uv-status");
  const frame = byId("uv-frame");
  const welcome = byId("uv-welcome");
  const error = byId("uv-error");
  const copyError = byId("uv-copy-error");
  const bookmark = byId("uv-bookmark");
  const BOOKMARKS_KEY = "schoolmathtime.bookmarks";
  let connection = null;
  let lastTarget = "";
  let hasLoaded = false;

  function setStatus(message) { status.textContent = message; }
  function setError(message) {
    error.textContent = String(message || "Unknown proxy error");
    error.hidden = false;
    copyError.hidden = false;
    error.focus();
    setStatus("Ultraviolet could not open this page. The error text is selectable.");
  }

  function makeTarget(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("Enter a website address or search term.");
    if (input.length > 2048) throw new Error("The address is too long.");
    if (/^http:\/\//i.test(input)) throw new Error("Only HTTPS website addresses are supported.");
    try {
      const url = new URL(input);
      if (url.protocol !== "https:") throw new Error("Only HTTPS website addresses are supported.");
      return url.toString();
    } catch (err) {
      if (err && err.message === "Only HTTPS website addresses are supported.") throw err;
    }
    if (!/\s/.test(input) && input.includes(".")) {
      try { return new URL("https://" + input).toString(); } catch {}
    }
    return "https://www.google.com/search?gbv=1&q=" + encodeURIComponent(input);
  }

  async function ensureTransport() {
    if (!navigator.serviceWorker) throw new Error("This browser does not support service workers. Open Schoolmathtime over HTTPS in a compatible browser.");
    if (typeof BareMux === "undefined") throw new Error("Ultraviolet transport files did not load.");
    if (typeof __uv$config === "undefined") throw new Error("Ultraviolet configuration did not load.");

    // Rebuild the Epoxy transport on every top-level navigation. BareMux's
    // getTransport() only reports the transport name; it cannot tell whether
    // the underlying Wisp multiplexor has died, which leaves retries stuck on
    // MuxTaskEnded. Set the transport before the service worker becomes ready,
    // as recommended by BareMux, so its first proxied request has a live client.
    if (!connection) connection = new BareMux.BareMuxConnection("/baremux/worker.js");
    const transport = "/epoxy/index.mjs?build=wisp-mux-reset-1";
    const wispUrl = "wss://" + location.host + "/wisp/";
    await connection.setTransport(transport, [{ wisp: wispUrl, wisp_v2: true }]);

    // The worker is deliberately scoped to /uv/, which covers proxied
    // iframe URLs but not /ultraviolet.html itself. Do not await
    // navigator.serviceWorker.ready here: ready waits for a registration
    // controlling the current page's scope and can hang forever.
    const registration = await navigator.serviceWorker.register("/uv/sw.js", {
      updateViaCache: "none"
    });
    let worker = registration.installing || registration.waiting || registration.active;
    if (!worker) {
      await registration.update();
      worker = registration.installing || registration.waiting || registration.active;
    }
    if (!worker) throw new Error("Ultraviolet's service worker did not create an install or active worker.");

    if (worker.state !== "activated") {
      await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
          if (timer) window.clearTimeout(timer);
          worker.removeEventListener("statechange", onStateChange);
        };
        const onStateChange = () => {
          if (worker.state === "activated") {
            cleanup();
            resolve();
          } else if (worker.state === "redundant") {
            cleanup();
            reject(new Error("Ultraviolet's service worker failed during installation. Reload the page and check the service worker script and config."));
          }
        };
        timer = window.setTimeout(() => {
          cleanup();
          reject(new Error("Ultraviolet's service worker did not activate within 15 seconds. The worker may be blocked or its script/config may be stale."));
        }, 15000);
        worker.addEventListener("statechange", onStateChange);
        onStateChange();
      });
    }
  }

  async function openTarget(value, pushState = true) {
    let target;
    try { target = makeTarget(value); }
    catch (err) { setError(err.message || err); return; }
    error.hidden = true;
    copyError.hidden = true;
    if (!hasLoaded) setStatus("Preparing secure proxy connection…");
    try {
      await ensureTransport();
      if (pushState) {
        const next = "/ultraviolet.html?url=" + encodeURIComponent(target);
        history.pushState({ target }, "", next);
      }
      lastTarget = target;
      address.value = target;
      frame.style.display = "block";
      welcome.style.display = "none";
      setStatus("Loading " + new URL(target).hostname + " through Ultraviolet…");
      frame.src = __uv$config.prefix + __uv$config.encodeUrl(target);
      refreshBookmarkState();
    } catch (err) {
      setError(err && err.stack ? err.stack : err);
    }
  }

  function currentTarget() {
    try {
      const childUrl = new URL(frame.contentWindow.location.href);
      if (childUrl.pathname.startsWith(__uv$config.prefix)) {
        const encoded = childUrl.pathname.slice(__uv$config.prefix.length);
        const decoded = __uv$config.decodeUrl(encoded);
        const target = new URL(decoded);
        if (target.protocol === "https:") return target.toString();
      }
    } catch {}
    return lastTarget;
  }

  function readBookmarks() {
    try {
      const items = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
      return Array.isArray(items) ? items.filter((item) => item && typeof item.url === "string") : [];
    } catch { return []; }
  }

  function refreshBookmarkState() {
    const target = currentTarget();
    const saved = readBookmarks().some((item) => item.url === target);
    bookmark.textContent = saved ? "★" : "☆";
    bookmark.setAttribute("aria-pressed", String(saved));
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void openTarget(address.value);
  });
  byId("uv-back").addEventListener("click", () => {
    try { frame.contentWindow.history.back(); } catch { history.back(); }
  });
  byId("uv-forward").addEventListener("click", () => {
    try { frame.contentWindow.history.forward(); } catch { history.forward(); }
  });
  byId("uv-refresh").addEventListener("click", () => {
    if (address.value.trim()) void openTarget(address.value, false);
    else location.reload();
  });
  byId("uv-classic").addEventListener("click", () => {
    const target = currentTarget() || lastTarget || address.value.trim();
    if (!target) { location.assign("/"); return; }
    location.assign("/browse?url=" + encodeURIComponent(target));
  });
  bookmark.addEventListener("click", () => {
    const target = currentTarget() || lastTarget;
    if (!target) { setStatus("Open a page before bookmarking it."); return; }
    const items = readBookmarks();
    const index = items.findIndex((item) => item.url === target);
    if (index >= 0) items.splice(index, 1);
    else {
      let title = target;
      try { title = new URL(target).hostname; } catch {}
      items.unshift({ title, url: target });
    }
    try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(items.slice(0, 18))); }
    catch (err) { setStatus("Bookmark storage is unavailable in this browser."); return; }
    refreshBookmarkState();
    setStatus(index >= 0 ? "Bookmark removed." : "Bookmark saved.");
  });
  copyError.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(error.textContent);
      setStatus("Error copied.");
    } catch {
      error.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(error);
      selection.removeAllRanges();
      selection.addRange(range);
      setStatus("The error text is selected. Press Ctrl+C to copy it.");
    }
  });
  frame.addEventListener("load", () => {
    if (!frame.src || frame.src === "about:blank") return;
    hasLoaded = true;
    setStatus("Page loaded. Some websites restrict proxy-based browsing.");
    refreshBookmarkState();
  });
  window.addEventListener("popstate", (event) => {
    const target = event.state?.target;
    if (target) void openTarget(target, false);
    else location.assign("/");
  });
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault(); address.focus(); address.select();
    }
  });

  const initial = new URLSearchParams(location.search).get("url");
  if (initial) {
    address.value = initial;
    void openTarget(initial, false);
  }
})();
