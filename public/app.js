const domainList = document.querySelector("#domainList");
const targetInput = document.querySelector("#targetInput");
const browserAddress = document.querySelector("#browserAddress");
const browserNotice = document.querySelector("#browserNotice");
const BOOKMARKS_KEY = "schoolmathtime.bookmarks";
const SEARCH_ENGINE_KEY = "schoolmathtime.searchEngine";
const THEME_KEY = "schoolmathtime.theme";
const searchEngineSelect = document.querySelector("#searchEngineSelect");
const themeSelect = document.querySelector("#themeSelect");
const themeColorMeta = document.querySelector("#appThemeColor");
const faviconLink = document.querySelector("#appFavicon");
const THEME_ACCENTS = { light: "#4285f4", dark: "#8ab4f8", blue: "#8ab4f8", rose: "#c2185b", green: "#188038" };
const THEME_COLORS = { light: "#f8f9fa", dark: "#202124", blue: "#17263e", rose: "#fce7ed", green: "#e2f0e5" };
function readPreference(key, allowed, fallback) {
  try { const value = localStorage.getItem(key); return allowed.includes(value) ? value : fallback; }
  catch { return fallback; }
}
let searchEngine = readPreference(SEARCH_ENGINE_KEY, ["duckduckgo","google","bing","brave","yahoo","ecosia","startpage"], "duckduckgo");
let browserTheme = readPreference(THEME_KEY, ["light","dark","blue","rose","green"], "light");
if (searchEngineSelect) searchEngineSelect.value = searchEngine;
if (themeSelect) themeSelect.value = browserTheme;
document.documentElement.dataset.theme = browserTheme;
if (themeColorMeta) themeColorMeta.content = THEME_COLORS[browserTheme];
function applyBrowserTheme(value) {
  browserTheme = ["light","dark","blue","rose","green"].includes(value) ? value : "light";
  document.documentElement.dataset.theme = browserTheme;
  if (themeSelect) themeSelect.value = browserTheme;
  if (themeColorMeta) themeColorMeta.content = THEME_COLORS[browserTheme];
  try { localStorage.setItem(THEME_KEY, browserTheme); } catch {}
}
function makeFaviconFor(value) {
  let host = "schoolmathtime";
  try { host = new URL(value).hostname.replace(/^www\./i, "") || host; } catch {}
  const initial = /^[a-z0-9]/i.test(host) ? host[0].toUpperCase() : "S";
  const accent = THEME_ACCENTS[browserTheme] || THEME_ACCENTS.light;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="' + accent + '"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="39" font-weight="700" fill="#ffffff">' + initial + '</text></svg>';
  if (faviconLink) faviconLink.href = "data:image/svg+xml," + encodeURIComponent(svg);
  return host;
}
function searchUrl(query) {
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

function announce(message) {
  browserNotice.textContent = message;
  browserNotice.hidden = false;
  window.clearTimeout(announce.timeout);
  announce.timeout = window.setTimeout(() => { browserNotice.hidden = true; }, 3800);
}

function getBookmarks() {
  try {
    const value = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((item) => item && typeof item.url === "string" && typeof item.title === "string")
      : [];
  } catch {
    return [];
  }
}

function navigate(value) {
  const query = String(value || "").trim();
  if (!query) return;
  const isUrl = query.startsWith("https://") || query.startsWith("http://") ||
    (!query.split("").some((character) => character.charCodeAt(0) <= 32) && query.includes("."));
  const destination = isUrl
    ? query
    : searchUrl(query);
  const host = makeFaviconFor(destination);
  document.title = host + " — Schoolmathtime";
  window.location.assign("/ultraviolet.html?url=" + encodeURIComponent(destination));
}

function addShortcut(container, label, url, index = 0, canRemove = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "shortcut";
  const icon = document.createElement("span");
  icon.className = "shortcut-icon";
  icon.textContent = label.replace(/^www\./, "").slice(0, 1).toUpperCase();
  const text = document.createElement("span");
  text.className = "shortcut-label";
  text.textContent = label;
  button.append(icon, text);
  button.title = url;
  button.addEventListener("click", () => {
    browserAddress.value = url;
    targetInput.value = url;
    navigate(url);
  });
  if (canRemove) {
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const bookmarks = getBookmarks();
      bookmarks.splice(index, 1);
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
      renderBookmarks();
      announce("Bookmark removed.");
    });
    button.title = url + " (right-click to remove)";
  }
  container.append(button);
}

function renderBookmarks() {
  const savedSection = document.querySelector("#savedSection");
  const savedList = document.querySelector("#savedList");
  const bookmarks = getBookmarks();
  savedList.replaceChildren();
  savedSection.hidden = bookmarks.length === 0;
  bookmarks.forEach((bookmark, index) =>
    addShortcut(savedList, bookmark.title, bookmark.url, index, true)
  );
}

function showHome(config = {}) {
  domainList.replaceChildren();
  const domains = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
  if (config.browseAllPublicDomains) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "Any public HTTPS website can be entered.";
    domainList.append(note);
  } else if (domains.length) {
    for (const host of domains) addShortcut(domainList, host, "https://" + host);
  } else {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "Enter a public HTTPS website above.";
    domainList.append(note);
  }
  renderBookmarks();
}

async function loadHome() {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Site settings are unavailable.");
    showHome(await response.json());
  } catch {
    showHome({ browseAllPublicDomains: true, allowedHosts: [] });
  }
}

document.querySelector("#addressForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = browserAddress.value.trim();
  if (!value) return;
  targetInput.value = value;
  navigate(value);
});

