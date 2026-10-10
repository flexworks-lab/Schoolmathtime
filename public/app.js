const domainList = document.querySelector("#domainList");
const targetInput = document.querySelector("#targetInput");
const browserAddress = document.querySelector("#browserAddress");
const browserNotice = document.querySelector("#browserNotice");
const BOOKMARKS_KEY = "schoolmathtime.bookmarks";

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
    : "https://www.google.com/search?gbv=1&q=" + encodeURIComponent(query);
  window.location.assign("/browse?url=" + encodeURIComponent(destination));
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
