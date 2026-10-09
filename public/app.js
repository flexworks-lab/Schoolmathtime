const loginPanel = document.querySelector("#loginPanel");
const appPanel = document.querySelector("#appPanel");
const loginForm = document.querySelector("#loginForm");
const accessKey = document.querySelector("#accessKey");
const loginMessage = document.querySelector("#loginMessage");
const domainList = document.querySelector("#domainList");
const targetInput = document.querySelector("#targetInput");

function showApp(config) {
  loginPanel.hidden = true;
  appPanel.hidden = false;
  loginMessage.textContent = "";
  domainList.replaceChildren();
  const domains = Array.isArray(config?.allowedHosts) ? config.allowedHosts : [];
  if (!domains.length) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "No approved domains are configured. Ask the operator to update ALLOWED_HOSTS.";
    domainList.append(note);
    return;
  }
  for (const host of domains) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "domain-button";
    button.textContent = host;
    button.addEventListener("click", () => {
      targetInput.value = "https://" + host;
      document.querySelector("#browseForm").requestSubmit();
    });
    domainList.append(button);
  }
}

async function loadSession() {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) return;
    const data = await response.json();
    if (data.authenticated) showApp(data);
  } catch {
    // The login form remains available if the session endpoint is unreachable.
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
  } catch (error) {
    loginMessage.textContent = error.message || "Unable to connect. Try again.";
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Continue <span aria-hidden="true">↗</span>';
  }
});

document.querySelector("#browseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = targetInput.value.trim();
  if (!value) return;
  window.location.assign("/browse?url=" + encodeURIComponent(value));
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try { await fetch("/logout", { method: "POST", credentials: "same-origin" }); } catch {}
  appPanel.hidden = true;
  loginPanel.hidden = false;
  accessKey.value = "";
  targetInput.value = "";
});

loadSession();
