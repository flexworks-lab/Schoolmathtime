"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId("uv-address-form");
  const address = byId("uv-address");
  const status = byId("uv-status");
  const frame = byId("uv-frame");
  const classicFrame = byId("classic-frame");
  const engineSwitch = byId("uv-engine-switch");
  const welcome = byId("uv-welcome");
  const error = byId("uv-error");
  const copyError = byId("uv-copy-error");
  const bookmark = byId("uv-bookmark");
  const youtubeLogin = byId("uv-youtube-login");
  const BOOKMARKS_KEY = "schoolmathtime.bookmarks";
  let connection = null;
  let lastTarget = "";
  let hasLoaded = false;
  let activeEngine = "";
  let raceSerial = 0;
  let raceAttempt = null;
  let transportReady = null;

  function setStatus(message) { status.textContent = message; }
  function setError(message) {
    error.textContent = String(message || "Unknown proxy error");
    error.hidden = false;
    copyError.hidden = false;
    error.focus();
    setStatus("Neither browser engine could open this page. The error text is selectable.");
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

  async function initializeTransport() {
    if (!navigator.serviceWorker) throw new Error("This browser does not support service workers. Open Schoolmathtime over HTTPS in a compatible browser.");
    if (typeof BareMux === "undefined") throw new Error("Ultraviolet transport files did not load.");
    if (typeof __uv$config === "undefined") throw new Error("Ultraviolet configuration did not load.");

    // Rebuild the Epoxy transport on every top-level navigation. BareMux's
    // getTransport() only reports the transport name; it cannot tell whether
    // the underlying Wisp multiplexor has died, which leaves retries stuck on
    // MuxTaskEnded. Set the transport before the service worker becomes ready,
    // as recommended by BareMux, so its first proxied request has a live client.
    if (!connection) connection = new BareMux.BareMuxConnection("/baremux/worker.js?v=bare-mux-2-1-9");
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

  function ensureTransport() {
    if (!transportReady) {
      transportReady = initializeTransport().catch((error) => {
        transportReady = null;
        throw error;
      });
    }
    return transportReady;
  }

  function candidateFailure(candidateFrame) {
    try {
      const doc = candidateFrame.contentDocument;
      if (!doc || !doc.documentElement) return "The browser returned an empty document.";
      const title = String(doc.title || "").toLowerCase();
      const text = String(doc.body?.innerText || doc.body?.textContent || "").trim();
      if (/page unavailable.*schoolmathtime/i.test(title) ||
          (/that page could not be opened\./i.test(text) && /schoolmathtime/i.test(text))) {
        return text.slice(0, 700) || "The proxy returned its page-unavailable screen.";
      }
      return "";
    } catch {
      // Some sites lock down their document even after the proxy route loads.
      // Treat that as a potentially valid page instead of incorrectly rejecting it.
      return "";
    }
  }

  function finishIfBothFailed(attempt) {
    if (raceAttempt !== attempt || attempt.finished ||
        attempt.pending.uv || attempt.pending.classic) return;
    attempt.finished = true;
    raceAttempt = null;
    if (attempt.timer) window.clearTimeout(attempt.timer);
    activeEngine = "";
    engineSwitch.hidden = true;
    document.body.classList.remove("classic-active");
    frame.classList.add("race-hidden");
    classicFrame.classList.add("race-hidden");
    frame.style.display = "block";
    classicFrame.style.display = "block";
    welcome.style.display = "flex";
    const details = ["Ultraviolet: " + (attempt.failures.uv || "no usable response"),
      "Classic: " + (attempt.failures.classic || "no usable response")].join("\n");
    setError("Both browsing routes failed for " + new URL(attempt.target).hostname + ".\n" + details +
      "\nTry reloading, or use another website address.");
  }

  function failCandidate(attempt, engine, reason) {
    if (raceAttempt !== attempt || attempt.finished || !attempt.pending[engine]) return;
    if (engine === "uv") transportReady = null;
    attempt.pending[engine] = false;
    attempt.failures[engine] = String(reason || "The route failed to load.").slice(0, 900);
    finishIfBothFailed(attempt);
  }

  function chooseWinner(attempt, engine) {
    if (raceAttempt !== attempt || attempt.finished || !attempt.pending[engine]) return;
    const winner = engine === "uv" ? frame : classicFrame;
    const loser = engine === "uv" ? classicFrame : frame;
    const failure = candidateFailure(winner);
    if (failure) {
      failCandidate(attempt, engine, failure);
      return;
    }

    attempt.finished = true;
    attempt.pending[engine] = false;
    attempt.pending[engine === "uv" ? "classic" : "uv"] = false;
    if (attempt.timer) window.clearTimeout(attempt.timer);
    raceAttempt = null;
    activeEngine = engine;
    engineSwitch.hidden = engine !== "classic";
    hasLoaded = true;
    document.body.classList.toggle("classic-active", engine === "classic");
    winner.style.display = "block";
    winner.classList.remove("race-hidden");
    loser.classList.add("race-hidden");
    loser.dataset.expectedSrc = "";
    loser.src = "about:blank";
    setStatus("Opened " + new URL(attempt.target).hostname + " with " +
      (engine === "uv" ? "Ultraviolet" : "the classic proxy") + " (first usable route).");
    refreshBookmarkState();
  }

  function handleCandidateLoad(engine) {
    const attempt = raceAttempt;
    const candidate = engine === "uv" ? frame : classicFrame;
    if (!attempt || attempt.finished || !attempt.pending[engine]) return;
    const expected = candidate.dataset.expectedSrc || "";
    if (!expected || candidate.src === "about:blank" || candidate.src !== expected) return;
    chooseWinner(attempt, engine);
  }

  function openTarget(value, pushState = true) {
    let target;
    try { target = makeTarget(value); }
    catch (err) { setError(err.message || err); return; }

    // YouTube is substantially more JavaScript-heavy than the classic fetch
    // proxy. Prefer Ultraviolet for YouTube and Google sign-in routes so the
    // native page layout/session flow runs inside this browser frame.
    if (isYouTubeOrGoogleSignin(target)) {
      error.hidden = true;
      copyError.hidden = true;
      if (pushState) {
        history.pushState({ target }, "", "/ultraviolet.html?url=" + encodeURIComponent(target));
      }
      openSingleEngine("uv", target);
      return;
    }

    error.hidden = true;
    copyError.hidden = true;

    const attempt = {
      id: ++raceSerial,
      target,
      pending: { uv: true, classic: true },
      failures: { uv: "", classic: "" },
      expected: { uv: "", classic: "" },
      timer: null,
      finished: false
    };
    if (raceAttempt?.timer) window.clearTimeout(raceAttempt.timer);
    raceAttempt = attempt;
    activeEngine = "";
    engineSwitch.hidden = true;
    hasLoaded = false;
    lastTarget = target;
    address.value = target;
    document.body.classList.remove("classic-active");
    welcome.style.display = "none";
    frame.style.display = "block";
    classicFrame.style.display = "block";
    frame.classList.add("race-hidden");
    classicFrame.classList.add("race-hidden");
    frame.dataset.expectedSrc = "";
    classicFrame.dataset.expectedSrc = "";
    frame.src = "about:blank";
    classicFrame.src = "about:blank";
    setStatus("Trying both browser routes for " + new URL(target).hostname + "…");

    if (pushState) {
      const next = "/ultraviolet.html?url=" + encodeURIComponent(target);
      history.pushState({ target }, "", next);
    }

    // Begin the classic request immediately while Ultraviolet prepares its
    // service worker and Wisp connection. The first route with a usable page wins.
    const classicPath = "/browse?url=" + encodeURIComponent(target);
    attempt.expected.classic = new URL(classicPath, location.href).href;
    classicFrame.dataset.expectedSrc = attempt.expected.classic;
    classicFrame.src = classicPath;

    attempt.timer = window.setTimeout(() => {
      if (raceAttempt !== attempt || attempt.finished) return;
      for (const engine of ["uv", "classic"]) {
        if (attempt.pending[engine]) failCandidate(attempt, engine, "Timed out while opening the website.");
      }
    }, 30000);

    void (async () => {
      try {
        await ensureTransport();
        if (raceAttempt !== attempt || attempt.finished || !attempt.pending.uv) return;
        const uvPath = __uv$config.prefix + __uv$config.encodeUrl(target);
        attempt.expected.uv = new URL(uvPath, location.href).href;
        frame.dataset.expectedSrc = attempt.expected.uv;
        frame.src = uvPath;
      } catch (err) {
        failCandidate(attempt, "uv", err && err.stack ? err.stack : err);
      }
    })();
    refreshBookmarkState();
  }

  function currentTarget() {
    if (activeEngine === "classic") {
      try {
        const childUrl = new URL(classicFrame.contentWindow.location.href);
        const value = childUrl.pathname === "/browse" ? childUrl.searchParams.get("url") : "";
        if (value) {
          const target = new URL(value);
          if (target.protocol === "https:") return target.toString();
        }
      } catch {}
    }
    try {
      const childUrl = new URL(frame.contentWindow.location.href);
      if (typeof __uv$config !== "undefined" && childUrl.pathname.startsWith(__uv$config.prefix)) {
        const encoded = childUrl.pathname.slice(__uv$config.prefix.length);
        const decoded = __uv$config.decodeUrl(encoded);
        const target = new URL(decoded);
        if (target.protocol === "https:") return target.toString();
      }
    } catch {}
    return lastTarget;
  }

  function openSingleEngine(engine, value) {
    let target;
    try { target = makeTarget(value || currentTarget() || lastTarget || address.value); }
    catch (err) { setError(err.message || err); return; }
    if (raceAttempt?.timer) window.clearTimeout(raceAttempt.timer);
    if (raceAttempt) raceAttempt.finished = true;
    raceAttempt = null;
    const switchId = ++raceSerial;
    const winner = engine === "uv" ? frame : classicFrame;
    const loser = engine === "uv" ? classicFrame : frame;
    activeEngine = engine;
    lastTarget = target;
    address.value = target;
    hasLoaded = false;
    error.hidden = true;
    copyError.hidden = true;
    welcome.style.display = "none";
    engineSwitch.hidden = engine !== "classic";
    document.body.classList.toggle("classic-active", engine === "classic");
    winner.style.display = "block";
    winner.classList.add("race-hidden");
    loser.style.display = "block";
    loser.classList.add("race-hidden");
    loser.dataset.expectedSrc = "";
    loser.src = "about:blank";
    setStatus("Opening " + new URL(target).hostname + " with " +
      (engine === "uv" ? "Ultraviolet" : "the classic proxy") + "…");

    if (engine === "classic") {
      const classicPath = "/browse?url=" + encodeURIComponent(target);
      winner.dataset.expectedSrc = new URL(classicPath, location.href).href;
      winner.src = classicPath;
      winner.classList.remove("race-hidden");
      hasLoaded = true;
      return;
    }

    void (async () => {
      try {
        await ensureTransport();
        if (switchId !== raceSerial || activeEngine !== "uv" || lastTarget !== target) return;
        const uvPath = __uv$config.prefix + __uv$config.encodeUrl(target);
        winner.dataset.expectedSrc = new URL(uvPath, location.href).href;
        winner.src = uvPath;
        winner.classList.remove("race-hidden");
      } catch (err) {
        if (switchId !== raceSerial) return;
        engineSwitch.hidden = true;
        welcome.style.display = "flex";
        setError(err && err.stack ? err.stack : err);
      }
    })();
  }

  function isYouTubeOrGoogleSignin(value) {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
      return host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com") ||
        host === "accounts.google.com" || host === "myaccount.google.com" ||
        host === "consent.google.com";
    } catch {
      return false;
    }
  }

  function setUltravioletLoadedStatus() {
    const target = currentTarget();
    let host = "";
    try { host = new URL(target).hostname.toLowerCase(); } catch {}
    if (host === "accounts.google.com" || host === "myaccount.google.com" || host === "consent.google.com") {
      let pageText = "";
      try {
        pageText = String(frame.contentDocument?.body?.innerText ||
          frame.contentDocument?.body?.textContent || "").slice(0, 5000);
      } catch {}
      if (/disallowed_useragent|this browser or app may not be secure|couldn.t sign you in|sign in with a supported browser|unsupported browser/i.test(pageText)) {
        setStatus("Google blocked sign-in in this proxied browser. Google requires a supported sign-in browser; Ultraviolet cannot override that restriction.");
      } else {
        setStatus("Google sign-in is open inside Ultraviolet. It should return to YouTube in this same browser after sign-in.");
      }
      return;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      setStatus("YouTube is running in Ultraviolet. The page stays inside Schoolmathtime.");
      return;
    }
    setStatus("Page loaded through Ultraviolet. Some websites may still restrict scripts or media.");
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
    try {
      const activeFrame = activeEngine === "classic" ? classicFrame : frame;
      if (activeEngine) activeFrame.contentWindow.history.back();
      else history.back();
    } catch { history.back(); }
  });
  byId("uv-forward").addEventListener("click", () => {
    try {
      const activeFrame = activeEngine === "classic" ? classicFrame : frame;
      if (activeEngine) activeFrame.contentWindow.history.forward();
      else history.forward();
    } catch { history.forward(); }
  });
  byId("uv-refresh").addEventListener("click", () => {
    const target = currentTarget() || address.value.trim();
    if (target) void openTarget(target, false);
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
    if (raceAttempt && raceAttempt.pending.uv) {
      handleCandidateLoad("uv");
      return;
    }
    if (activeEngine === "uv") {
      hasLoaded = true;
      const activeTarget = currentTarget();
      if (activeTarget) {
        lastTarget = activeTarget;
        address.value = activeTarget;
      }
      setUltravioletLoadedStatus();
      refreshBookmarkState();
    }
  });
  classicFrame.addEventListener("load", () => {
    handleCandidateLoad("classic");
  });
  youtubeLogin?.addEventListener("click", () => {
    // Start Google's official YouTube sign-in page within the UV iframe. The
    // continue parameter returns to YouTube through the same proxied frame.
    const login = new URL("https://accounts.google.com/ServiceLogin");
    login.searchParams.set("service", "youtube");
    login.searchParams.set("continue", "https://www.youtube.com/");
    login.searchParams.set("hl", "en");
    openSingleEngine("uv", login.toString());
    setStatus("Opening Google sign-in inside Ultraviolet. Google may restrict sign-in in proxied browsers.");
  });
  engineSwitch.addEventListener("click", () => {
    const target = currentTarget() || lastTarget || address.value.trim();
    if (target) openSingleEngine("uv", target);
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
  } else {
    // Warm the transport while the user is on the browser's start page so
    // the next typed navigation does not have to initialize it from scratch.
    void ensureTransport().catch(() => {});
  }
})();