searchEngineSelect?.addEventListener("change", () => {
  searchEngine = ["duckduckgo","google","bing","brave","yahoo","ecosia","startpage"].includes(searchEngineSelect.value) ? searchEngineSelect.value : "duckduckgo";
  try { localStorage.setItem(SEARCH_ENGINE_KEY, searchEngine); } catch {}
  const names = { duckduckgo:"DuckDuckGo", google:"Google", bing:"Bing", brave:"Brave", yahoo:"Yahoo", ecosia:"Ecosia", startpage:"Startpage" };
  announce("Default search engine: " + names[searchEngine] + ".");
});
themeSelect?.addEventListener("change", () => {
  applyBrowserTheme(themeSelect.value);
  const current = new URLSearchParams(location.search).get("url");
  makeFaviconFor(current || location.origin);
  announce("Browser color theme updated.");
});
document.querySelector("#luckyButton")?.addEventListener("click", () => {
  const value = targetInput.value.trim();
  if (!value) { targetInput.focus(); return; }
  browserAddress.value = value;
  navigate(value);
});
document.querySelector("#browseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = targetInput.value.trim();
  if (!value) return;
  browserAddress.value = value;
  navigate(value);
});

const youtubeSearchForm = document.querySelector("#youtubeSearchForm");
const youtubeSearchInput = document.querySelector("#youtubeSearchInput");
const youtubeSearchStatus = document.querySelector("#youtubeSearchStatus");
const youtubeSearchResults = document.querySelector("#youtubeSearchResults");

function renderYouTubeResults(items) {
  youtubeSearchResults.replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "youtube-result-card";

    if (item.thumbnail) {
      const image = document.createElement("img");
      image.className = "youtube-result-thumbnail";
      image.src = item.thumbnail;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      card.append(image);
    }

    const body = document.createElement("div");
    body.className = "youtube-result-body";

    const title = document.createElement("a");
    title.className = "youtube-result-title";
    title.href = item.watchUrl;
    title.textContent = item.title || "Untitled video";
    body.append(title);

    const channel = document.createElement("p");
    channel.className = "youtube-result-channel";
    channel.textContent = item.channelTitle || "YouTube channel";
    body.append(channel);

    if (item.description) {
      const description = document.createElement("p");
      description.className = "youtube-result-description";
      description.textContent = item.description;
      body.append(description);
    }

    const open = document.createElement("a");
    open.className = "youtube-result-open";
    open.href = item.watchUrl;
    open.textContent = "Open in Schoolmathtime";
    body.append(open);

    card.append(body);
    youtubeSearchResults.append(card);
  }
}

youtubeSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(youtubeSearchInput?.value || "").trim();
  if (query.length < 2) {
    youtubeSearchStatus.textContent = "Enter at least two characters to search.";
    return;
  }

  const submit = youtubeSearchForm.querySelector('button[type="submit"]');
  const oldLabel = submit.textContent;
  submit.disabled = true;
  submit.textContent = "Searching…";
  youtubeSearchStatus.textContent = "Searching YouTube…";
  youtubeSearchResults.replaceChildren();

  try {
    const response = await fetch("/api/youtube/search?q=" + encodeURIComponent(query), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "YouTube search failed. Try again.");
    const items = Array.isArray(data.items) ? data.items : [];
    renderYouTubeResults(items);
    youtubeSearchStatus.textContent = items.length
      ? "Found " + items.length + " videos. Opening a result stays inside Schoolmathtime."
      : "No videos found. Try a different search.";
  } catch (error) {
    youtubeSearchStatus.textContent = error.message || "YouTube search is temporarily unavailable.";
  } finally {
    submit.disabled = false;
    submit.textContent = oldLabel;
  }
});

document.querySelector("#clearSearchButton").addEventListener("click", () => {
  targetInput.value = "";
  targetInput.focus();
});

document.querySelector("#backButton").addEventListener("click", () => window.history.back());
document.querySelector("#forwardButton").addEventListener("click", () => window.history.forward());
document.querySelector("#refreshButton").addEventListener("click", () => window.location.reload());

document.querySelector("#browserMenuButton").addEventListener("click", () => {
  announce("Schoolmathtime · Public HTTPS proxy with supported video embeds. Some sites restrict media playback.");
});

document.querySelector("#bookmarkButton").addEventListener("click", () => {
  const candidate = browserAddress.value.trim();
  if (!candidate || candidate === window.location.host || candidate.startsWith("schoolmathtime://")) {
    announce("Enter a website address first, then bookmark it.");
    return;
  }
  let url;
  try {
    url = /^https?:\/\//i.test(candidate) ? new URL(candidate) : new URL("https://" + candidate);
  } catch {
    announce("Enter a website address to bookmark it.");
    return;
  }
  if (url.protocol !== "https:") {
    announce("Only HTTPS pages can be bookmarked.");
    return;
  }
  const bookmarks = getBookmarks();
  const existing = bookmarks.findIndex((item) => item.url === url.toString());
  if (existing >= 0) {
    bookmarks.splice(existing, 1);
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
    document.querySelector("#bookmarkButton").textContent = "☆";
    announce("Bookmark removed.");
  } else {
    bookmarks.unshift({ title: url.hostname, url: url.toString() });
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks.slice(0, 18)));
    document.querySelector("#bookmarkButton").textContent = "★";
    announce("Bookmark saved. Right-click a saved bookmark to remove it.");
  }
  renderBookmarks();
});

browserAddress.addEventListener("keydown", (event) => {
  if (event.key === "Escape") browserAddress.value = "";
});
targetInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") targetInput.value = "";
});

loadHome();
