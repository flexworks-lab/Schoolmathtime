"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId("uv-address-form");
  const address = byId("uv-address");
  const status = byId("uv-status");
  const frame = byId("uv-frame");
  const classicFrame = byId("classic-frame");
  const library = byId("uv-library");
  const bookmarkList = byId("uv-bookmark-list");
  const historyList = byId("uv-history-list");
  const clearHistoryButton = byId("uv-clear-history");
  const welcome = byId("uv-welcome");
  const error = byId("uv-error");
  const copyError = byId("uv-copy-error");
  const bookmark = byId("uv-bookmark");
  const searchEngineSelect = byId("uv-search-engine");
  const themeSelect = byId("uv-theme-mode");
  const themeColorMeta = byId("uv-theme-color");
  const faviconLink = byId("uv-favicon");
  const engineModeSelect = byId("uv-engine-mode");
  const SEARCH_ENGINE_KEY = "schoolmathtime.searchEngine";
  const THEME_KEY = "schoolmathtime.theme";
  const SEARCH_ENGINES = ["duckduckgo","google","bing","brave","yahoo","ecosia","startpage"];
  const THEMES = ["light","dark","blue","rose","green"];
  const THEME_COLORS = { light:"#f8f9fa", dark:"#202124", blue:"#17263e", rose:"#fce7ed", green:"#e2f0e5" };
  const THEME_ACCENTS = { light:"#4285f4", dark:"#8ab4f8", blue:"#8ab4f8", rose:"#c2185b", green:"#188038" };
  let searchEngine = "duckduckgo";
  let browserTheme = "light";
  try {
    const savedSearchEngine = localStorage.getItem(SEARCH_ENGINE_KEY);
    if (SEARCH_ENGINES.includes(savedSearchEngine)) searchEngine = savedSearchEngine;
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(savedTheme)) browserTheme = savedTheme;
  } catch {}
  if (searchEngineSelect) searchEngineSelect.value = searchEngine;
  if (themeSelect) themeSelect.value = browserTheme;
  document.documentElement.dataset.theme = browserTheme;
  const ENGINE_MODE_KEY = "schoolmathtime.engineMode";
  let engineMode = "auto";
  try { engineMode = localStorage.getItem(ENGINE_MODE_KEY) || "auto"; } catch {}
  if (!["auto", "uv", "classic"].includes(engineMode)) engineMode = "auto";
  if (engineModeSelect) engineModeSelect.value = engineMode;
  const stage = document.querySelector(".uv-stage");
  const BOOKMARKS_KEY = "schoolmathtime.bookmarks";
  const HISTORY_KEY = "schoolmathtime.history";
  let connection = null;
  let lastTarget = "";
  let hasLoaded = false;
  let activeEngine = "";
  let raceSerial = 0;
  let transportReady = null;
  let preferredTransport = "epoxy";
  let routedAttempt = null;
  let singleEngineTimer = null;
  let automaticFailureDetails = "";
  let scramjetController = null;
  let scramjetFrame = null;
  let scramjetLoading = null;

  function setStatus(message) { status.textContent = message; }

  function applyBrowserTheme(value) {
    browserTheme = THEMES.includes(value) ? value : "light";
    document.documentElement.dataset.theme = browserTheme;
    if (themeSelect) themeSelect.value = browserTheme;
    if (themeColorMeta) themeColorMeta.content = THEME_COLORS[browserTheme];
    try { localStorage.setItem(THEME_KEY, browserTheme); } catch {}
    updatePageIdentity(currentTarget() || lastTarget || location.origin);
  }

  function updatePageIdentity(value) {
    let host = "schoolmathtime";
    try { host = new URL(value, location.href).hostname.replace(/^www\./i, "") || host; } catch {}
    const initial = /^[a-z0-9]/i.test(host) ? host[0].toUpperCase() : "S";
    const accent = THEME_ACCENTS[browserTheme] || THEME_ACCENTS.light;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="' + accent + '"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="39" font-weight="700" fill="#ffffff">' + initial + '</text></svg>';
    if (faviconLink) faviconLink.href = "data:image/svg+xml," + encodeURIComponent(svg);
    if (themeColorMeta) themeColorMeta.content = THEME_COLORS[browserTheme];
    document.title = host + " — Schoolmathtime";
  }

  function buildSearchUrl(query) {
    const q = encodeURIComponent(query);
    const engines = {
      duckduckgo: "https://duckduckgo.com/?q=" + q,
      google: "https://www.google.com/search?gbv=1&q=" + q,
      bing: "https://www.bing.com/search?q=" + q,
      brave: "https://search.brave.com/search?q=" + q,
      yahoo: "https://search.yahoo.com/search?p=" + q,
      ecosia: "https://www.ecosia.org/search?q=" + q,
      startpage: "https://www.startpage.com/sp/search?query=" + q
    };
    return engines[searchEngine] || engines.duckduckgo;
  }
  function setError(message) {
    error.textContent = String(message || "Unknown proxy error");
    error.hidden = false;
    copyError.hidden = false;
    error.focus();
    setStatus("Automatic recovery could not open this page. The error text is selectable.");
  }

  // Some Wisp handshakes can stall instead of rejecting. Bound transport setup
  // so the classic route remains usable and a later navigation can reconnect.
  function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]).finally(() => window.clearTimeout(timer));
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
    return buildSearchUrl(input);
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
    const wispUrl = "wss://" + location.host + "/wisp/";
    const transportCandidates = [
      {
        id: "epoxy",
        name: "Epoxy",
        url: "/epoxy/index.mjs?build=wisp-mux-reset-3",
        options: [{ wisp: wispUrl, wisp_v2: true }]
      },
      {
        id: "libcurl",
        name: "Libcurl",
        url: "/libcurl/index.mjs?build=libcurl-fallback-1",
        options: [{ websocket: wispUrl }]
      }
    ].sort((a, b) => Number(b.id === preferredTransport) - Number(a.id === preferredTransport));
    const transportFailures = [];
    let selectedTransport = "";

    // Use one shared BareMux worker for both engines and both transports.
    // Scramjet's service worker locates this worker through the path registered
    // by the browser page, so transport fallback must not create a second worker.
    if (!connection) connection = new BareMux.BareMuxConnection("/baremux/worker.js");
    for (const candidate of transportCandidates) {
      try {
        await withTimeout(
          connection.setTransport(candidate.url, candidate.options),
          12000,
          candidate.name + " transport did not initialize within 12 seconds."
        );
        selectedTransport = candidate.name;
        preferredTransport = candidate.id;
        break;
      } catch (error) {
        transportFailures.push(candidate.name + ": " + String(error && error.message ? error.message : error));
        preferredTransport = candidate.id === "epoxy" ? "libcurl" : "epoxy";
      }
    }

    if (!selectedTransport || !connection) {
      throw new Error(
        "Neither Epoxy nor Libcurl could initialize. Check the /wisp/ WebSocket endpoint, TLS configuration, and transport assets.\n" +
        transportFailures.join("\n")
      );
    }

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
        // Drop the connection wrapper after a failed initialization. The next
        // navigation will create a fresh BareMuxConnection and call setTransport
        // again instead of reusing a wrapper whose transport may have died.
        transportReady = null;
        // Keep the same BareMuxConnection; its worker client can reacquire a
        // dead port, and the next attempt will replace the transport in place.
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

  function hostMatchesRoots(host, roots) {
    return roots.some((root) => host === root || host.endsWith("." + root));
  }

  function preferredEngineFor(value) {
    let host = "";
    try { host = new URL(value).hostname.toLowerCase().replace(/\.$/, ""); } catch {}

    // JavaScript-heavy apps benefit from the service-worker browser engine.
    const webAppHosts = [
      "youtube.com", "youtube-nocookie.com", "accounts.google.com",
      "myaccount.google.com", "consent.google.com", "discord.com",
      "discordapp.com", "discordapp.net", "discord.gg", "tiktok.com",
      "spotify.com"
    ];
    if (hostMatchesRoots(host, webAppHosts)) return "uv";

    // Text-first pages avoid initializing a service worker and Wisp transport
    // unless the classic route actually fails.
    const textFirstHosts = [
      "wikipedia.org", "wiktionary.org", "wikimedia.org",
      "developer.mozilla.org", "mdn.dev", "docs.python.org", "docs.rs",
      "readthedocs.io", "nodejs.org", "docs.github.com", "docs.npmjs.com",
      "support.mozilla.org", "w3.org", "ietf.org", "apnews.com",
      "reuters.com", "bbc.com", "npr.org", "theguardian.com", "nytimes.com"
    ];
    if (hostMatchesRoots(host, textFirstHosts) || host.startsWith("docs.") || host.startsWith("wiki.")) {
      return "classic";
    }

    // Default to one engine at a time instead of doubling every request.
    return "uv";
  }

  function openTarget(value, pushState = true) {
    let target;
    try { target = makeTarget(value); }
    catch (err) { setError(err.message || err); return; }
    updatePageIdentity(target);

    if (activeEngine === "scramjet") {
      void openScramjet(target, pushState);
      return;
    }

    if (singleEngineTimer) window.clearTimeout(singleEngineTimer);
    routedAttempt = null;
    singleEngineTimer = null;
    automaticFailureDetails = "";
    error.hidden = true;
    copyError.hidden = true;
    if (pushState) {
      history.pushState({ target }, "", "/ultraviolet.html?url=" + encodeURIComponent(target));
    }

    const preferred = engineMode === "auto" ? preferredEngineFor(target) : engineMode;
    const hostname = new URL(target).hostname;
    const context = {
      target,
      preferredEngine: preferred,
      activeEngine: "",
      engineAttempts: { uv: 0, classic: 0 },
      failures: { uv: [], classic: [] },
      transportFallbackTried: false
    };
    routedAttempt = context;
    lastTarget = target;
    address.value = target;
    hasLoaded = false;
    welcome.style.display = "none";
    setStatus("Opening " + hostname + " with " +
      (preferred === "uv" ? "Ultraviolet" : "the classic browser") +
      ". Engine and transport fallback are automatic.");
    refreshBookmarkState();
    openSingleEngine(preferred, target, context);
  }

  function currentTarget() {
    if (activeEngine === "scramjet") return lastTarget;
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

  function openSingleEngine(engine, value, context = null) {
    let target;
    try { target = makeTarget(value || currentTarget() || lastTarget || address.value); }
    catch (err) {
      if (context) handleRoutedFailure(engine, err.message || err);
      else setError(err.message || err);
      return;
    }

    if (singleEngineTimer) window.clearTimeout(singleEngineTimer);
    singleEngineTimer = null;
    if (singleEngineTimer) window.clearTimeout(singleEngineTimer);
    singleEngineTimer = null;
    const switchId = ++raceSerial;
    const winner = engine === "uv" ? frame : classicFrame;
    const loser = engine === "uv" ? classicFrame : frame;

    routedAttempt = context;
    if (context) {
      context.activeEngine = engine;
      context.engineAttempts[engine] += 1;
      singleEngineTimer = window.setTimeout(() => {
        handleRoutedFailure(engine, "Timed out while opening the website.");
      }, 45000);
    }

    activeEngine = engine;
    lastTarget = target;
    address.value = target;
    hasLoaded = false;
    error.hidden = true;
    copyError.hidden = true;
    welcome.style.display = "none";
    document.body.classList.toggle("classic-active", engine === "classic");
    if (scramjetFrame?.frame) scramjetFrame.frame.style.display = "none";
    winner.style.display = "block";
    winner.classList.add("race-hidden");
    loser.style.display = "block";
    loser.classList.add("race-hidden");
    loser.dataset.expectedSrc = "";
    loser.src = "about:blank";
    winner.dataset.expectedSrc = "";

    if (engine === "classic") {
      const classicPath = "/browse?url=" + encodeURIComponent(target);
      winner.dataset.expectedSrc = new URL(classicPath, location.href).href;
      winner.src = classicPath;
      winner.classList.remove("race-hidden");
      if (context) {
        setStatus("Opening " + new URL(target).hostname + " with the classic browser…");
      } else {
        hasLoaded = true;
      }
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
        if (context) {
          handleRoutedFailure("uv", err && err.stack ? err.stack : err);
          return;
        }
        welcome.style.display = "flex";
        setError(err && err.stack ? err.stack : err);
      }
    })();
  }

  function handleRoutedLoad(engine, candidateFrame) {
    const context = routedAttempt;
    if (!context || context.activeEngine !== engine) return;
    const expected = candidateFrame.dataset.expectedSrc || "";
    if (!expected || candidateFrame.src === "about:blank" || candidateFrame.src !== expected) return;

    const failure = candidateFailure(candidateFrame);
    if (failure) {
      handleRoutedFailure(engine, failure);
      return;
    }

    if (singleEngineTimer) window.clearTimeout(singleEngineTimer);
    singleEngineTimer = null;
    routedAttempt = null;
    activeEngine = engine;
    hasLoaded = true;
    document.body.classList.toggle("classic-active", engine === "classic");
    const winner = engine === "uv" ? frame : classicFrame;
    const loser = engine === "uv" ? classicFrame : frame;
    winner.style.display = "block";
    winner.classList.remove("race-hidden");
    loser.classList.add("race-hidden");
    loser.dataset.expectedSrc = "";
    loser.src = "about:blank";
    welcome.style.display = "none";

    const hostname = new URL(context.target).hostname;
    setStatus("Opened " + hostname + " with " +
      (engine === "uv" ? "Ultraviolet" : "the classic browser") +
      (engine === context.preferredEngine ? "." : " after automatic fallback."));
    lastTarget = context.target;
    address.value = context.target;
    recordHistory(context.target);
    refreshBookmarkState();
  }

  function automaticFailureSummary(context) {
    const lines = [];
    for (const engine of ["uv", "classic"]) {
      const attempts = context.failures[engine] || [];
      for (let index = 0; index < attempts.length; index += 1) {
        lines.push((engine === "uv" ? "Ultraviolet" : "Classic") +
          (attempts.length > 1 ? " attempt " + (index + 1) : "") + ": " + attempts[index]);
      }
    }
    return lines.join("\n");
  }

  function handleRoutedFailure(engine, reason) {
    const context = routedAttempt;
    if (!context || context.activeEngine !== engine) return;
    if (singleEngineTimer) window.clearTimeout(singleEngineTimer);
    singleEngineTimer = null;

    context.failures[engine].push(String(reason || "The route failed to load.").slice(0, 900));

    // If Ultraviolet loaded its route but could not use the active transport,
    // retry Ultraviolet once with the other installed transport automatically.
    if (engine === "uv" && !context.transportFallbackTried) {
      context.transportFallbackTried = true;
      preferredTransport = preferredTransport === "epoxy" ? "libcurl" : "epoxy";
      transportReady = null;
      setStatus("Ultraviolet did not respond. Retrying automatically with the backup transport…");
      openSingleEngine("uv", context.target, context);
      return;
    }

    const other = engine === "uv" ? "classic" : "uv";
    if (context.engineAttempts[other] === 0) {
      setStatus("The first route failed. Trying the other browser engine automatically…");
      openSingleEngine(other, context.target, context);
      return;
    }

    // Scramjet is the final automatic fallback; no engine or transport chooser
    // is shown to the user. If it also fails, show the selectable diagnostics.
    routedAttempt = null;
    automaticFailureDetails = automaticFailureSummary(context);
    setStatus("Ultraviolet and the classic browser failed. Trying Scramjet automatically…");
    void openScramjet(context.target, false);
  }

  async function loadScramjetRuntime() {
    if (scramjetController) return scramjetController;
    if (scramjetLoading) return scramjetLoading;

    scramjetLoading = (async () => {
      if (typeof window.$scramjetLoadController !== "function") {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "/scram/scramjet.all.js?v=scramjet-1-1-0";
          script.async = true;
          script.onload = resolve;
          script.onerror = () => reject(new Error("Scramjet's browser bundle did not load from /scram/."));
          document.head.appendChild(script);
        });
      }
      if (typeof window.$scramjetLoadController !== "function") {
        throw new Error("Scramjet's controller export was not found after loading its bundle.");
      }

      const { ScramjetController } = window.$scramjetLoadController();
      const controller = new ScramjetController({
        files: {
          wasm: "/scram/scramjet.wasm.wasm",
          all: "/scram/scramjet.all.js",
          sync: "/scram/scramjet.sync.js"
        }
      });
      await withTimeout(
        Promise.resolve(controller.init()),
        15000,
        "Scramjet did not finish initialization within 15 seconds."
      );
      scramjetController = controller;
      return controller;
    })();

    try {
      return await scramjetLoading;
    } catch (error) {
      scramjetLoading = null;
      throw error;
    }
  }

  async function openScramjet(value, pushState = true) {
    let target;
    try { target = makeTarget(value || currentTarget() || lastTarget || address.value); }
    catch (error) { setError(error.message || error); return; }
    updatePageIdentity(target);

    if (singleEngineTimer) window.clearTimeout(singleEngineTimer);
    singleEngineTimer = null;
    routedAttempt = null;
    const switchId = ++raceSerial;
    activeEngine = "scramjet";
    lastTarget = target;
    address.value = target;
    hasLoaded = false;
    error.hidden = true;
    copyError.hidden = true;
    welcome.style.display = "none";
    document.body.classList.remove("classic-active");
    frame.style.display = "none";
    classicFrame.style.display = "none";
    frame.classList.add("race-hidden");
    classicFrame.classList.add("race-hidden");
    if (scramjetFrame?.frame) scramjetFrame.frame.style.display = "none";

    if (pushState) {
      history.pushState({ target }, "", "/ultraviolet.html?url=" + encodeURIComponent(target));
    }
    setStatus("Preparing Scramjet for " + new URL(target).hostname + "…");

    try {
      // Configure BareMux before registering the service worker, matching the
      // upstream Scramjet app's initialization order.
      await ensureTransport();
      if (switchId !== raceSerial || activeEngine !== "scramjet") return;
      const controller = await loadScramjetRuntime();
      if (switchId !== raceSerial || activeEngine !== "scramjet") return;
      if (!navigator.serviceWorker) {
        throw new Error("This browser does not support service workers. Use Schoolmathtime over HTTPS.");
      }
      await withTimeout(
        navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }),
        15000,
        "Scramjet's service worker did not register within 15 seconds."
      );
      if (switchId !== raceSerial || activeEngine !== "scramjet") return;

      if (!scramjetFrame) {
        scramjetFrame = controller.createFrame();
        scramjetFrame.frame.id = "scramjet-frame";
        scramjetFrame.frame.title = "Scramjet browser";
        scramjetFrame.frame.classList.add("race-hidden");
        stage.appendChild(scramjetFrame.frame);
      }
      scramjetFrame.frame.style.display = "block";
      scramjetFrame.frame.classList.remove("race-hidden");
      scramjetFrame.go(target);
      hasLoaded = true;
      automaticFailureDetails = "";
      recordHistory(target);
      setStatus("Opened " + new URL(target).hostname + " with Scramjet (automatic fallback).");
      refreshBookmarkState();
    } catch (error) {
      if (switchId !== raceSerial) return;
      activeEngine = "";
      if (scramjetFrame?.frame) scramjetFrame.frame.style.display = "none";
      welcome.style.display = "flex";
      const priorFailures = automaticFailureDetails;
      automaticFailureDetails = "";
      setError("Automatic recovery could not open " + new URL(target).hostname + "." +
        (priorFailures ? "\n\nPrevious attempts:\n" + priorFailures : "") +
        "\n\nScramjet: " + String(error && error.stack ? error.stack : error).slice(0, 1800));
    }
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

  function readHistory() {
    try {
      const items = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(items) ? items.filter((item) => item && typeof item.url === "string") : [];
    } catch { return []; }
  }

  function renderLibraryEntries(container, items, emptyText) {
    if (!container) return;
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "uv-library-empty";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }

    for (const item of items) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      const title = document.createElement("span");
      const url = document.createElement("span");
      button.type = "button";
      button.className = "uv-library-entry";
      button.title = item.url;
      title.className = "uv-library-entry-title";
      url.className = "uv-library-entry-url";
      title.textContent = item.title || (() => { try { return new URL(item.url).hostname; } catch { return item.url; } })();
      url.textContent = item.url;
      button.append(title, url);
      button.addEventListener("click", () => {
        if (library) library.open = false;
        address.value = item.url;
        void openTarget(item.url);
      });
      li.appendChild(button);
      container.appendChild(li);
    }
  }

  function renderLibrary() {
    renderLibraryEntries(bookmarkList, readBookmarks(), "No bookmarks yet.");
    renderLibraryEntries(historyList, readHistory(), "Pages you open will appear here.");
  }

  function recordHistory(target) {
    try {
      const url = new URL(target);
      if (url.protocol !== "https:") return;
      const items = readHistory().filter((item) => item.url !== url.toString());
      items.unshift({ title: url.hostname, url: url.toString(), visitedAt: Date.now() });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 50)));
    } catch {}
    renderLibrary();
  }

  function refreshBookmarkState() {
    const target = currentTarget();
    const saved = readBookmarks().some((item) => item.url === target);
    bookmark.textContent = saved ? "★" : "☆";
    bookmark.setAttribute("aria-pressed", String(saved));
    renderLibrary();
  }

  searchEngineSelect?.addEventListener("change", () => {
    searchEngine = SEARCH_ENGINES.includes(searchEngineSelect.value) ? searchEngineSelect.value : "duckduckgo";
    try { localStorage.setItem(SEARCH_ENGINE_KEY, searchEngine); } catch {}
    setStatus("Default search engine saved: " + searchEngineSelect.options[searchEngineSelect.selectedIndex].text + ".");
  });

  themeSelect?.addEventListener("change", () => {
    applyBrowserTheme(themeSelect.value);
    setStatus("Browser color theme updated.");
  });

  engineModeSelect?.addEventListener("change", () => {
    engineMode = ["auto", "uv", "classic"].includes(engineModeSelect.value) ? engineModeSelect.value : "auto";
    try { localStorage.setItem(ENGINE_MODE_KEY, engineMode); } catch {}
    const target = currentTarget();
    if (target) void openTarget(target, false);
    else setStatus(engineMode === "auto" ? "Automatic engine routing enabled." : "Preferred engine set to " + (engineMode === "uv" ? "Ultraviolet" : "Classic") + ". Automatic fallback remains enabled.");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void openTarget(address.value);
  });
  byId("uv-back").addEventListener("click", () => {
    try {
      const activeFrame = activeEngine === "classic" ? classicFrame :
        activeEngine === "scramjet" ? scramjetFrame?.frame : frame;
      if (activeEngine && activeFrame) activeFrame.contentWindow.history.back();
      else history.back();
    } catch { history.back(); }
  });
  byId("uv-forward").addEventListener("click", () => {
    try {
      const activeFrame = activeEngine === "classic" ? classicFrame :
        activeEngine === "scramjet" ? scramjetFrame?.frame : frame;
      if (activeEngine && activeFrame) activeFrame.contentWindow.history.forward();
      else history.forward();
    } catch { history.forward(); }
  });
  byId("uv-refresh").addEventListener("click", () => {
    const target = currentTarget() || address.value.trim();
    if (target) {
      transportReady = null;
      if (activeEngine === "scramjet") void openScramjet(target, false);
      else void openTarget(target, false);
    } else location.reload();
  });
  clearHistoryButton?.addEventListener("click", () => {
    try {
      localStorage.removeItem(HISTORY_KEY);
      renderLibrary();
      setStatus("Browsing history cleared on this device.");
    } catch {
      setStatus("Browsing history could not be cleared in this browser.");
    }
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
    renderLibrary();
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
    if (routedAttempt && routedAttempt.activeEngine === "uv") {
      handleRoutedLoad("uv", frame);
      return;
    }
    if (activeEngine === "uv") {
      const activeTarget = currentTarget();
      const failure = candidateFailure(frame);
      if (failure && activeTarget) {
        void openTarget(activeTarget, false);
        return;
      }
      hasLoaded = true;
      if (activeTarget) {
        lastTarget = activeTarget;
        address.value = activeTarget;
        recordHistory(activeTarget);
      }
      setUltravioletLoadedStatus();
      refreshBookmarkState();
    }
  });
  classicFrame.addEventListener("load", () => {
    if (routedAttempt && routedAttempt.activeEngine === "classic") {
      handleRoutedLoad("classic", classicFrame);
      return;
    }
    if (activeEngine === "classic") {
      const activeTarget = currentTarget();
      const failure = candidateFailure(classicFrame);
      if (failure && activeTarget) {
        void openTarget(activeTarget, false);
        return;
      }
      if (activeTarget) {
        lastTarget = activeTarget;
        address.value = activeTarget;
        recordHistory(activeTarget);
      }
      setStatus("Page loaded through the classic browser.");
      refreshBookmarkState();
    }
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

  applyBrowserTheme(browserTheme);
  renderLibrary();
  const initial = new URLSearchParams(location.search).get("url");
  if (initial) {
    address.value = initial;
    void openTarget(initial, false);
  }
})();
