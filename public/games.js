"use strict";
(() => {
  const fileInput = document.getElementById("html-file"), runHtml = document.getElementById("run-html");
  const webForm = document.getElementById("web-form"), webUrl = document.getElementById("web-url");
  const swfInput = document.getElementById("swf-file"), runSwf = document.getElementById("run-swf");
  const viewer = document.getElementById("game-viewer"), ruffleHost = document.getElementById("ruffle-player");
  const status = document.getElementById("games-status"); let localUrl = null;
  const say = (message) => { status.textContent = message; };
  runHtml.addEventListener("click", () => {
    const file = fileInput.files && fileInput.files[0]; if (!file) return say("Choose an HTML file first.");
    if (localUrl) URL.revokeObjectURL(localUrl); localUrl = URL.createObjectURL(file);
    viewer.hidden = false; viewer.removeAttribute("srcdoc"); viewer.src = localUrl;
    say("Running local HTML. The file is not uploaded.");
  });
  webForm.addEventListener("submit", (event) => {
    event.preventDefault(); let url; try { url = new URL(webUrl.value); } catch { return say("Enter a valid HTTPS URL."); }
    if (url.protocol !== "https:") return say("Only HTTPS websites are supported here.");
    viewer.hidden = false; viewer.src = url.href; say("Opening embedded viewer. Some sites block embedding.");
  });
  runSwf.addEventListener("click", async () => {
    const file = swfInput.files && swfInput.files[0]; if (!file) return say("Choose a SWF file first.");
    try {
      if (!window.RufflePlayer) await new Promise((resolve, reject) => {
        const script = document.createElement("script"); script.src = "/ruffle/ruffle.js";
        script.onload = resolve; script.onerror = () => reject(new Error("Local Ruffle runtime is unavailable."));
        document.head.appendChild(script);
      });
      const player = window.RufflePlayer.newest().createPlayer(); ruffleHost.replaceChildren(player);
      player.style.width = "100%"; player.style.height = "480px"; player.load(URL.createObjectURL(file));
      say("Loading SWF locally with Ruffle.");
    } catch (error) { say(error.message || "Ruffle could not start."); }
  });
  window.addEventListener("beforeunload", () => { if (localUrl) URL.revokeObjectURL(localUrl); });
})();