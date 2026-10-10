(() => {
  "use strict";

  const title = document.querySelector("#youtubeAccountTitle");
  const status = document.querySelector("#youtubeAccountStatus");
  const channel = document.querySelector("#youtubeAccountChannel");
  const connect = document.querySelector("#youtubeAccountConnect");
  const disconnect = document.querySelector("#youtubeAccountDisconnect");
  const authMessages = {
    connected: "Google connected successfully.",
    denied: "Google sign-in was cancelled.",
    error: "Google sign-in could not be completed. Please try again.",
    state_error: "That sign-in attempt expired or was invalid. Please try again.",
    token_error: "Google could not exchange the sign-in code. Check the OAuth client configuration and callback URL.",
    profile_error: "Google signed in, but account details could not be retrieved.",
    youtube_api_error: "Google sign-in worked, but YouTube Data API access failed. Verify the API is enabled and the read-only scope was approved.",
    scope_denied: "You did not grant read-only YouTube access. Connect again and approve the requested YouTube permission.",
    not_configured: "Google sign-in is not configured on this server yet."
  };

  function showStatus(message) {
    status.textContent = message;
  }

  function readAuthResult() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("youtube_auth");
    if (!result) return "";
    params.delete("youtube_auth");
    const query = params.toString();
    const cleanUrl = window.location.pathname + (query ? "?" + query : "") + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);
    return authMessages[result] || authMessages.error;
  }

  async function loadAccount() {
    const authNotice = readAuthResult();
    try {
      const response = await fetch("/api/youtube/account", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not check the account connection.");

      if (!data.configured) {
        title.textContent = "Google sign-in needs setup";
        showStatus(data.setupMessage || "Configure the Google OAuth web client in the server environment.");
        connect.disabled = true;
        disconnect.hidden = true;
        channel.hidden = true;
        if (authNotice) showStatus(authNotice + " " + (data.setupMessage || ""));
        return;
      }

      connect.disabled = false;
      if (!data.connected || !data.account) {
        title.textContent = "Connect your YouTube account";
        connect.textContent = "Connect with Google";
        disconnect.hidden = true;
        channel.hidden = true;
        showStatus(authNotice || "Google's official sign-in grants read-only access to your YouTube channel through Schoolmathtime. It does not sign into the proxied YouTube webpage.");
        return;
      }

      const account = data.account;
      title.textContent = "Connected as " + String(account.name || "Google account");
      connect.textContent = "Switch account";
      disconnect.hidden = false;
      if (account.channelTitle) {
        channel.replaceChildren(document.createTextNode("YouTube channel: " + account.channelTitle + " "));
        if (account.channelUrl) {
          const open = document.createElement("a");
          open.href = account.channelUrl;
          open.textContent = "Open in Schoolmathtime";
          channel.append(open);
        }
        channel.hidden = false;
      } else {
        channel.textContent = "This Google account does not currently expose a YouTube channel.";
        channel.hidden = false;
      }
      const email = String(account.email || "");
      showStatus((email ? email + ". " : "") +
        "Schoolmathtime has read-only YouTube API access. This is not a sign-in session for the proxied YouTube website.");
    } catch (error) {
      title.textContent = "YouTube account connection unavailable";
      showStatus(error.message || "Could not check the account connection.");
      connect.disabled = true;
    }
  }

  connect?.addEventListener("click", () => {
    if (connect.disabled) return;
    connect.disabled = true;
    showStatus("Opening Google's official sign-in page. You'll return to Schoolmathtime afterward.");
    window.location.assign("/auth/google/start");
  });

  disconnect?.addEventListener("click", async () => {
    disconnect.disabled = true;
    showStatus("Disconnecting Google account…");
    try {
      const response = await fetch("/api/youtube/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not disconnect the account.");
      title.textContent = "Connect your YouTube account";
      connect.textContent = "Connect with Google";
      connect.disabled = false;
      disconnect.hidden = true;
      channel.hidden = true;
      showStatus(data.revoked
        ? "Google access was revoked and the Schoolmathtime connection was cleared."
        : "The Schoolmathtime connection was cleared. Google may take a moment to register token revocation.");
    } catch (error) {
      showStatus(error.message || "Could not disconnect the account.");
    } finally {
      disconnect.disabled = false;
    }
  });

  loadAccount();
})();