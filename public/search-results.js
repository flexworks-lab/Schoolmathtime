(() => {
  const normalizedTarget = (raw) => {
    try {
      const candidate = new URL(raw, window.location.href);
      if (candidate.hostname === "google.com" || candidate.hostname.endsWith(".google.com")) {
        if (candidate.pathname === "/url") {
          const target = candidate.searchParams.get("q") || candidate.searchParams.get("url") || candidate.searchParams.get("adurl");
          if (target) return new URL(target, "https://www.google.com").toString();
        }
        return null;
      }
      if (candidate.protocol !== "https:" && candidate.protocol !== "http:") return null;
      return candidate.toString();
    } catch {
      return null;
    }
  };

  const routeResultsThroughProxy = () => {
    const links = document.querySelectorAll(".gsc-webResult a[href], .gsc-result a[href], .gsc-imageResult a[href]");
    for (const link of links) {
      const raw = link.getAttribute("href");
      if (!raw || raw.startsWith("/browse?url=")) continue;
      const target = normalizedTarget(raw);
      if (!target) continue;
      link.href = "/browse?url=" + encodeURIComponent(target);
      link.target = "_self";
      link.rel = "noreferrer noopener";
    }
  };

  const observer = new MutationObserver(() => routeResultsThroughProxy());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  routeResultsThroughProxy();

  window.addEventListener("load", routeResultsThroughProxy);
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest(".gsc-webResult a[href], .gsc-result a[href], .gsc-imageResult a[href]") : null;
    if (!link) return;
    const raw = link.getAttribute("href");
    if (!raw) return;
    const target = normalizedTarget(raw);
    if (!target) return;
    event.preventDefault();
    window.location.assign("/browse?url=" + encodeURIComponent(target));
  }, true);
})();
