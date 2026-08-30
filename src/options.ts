/**
 * Purpose: persist the locally provisioned bridge secret AND the declared profile identity
 * together, so neither can be saved in a half-configured state.
 * Args: none; values are read from the options page controls.
 * Returns: a promise resolving after validation and extension-storage write.
 * Examples: user enters a 16-character secret plus a profile name and clicks Save; user enters a
 * short secret and receives a validation message without anything being persisted.
 */
async function saveConfiguration(): Promise<void> {
  const secretInput = document.querySelector<HTMLInputElement>("#secret");
  const profileInput = document.querySelector<HTMLInputElement>("#profile");
  const status = document.querySelector<HTMLElement>("#status");
  if (!secretInput || !profileInput || !status) return;
  if (secretInput.value.length < 16 || !/^[\x20-\x7E]+$/u.test(secretInput.value)) {
    status.textContent = "The shared secret must be ASCII and contain at least 16 characters.";
    return;
  }
  const profile = profileInput.value.trim();
  if (!profile) {
    status.textContent = "The browser-proxy profile name cannot be empty.";
    return;
  }
  await chrome.storage.local.set({ bridgeSharedSecret: secretInput.value, browserProxyProfile: profile });
  secretInput.value = "";
  hideGeneratedSecret();
  await chrome.runtime.sendMessage({ type: "bridgeSecretSaved" });
  status.textContent = `Shared secret saved locally for profile "${profile}".`;
}

/**
 * Purpose: pre-fill the profile field with the previously saved value, or "default" otherwise.
 * Args: none.
 * Returns: a promise resolving once the input reflects extension-private storage.
 * Examples: `loadStoredProfile()` on a fresh install fills `"default"`; on a re-opened options
 * page for an already-configured profile it fills the previously saved name (e.g. `"research"`).
 */
async function loadStoredProfile(): Promise<void> {
  const profileInput = document.querySelector<HTMLInputElement>("#profile");
  if (!profileInput) return;
  const stored = await chrome.storage.local.get("browserProxyProfile");
  const profile = stored.browserProxyProfile;
  profileInput.value = typeof profile === "string" && profile.length > 0 ? profile : "default";
}

/**
 * Purpose: generate a high-entropy pairing secret visibly once for manual transfer to the local CLI.
 * Args: none; the secret is generated with the browser cryptography API.
 * Returns: nothing; keeps the secret for Save and exposes a separate readable, copyable field until
 * the user hides it or saves it.
 * Examples: user clicks Generate pairing secret before running the CLI prompt; user regenerates a value before saving if the first value was not used.
 */
function generateSecret(): void {
  const input = document.querySelector<HTMLInputElement>("#secret");
  const generated = document.querySelector<HTMLInputElement>("#generated-secret");
  const panel = document.querySelector<HTMLElement>("#generated-secret-panel");
  const status = document.querySelector<HTMLElement>("#status");
  if (!input || !generated || !panel || !status) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const secret = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  input.value = secret;
  generated.value = secret;
  panel.hidden = false;
  generated.focus();
  generated.select();
  status.textContent = "Secret generated. Use Copy pairing secret, paste it into the hidden CLI prompt, then click Save.";
}

/**
 * Purpose: copy the temporarily visible generated pairing secret after an explicit user click.
 * Args: none; reads only the read-only generated-secret field.
 * Returns: a promise resolving after clipboard copy succeeds or after a visible failure message.
 * Examples: user clicks Copy pairing secret after Generate; a browser clipboard denial displays a manual-copy instruction.
 */
async function copyGeneratedSecret(): Promise<void> {
  const generated = document.querySelector<HTMLInputElement>("#generated-secret");
  const status = document.querySelector<HTMLElement>("#status");
  if (!generated || !status || !generated.value) return;
  try {
    await navigator.clipboard.writeText(generated.value);
    status.textContent = "Pairing secret copied. Paste it into the hidden CLI prompt, then click Save.";
  } catch {
    generated.focus();
    generated.select();
    status.textContent = "Clipboard access was denied. The readable secret is selected: use Ctrl+C, then paste it into the hidden CLI prompt.";
  }
}

/**
 * Purpose: remove the one-time readable copy of a generated secret from the options page.
 * Args: none; the masked secret field remains available until Save so pairing can finish.
 * Returns: nothing.
 * Examples: user clicks Hide secret after copying; saveSecret() hides the readable field after persistence.
 */
function hideGeneratedSecret(): void {
  const generated = document.querySelector<HTMLInputElement>("#generated-secret");
  const panel = document.querySelector<HTMLElement>("#generated-secret-panel");
  if (!generated || !panel) return;
  generated.value = "";
  panel.hidden = true;
}

/**
 * Purpose: attach the options-page save handler once its DOM is ready.
 * Args: none.
 * Returns: nothing.
 * Examples: `initializeOptions()` after `DOMContentLoaded`; `initializeOptions()` in a loaded options page.
 */
function initializeOptions(): void {
  document.querySelector<HTMLButtonElement>("#save")?.addEventListener("click", () => void saveConfiguration());
  document.querySelector<HTMLButtonElement>("#generate")?.addEventListener("click", generateSecret);
  document.querySelector<HTMLButtonElement>("#copy")?.addEventListener("click", () => void copyGeneratedSecret());
  document.querySelector<HTMLButtonElement>("#hide")?.addEventListener("click", hideGeneratedSecret);
  void loadStoredProfile();
}

document.addEventListener("DOMContentLoaded", initializeOptions);
