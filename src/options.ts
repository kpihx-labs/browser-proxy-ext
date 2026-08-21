/**
 * Purpose: persist a locally provisioned bridge secret without displaying it after save.
 * Args: none; values are read from the options page controls.
 * Returns: a promise resolving after validation and extension-storage write.
 * Examples: user enters a 16-character secret and clicks Save; user enters a short secret and receives a validation message.
 */
async function saveSecret(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#secret");
  const status = document.querySelector<HTMLElement>("#status");
  if (!input || !status) return;
  if (input.value.length < 16) {
    status.textContent = "The shared secret must contain at least 16 characters.";
    return;
  }
  await chrome.storage.local.set({ bridgeSharedSecret: input.value });
  input.value = "";
  status.textContent = "Shared secret saved locally.";
}

/**
 * Purpose: attach the options-page save handler once its DOM is ready.
 * Args: none.
 * Returns: nothing.
 * Examples: `initializeOptions()` after `DOMContentLoaded`; `initializeOptions()` in a loaded options page.
 */
function initializeOptions(): void {
  document.querySelector<HTMLButtonElement>("#save")?.addEventListener("click", () => void saveSecret());
}

document.addEventListener("DOMContentLoaded", initializeOptions);
