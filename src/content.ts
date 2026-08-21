/** A redacted request payload accepted from the extension background worker. */
interface ApprovalPrompt {
  readonly type: "showApproval";
  readonly requestId: string;
  readonly scopes: readonly string[];
}

/**
 * Purpose: receive a redacted approval prompt and render it in a closed shadow root.
 * Args: `message` is the extension runtime payload; `_sender` and `_response` are unused runtime callback arguments.
 * Returns: `true` when a prompt was rendered, otherwise `false`.
 * Examples: `onBackgroundMessage({ type: "showApproval", requestId: "r-1", scopes: ["tabs"] })`; `onBackgroundMessage({ type: "unknown" })` returns `false`.
 */
function onBackgroundMessage(message: unknown, _sender: chrome.runtime.MessageSender, _response: (response?: unknown) => void): boolean {
  if (!isApprovalPrompt(message)) return false;
  showApprovalOverlay(message);
  return true;
}

/**
 * Purpose: validate the redacted message shape permitted to create an overlay.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` when the message includes only a bounded request ID and scopes.
 * Examples: `isApprovalPrompt({ type: "showApproval", requestId: "r-1", scopes: ["tabs"] })` is `true`; `isApprovalPrompt({ type: "showApproval", requestId: "", scopes: [] })` is `false`.
 */
function isApprovalPrompt(value: unknown): value is ApprovalPrompt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "showApproval" && typeof record.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(record.requestId) && Array.isArray(record.scopes) && record.scopes.length > 0 && record.scopes.every((scope) => typeof scope === "string");
}

/**
 * Purpose: show a page-isolated, non-secret confirmation interface for one snapshot request.
 * Args: `prompt` contains the request ID and requested categories, never a secret or snapshot.
 * Returns: nothing; one user click sends an approval response and removes the overlay.
 * Examples: `showApprovalOverlay({ type: "showApproval", requestId: "r-1", scopes: ["bookmarks"] })`; `showApprovalOverlay({ type: "showApproval", requestId: "r-2", scopes: ["tabs", "workspaceHints"] })`.
 */
function showApprovalOverlay(prompt: ApprovalPrompt): void {
  document.getElementById("browser-proxy-approval")?.remove();
  const host = document.createElement("div");
  host.id = "browser-proxy-approval";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>:host{all:initial}section{position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:18px;background:#111827;color:#f9fafb;border:1px solid #60a5fa;border-radius:10px;font:14px system-ui;box-shadow:0 8px 28px #0008}button{margin:10px 8px 0 0;padding:7px 12px;border-radius:6px;border:0;font:inherit;cursor:pointer}#approve{background:#2563eb;color:white}#deny{background:#374151;color:white}</style><section role="dialog" aria-modal="true" aria-label="Browser Proxy approval"><strong>Approve browser snapshot?</strong><p>The local browser-proxyd requests: ${prompt.scopes.map(escapeHtml).join(", ")}.</p><p>No page content, credentials, or secret will be shared.</p><button id="approve" type="button">Approve once</button><button id="deny" type="button">Deny</button></section>`;
  root.getElementById("approve")?.addEventListener("click", () => respond(prompt.requestId, true, host));
  root.getElementById("deny")?.addEventListener("click", () => respond(prompt.requestId, false, host));
  document.documentElement.append(host);
}

/**
 * Purpose: send a single user decision to the background worker and remove the page overlay.
 * Args: `requestId` identifies the prompt; `approved` is the click decision; `host` is the overlay root.
 * Returns: nothing.
 * Examples: `respond("r-1", true, host)` approves; `respond("r-1", false, host)` denies.
 */
function respond(requestId: string, approved: boolean, host: HTMLElement): void {
  host.remove();
  void chrome.runtime.sendMessage({ type: "approvalResponse", requestId, approved });
}

/**
 * Purpose: prevent scope labels from being interpreted as HTML in the overlay.
 * Args: `value` is a scope string originating from a validated protocol message.
 * Returns: an HTML-escaped display string.
 * Examples: `escapeHtml("tabs")` returns `"tabs"`; `escapeHtml("<x>")` returns `"&lt;x&gt;"`.
 */
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

chrome.runtime.onMessage.addListener(onBackgroundMessage);
