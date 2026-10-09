const loginPanel = document.querySelector("#loginPanel");
const appPanel = document.querySelector("#appPanel");
const loginForm = document.querySelector("#loginForm");
const accessKey = document.querySelector("#accessKey");
const loginMessage = document.querySelector("#loginMessage");
const domainList = document.querySelector("#domainList");
const targetInput = document.querySelector("#targetInput");
const browserAddress = document.querySelector("#browserAddress");
const browserNotice = document.querySelector("#browserNotice");
const tabTitle = document.querySelector("#tabTitle");
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
    return Array.isArray(value) ? value.filter((item) => item && typeof item.url === "string" && typeof item.title === "string") : [];
  } catch {
    return [];
  }
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
  bookmarks.forEach((bookmark, index) => addShortcut(savedList, bookmark.title, bookmark.url, index, true));
}

function showApp(config) {
  loginPanel.hidden = true;
  appPanel.hidden = false;
  loginMessage.textContent = "";
  domainList.replaceChildren();
  const domains = Array.isArray(config?.allowedHosts) ? config.allowedHosts : [];
  if (config?.browseAllPublicDomains) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "Any public HTTPS website can be entered in the address bar.";
    domainList.append(note);
    renderBookmarks();
    tabTitle.textContent = "New Tab — Schoolmathtime";
    browserAddress.value = "";
    return;
  }
  if (!domains.length) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "No approved domains are configured. Ask the operator to update ALLOWED_HOSTS.";
    domainList.append(note);
  } else {
    for (const host of domains) addShortcut(domainList, host, "https://" + host);
  }
  renderBookmarks();
  tabTitle.textContent = "New Tab — Schoolmathtime";
  browserAddress.value = "";
}

function navigate(value) {
  const query = String(value || "").trim();
  if (!query) return;
  const isUrl = query.startsWith("https://") || query.startsWith("http://") ||
    (!query.split("").some((character) => character.charCodeAt(0) <= 32) && query.includes("."));
  if (!isUrl) {
    const googleUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);
    const opened = window.open(googleUrl, "_blank");
    if (opened) {
      opened.opener = null;
      announce("Google Search opened in a new tab. Enter a result URL here to browse it through Schoolmathtime.");
      return;
    }
    // Fall back to the server redirect if this browser blocks opening a new tab.
  }
  window.location.assign("/browse?url=" + encodeURIComponent(query));
}

async function loadSession() {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) return;
    const data = await response.json();
    if (data.authenticated) showApp(data);
  } catch {
    // Keep the access form available if the session endpoint is unreachable.
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = accessKey.value;
  if (!key) return;
  const submitButton = loginForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  submitButton.textContent = "Checking…";
  loginMessage.textContent = "";
  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ accessKey: key })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Access could not be verified.");
    accessKey.value = "";
    showApp(data);
    announce("You're signed in. Type a URL or search in the address bar.");
  } catch (error) {
    loginMessage.textContent = error.message || "Unable to connect. Try again.";
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Unlock <span aria-hidden="true">↗</span>';
  }
});

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

document.querySelector("#clearSearchButton").addEventListener("click", () => {
  targetInput.value = "";
  targetInput.focus();
});

document.querySelector("#backButton").addEventListener("click", () => window.history.back());
document.querySelector("#forwardButton").addEventListener("click", () => window.history.forward());
document.querySelector("#refreshButton").addEventListener("click", () => window.location.reload());
document.querySelector("#newTabButton").addEventListener("click", () => window.open("/", "_blank", "noopener"));
document.querySelector("#closeTabButton").addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else announce("This is your start tab.");
});
document.querySelector("#browserMenuButton").addEventListener("click", () => {
  announce("Schoolmathtime · Safe, read-only browsing for operator-approved sites.");
});
document.querySelector("#bookmarkButton").addEventListener("click", () => {
  const candidate = browserAddress.value.trim();
  if (!candidate || candidate === window.location.host || candidate.startsWith("schoolmathtime://")) {
    announce("Open a page first, then bookmark it from the address bar.");
    return;
  }
  let url;
  try {
    url = /^https?:\/\//i.test(candidate) ? new URL(candidate) : new URL("https://" + candidate);
  } catch {
    announce("Enter a full website address to bookmark it.");
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

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try { await fetch("/logout", { method: "POST", credentials: "same-origin" }); } catch {}
  appPanel.hidden = true;
  loginPanel.hidden = false;
  accessKey.value = "";
  targetInput.value = "";
  browserAddress.value = "";
  announce("You have signed out.");
});

browserAddress.addEventListener("keydown", (event) => {
  if (event.key === "Escape") browserAddress.value = "";
});
targetInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") targetInput.value = "";
});

loadSession();
