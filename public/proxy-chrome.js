(() => {
  const find = (id) => document.getElementById(id);
  const address = find("stm-address");
  const notice = find("stm-browser-notice");
  const BOOKMARKS_KEY = "schoolmathtime.bookmarks";

  function showNotice(message) {
    if (!notice) return;
    notice.textContent = message;
    notice.hidden = false;
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 3500);
  }

  function readBookmarks() {
    try {
      const items = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
      return Array.isArray(items) ? items.filter((item) => item && typeof item.url === "string") : [];
    } catch {
      return [];
    }
  }

  function bookmarkCurrentPage() {
    let target;
    try {
      target = new URL(address ? address.value.trim() : "");
      if (target.protocol !== "https:") throw new Error("https");
    } catch {
      showNotice("Only HTTPS pages can be bookmarked.");
      return;
    }
    const bookmarks = readBookmarks();
    const existing = bookmarks.findIndex((item) => item.url === target.toString());
    if (existing >= 0) {
      bookmarks.splice(existing, 1);
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
      const button = find("stm-bookmark");
      if (button) button.textContent = "☆";
      showNotice("Bookmark removed.");
      return;
    }
    bookmarks.unshift({ title: target.hostname, url: target.toString() });
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks.slice(0, 18)));
    const button = find("stm-bookmark");
    if (button) button.textContent = "★";
    showNotice("Saved to bookmarks. Access is still limited to approved domains.");
  }

  function setBookmarkState() {
    let current = "";
    try { current = new URL(address.value.trim()).toString(); } catch {}
    const saved = readBookmarks().some((item) => item.url === current);
    const button = find("stm-bookmark");
    if (button) button.textContent = saved ? "★" : "☆";
  }

  find("stm-address-form")?.addEventListener("submit", (event) => {
    const raw = address ? address.value.trim() : "";
    if (!raw) return;
    event.preventDefault();
    // Send URLs and search phrases to /browse. The proxy converts plain
    // text into a Google Search URL before fetching the remote page.
    window.location.assign("/browse?url=" + encodeURIComponent(raw));
  });

  find("stm-back")?.addEventListener("click", () => window.history.back());
  find("stm-forward")?.addEventListener("click", () => window.history.forward());
  find("stm-refresh")?.addEventListener("click", () => window.location.reload());
  find("stm-new-tab")?.addEventListener("click", () => window.open("/", "_blank", "noopener"));
  find("stm-close-tab")?.addEventListener("click", () => { window.location.assign("/"); });
  find("stm-bookmark")?.addEventListener("click", bookmarkCurrentPage);
  find("stm-menu")?.addEventListener("click", () => {
    showNotice("JavaScript is enabled for this page. Forms and frames are restricted. Only browse sites you trust; third-party scripts run inside this proxy session.");
  });

  if (address) {
    address.addEventListener("keydown", (event) => {
      if (event.key === "Escape") address.value = "";
    });
    setBookmarkState();
  }
})();