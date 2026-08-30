import {
  buildAskResponseMessage,
  buildApprovalResponseMessage,
  buildDismissOverlaysResponseMessage,
  buildDropFileResponseMessage,
  buildSetComboboxResponseMessage,
  buildSetDateResponseMessage,
  buildSolveCaptchaResponseMessage,
  isDismissOverlaysMessage,
  isDropFileMessage,
  isSetComboboxMessage,
  isSetDateMessage,
  isShowApprovalMessage,
  isShowAskMessage,
  isSolveCaptchaMessage,
  type DropFileMessage,
  type SetComboboxMessage,
  type SetDateMessage,
  type ShowApprovalMessage,
  type ShowAskMessage,
  type SolveCaptchaMessage,
} from "./messages";

/**
 * Purpose: receive every background -> content command and dispatch it to its dedicated handler.
 * Args: `message` is the untrusted extension runtime payload; `_sender` and `_response` are unused runtime callback arguments.
 * Returns: `true` when a known command was handled, otherwise `false`.
 * Examples: `onBackgroundMessage({ type: "showApproval", requestId: "r-1", scopes: ["tabs"] }, sender, respond)` returns `true`; `onBackgroundMessage({ type: "unknown" }, sender, respond)` returns `false`.
 */
function onBackgroundMessage(message: unknown, _sender: chrome.runtime.MessageSender, _response: (response?: unknown) => void): boolean {
  if (isShowApprovalMessage(message)) {
    showApprovalOverlay(message);
    return true;
  }
  if (isShowAskMessage(message)) {
    showAskOverlay(message);
    return true;
  }
  if (isDismissOverlaysMessage(message)) {
    const dismissed = dismissOverlays();
    void chrome.runtime.sendMessage(buildDismissOverlaysResponseMessage(message.requestId, dismissed));
    return true;
  }
  if (isSolveCaptchaMessage(message)) {
    const outcome = solveCaptcha(message);
    void chrome.runtime.sendMessage(
      buildSolveCaptchaResponseMessage(message.requestId, outcome.detected, outcome.clicked, outcome.reason, outcome.rect, outcome.url)
    );
    return true;
  }
  if (isSetDateMessage(message)) {
    const applied = setDateField(message);
    void chrome.runtime.sendMessage(buildSetDateResponseMessage(message.requestId, applied));
    return true;
  }
  if (isSetComboboxMessage(message)) {
    const matched = setComboboxField(message);
    void chrome.runtime.sendMessage(buildSetComboboxResponseMessage(message.requestId, matched));
    return true;
  }
  if (isDropFileMessage(message)) {
    const dropped = dropFileOnElement(message);
    void chrome.runtime.sendMessage(buildDropFileResponseMessage(message.requestId, dropped));
    return true;
  }
  return false;
}

/**
 * Purpose: show a page-isolated, non-secret confirmation interface for one gated daemon action.
 * Args: `prompt` contains the request ID and redacted action-category scopes, never a secret or raw payload.
 * Returns: nothing; one user click sends an approval response and removes the overlay.
 * Examples: `showApprovalOverlay({ type: "showApproval", requestId: "r-1", scopes: ["bookmark.create"] })`; `showApprovalOverlay({ type: "showApproval", requestId: "r-2", scopes: ["group.move"] })`.
 */
function showApprovalOverlay(prompt: ShowApprovalMessage): void {
  removeOverlay("browser-proxy-approval");
  const host = document.createElement("div");
  host.id = "browser-proxy-approval";
  const root = host.attachShadow({ mode: "closed" });
  const detailsHtml = prompt.details.length > 0 ? `<ul class="details">${prompt.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : "";
  root.innerHTML = `<style>${OVERLAY_STYLE}</style><section role="dialog" aria-modal="true" aria-label="Browser Proxy approval"><strong>Approve browser action?</strong><p>The local browser-proxyd requests: ${prompt.scopes.map(escapeHtml).join(", ")}.</p>${detailsHtml}<p>No page content, credentials, or secret will be shared.</p><button id="approve" type="button">Approve once</button><button id="deny" type="button">Deny</button></section>`;
  root.getElementById("approve")?.addEventListener("click", () => respondApproval(prompt.requestId, true, host));
  root.getElementById("deny")?.addEventListener("click", () => respondApproval(prompt.requestId, false, host));
  document.documentElement.append(host);
}

/**
 * Purpose: send a single user approval decision to the background worker and remove the page overlay.
 * Args: `requestId` identifies the prompt; `approved` is the click decision; `host` is the overlay root.
 * Returns: nothing.
 * Examples: `respondApproval("r-1", true, host)` approves; `respondApproval("r-1", false, host)` denies.
 */
function respondApproval(requestId: string, approved: boolean, host: HTMLElement): void {
  host.remove();
  void chrome.runtime.sendMessage(buildApprovalResponseMessage(requestId, approved));
}

/**
 * Purpose: show a page-isolated text/password input overlay for one daemon-issued question.
 * Args: `prompt` contains the request ID, the question text, and the desired input masking.
 * Returns: nothing; submitting sends the typed answer and removes the overlay.
 * Examples: `showAskOverlay({ type: "showAsk", requestId: "r-1", question: "2FA code?", inputType: "text" })`; `showAskOverlay({ type: "showAsk", requestId: "r-2", question: "Confirm password", inputType: "password" })`.
 */
function showAskOverlay(prompt: ShowAskMessage): void {
  removeOverlay("browser-proxy-ask");
  const host = document.createElement("div");
  host.id = "browser-proxy-ask";
  const root = host.attachShadow({ mode: "closed" });
  const inputType = prompt.inputType === "password" ? "password" : "text";
  root.innerHTML = `<style>${OVERLAY_STYLE}input{width:100%;box-sizing:border-box;margin-top:10px;padding:6px 8px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#f9fafb;font:inherit}</style><section role="dialog" aria-modal="true" aria-label="Browser Proxy question"><strong>${escapeHtml(prompt.question)}</strong><input id="answer" type="${inputType}" /><button id="submit" type="button">Submit</button></section>`;
  const input = root.getElementById("answer") as HTMLInputElement | null;
  root.getElementById("submit")?.addEventListener("click", () => {
    const answer = input?.value ?? "";
    host.remove();
    void chrome.runtime.sendMessage(buildAskResponseMessage(prompt.requestId, answer));
  });
  document.documentElement.append(host);
}

/**
 * Purpose: remove a previously rendered overlay host by id, if present.
 * Args: `id` is the overlay host element id.
 * Returns: nothing.
 * Examples: `removeOverlay("browser-proxy-approval")`; `removeOverlay("browser-proxy-ask")`.
 */
function removeOverlay(id: string): void {
  document.getElementById(id)?.remove();
}

/**
 * Purpose: heuristically dismiss cookie/consent banners and other large fixed overlays on the page.
 * Args: none; scans the live document.
 * Returns: the number of overlay elements accepted or removed.
 * Examples: `dismissOverlays()` on a page with a cookie banner returns `1`; `dismissOverlays()` on a clean page returns `0`.
 */
function dismissOverlays(): number {
  let dismissed = 0;
  const bySelector = document.querySelectorAll<HTMLElement>(
    '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i]'
  );
  for (const element of bySelector) {
    if (tryDismissElement(element)) dismissed++;
  }
  // Best-effort second pass: large fixed-position, high z-index overlays not caught by name heuristics.
  for (const element of document.querySelectorAll<HTMLElement>("body *")) {
    if (!element.isConnected) continue;
    const style = getComputedStyle(element);
    if (style.position !== "fixed") continue;
    const zIndex = Number.parseInt(style.zIndex, 10);
    if (Number.isNaN(zIndex) || zIndex < 1000) continue;
    const rect = element.getBoundingClientRect();
    const viewportArea = window.innerWidth * window.innerHeight;
    if (viewportArea <= 0 || (rect.width * rect.height) / viewportArea < 0.3) continue;
    if (tryDismissElement(element)) dismissed++;
  }
  return dismissed;
}

/**
 * Purpose: dismiss one overlay element by clicking an accept-like control, else removing it outright.
 * Args: `element` is a candidate overlay/banner root still attached to the document.
 * Returns: `true` when a click or removal was performed.
 * Notes: the accept-text regex uses word boundaries around the short, substring-prone terms
 *   (`agree`, `got it`, `ok`) so `ok` never matches as a false-positive substring of an unrelated
 *   word (live-verified real-world bug, KπX, GRAVÉ: on a real multi-layer consent flow the second
 *   pass matched a "JEUX SUDOKU" navigation link — "sudoku" literally contains "ok" as a bare
 *   substring — and clicked it instead of the real "Accepter" button, navigating away from the
 *   page entirely). `accept` deliberately keeps only a LEADING boundary (`\baccept`, no trailing
 *   `\b`) so it still matches localized suffixed forms (`Accepter`, `Acceptez`, `j'accepte`).
 *   When several elements match, a real `<button>` is preferred over `<a>`/`[role=button]`
 *   (navigation links are almost always anchors), then the shortest matching text (the real
 *   control is short; a false-positive match buried inside a long nav link's text is not).
 * Examples: `tryDismissElement(cookieBannerWithAcceptButton)` clicks "Accept" and returns `true`; `tryDismissElement(bannerWithoutButtons)` removes it and returns `true`; a banner containing both a "JEUX SUDOKU" link and a real "Accepter" button clicks the button, never the link.
 */
function tryDismissElement(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const ACCEPT_LIKE = /\baccept|\bagree\b|\bgot it\b|\bok\b/iu;
  const candidates = Array.from(element.querySelectorAll<HTMLElement>("button, a, [role='button']")).filter((candidate) => ACCEPT_LIKE.test(candidate.textContent ?? ""));
  const winner = candidates.sort((a, b) => {
    const aIsButton = a.tagName === "BUTTON" ? 0 : 1;
    const bIsButton = b.tagName === "BUTTON" ? 0 : 1;
    if (aIsButton !== bIsButton) return aIsButton - bIsButton;
    return (a.textContent ?? "").trim().length - (b.textContent ?? "").trim().length;
  })[0];
  if (winner) {
    winner.click();
    return true;
  }
  element.remove();
  return true;
}

/**
 * Purpose: detect a CAPTCHA iframe and, for `click_checkbox`, report its rect so the daemon can
 * escalate to a REAL compositor-level CDP click (checkbox reCAPTCHA/hCaptcha only).
 * Args: `message` selects `detect`, `click_checkbox`, or `click_grid`.
 * Returns: whether a captcha iframe was detected; for `click_checkbox` when detected, the
 *   iframe's own viewport-relative bounding `rect` and this tab's `url` instead of an actual click
 *   (KπX, GRAVÉ — live-verified against the official Google reCAPTCHA demo: a content-script
 *   `MouseEvent` dispatched on the iframe's OUTER element never reaches the checkbox rendered
 *   inside it, because Google's reCAPTCHA anchor iframe is ALWAYS served cross-origin from
 *   `www.google.com` in every real deployment — confirmed live via the iframe's own `src`. Reading
 *   a cross-origin iframe ELEMENT's geometry from the parent document is legal; only its rendered
 *   CONTENT is blocked. The daemon reaches the real checkbox with `Input.dispatchMouseEvent` at
 *   these coordinates — the same CDP primitive `page-click-coordinates` already uses for exactly
 *   this "no selector can address it" case).
 * Examples: `solveCaptcha({ type:"solveCaptcha", requestId:"r-1", action:"detect" })` on a page with reCAPTCHA returns `{ detected: true, clicked: false }`; `solveCaptcha({ type:"solveCaptcha", requestId:"r-2", action:"click_grid" })` returns `{ detected, clicked: false, reason: "grid solving not implemented" }`; `solveCaptcha({ type:"solveCaptcha", requestId:"r-3", action:"click_checkbox" })` on a real reCAPTCHA returns `{ detected: true, clicked: false, reason: "reported iframe rect for CDP-level coordinate click", rect: {...}, url: location.href }`.
 */
function solveCaptcha(message: SolveCaptchaMessage): { detected: boolean; clicked: boolean; reason?: string; rect?: { left: number; top: number; width: number; height: number }; url?: string } {
  const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
  const detected = iframe !== null;
  if (message.action === "detect") return { detected, clicked: false };
  if (message.action === "click_grid") return { detected, clicked: false, reason: "grid solving not implemented" };
  // click_checkbox
  if (!iframe) return { detected, clicked: false, reason: "no captcha iframe found" };
  const rect = iframe.getBoundingClientRect();
  return {
    detected,
    clicked: false,
    reason: "reported iframe rect for CDP-level coordinate click (cross-origin content-script click never reaches the real checkbox)",
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    url: window.location.href,
  };
}

/**
 * Purpose: set a native `<input type="date">` field and fire the events frameworks listen for.
 * Args: `message` names the CSS `selector` and the ISO date `value` to apply.
 * Returns: `true` when a matching `<input>` element was found and set.
 * Examples: `setDateField({ type:"setDate", requestId:"r-1", selector:"#birthdate", value:"1990-01-01" })` returns `true` if `#birthdate` exists; returns `false` for a missing selector. MUI/AntD custom date pickers are NOT supported (documented gap, not a native `<input>`).
 */
function setDateField(message: SetDateMessage): boolean {
  const element = document.querySelector(message.selector);
  if (!(element instanceof HTMLInputElement)) return false;
  element.value = message.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Purpose: heuristically type into and select from a combobox/autocomplete widget.
 * Args: `message` names the CSS `selector` for the widget and the `value` to type and match.
 * Returns: `true` when a visible option matching `value` was found and clicked.
 * Examples: `setComboboxField({ type:"setCombobox", requestId:"r-1", selector:"#country", value:"France" })` returns `true` when an option "France" appears and is clicked; returns `false` when no option matches (best-effort, no MUI/AntD-specific wiring).
 */
function setComboboxField(message: SetComboboxMessage): boolean {
  const element = document.querySelector<HTMLElement>(message.selector);
  if (!element) return false;
  element.click();
  const textInput = element instanceof HTMLInputElement ? element : element.querySelector<HTMLInputElement>("input");
  if (textInput) {
    textInput.focus();
    textInput.value = message.value;
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const target = message.value.trim().toLowerCase();
  const options = document.querySelectorAll<HTMLElement>('[role="option"], li, [role="listitem"]');
  const match = Array.from(options).find((option) => (option.textContent ?? "").trim().toLowerCase() === target);
  if (!match) return false;
  match.click();
  return true;
}

/**
 * Purpose: synthesize a drag-and-drop file upload onto a drop target using a decoded in-memory `File`.
 * Args: `message` names the `selector`, `filename`, base64 `contentBase64`, and `mimeType` of the file to drop.
 * Returns: `true` when the drop target was found and the synthetic drag/drop event sequence was dispatched.
 * Examples: `dropFileOnElement({ type:"dropFile", requestId:"r-1", selector:"#dropzone", filename:"a.png", contentBase64:"AA==", mimeType:"image/png" })` returns `true`; a missing selector returns `false`.
 */
function dropFileOnElement(message: DropFileMessage): boolean {
  const element = document.querySelector<HTMLElement>(message.selector);
  if (!element) return false;
  const binary = atob(message.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const file = new File([bytes], message.filename, { type: message.mimeType });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  for (const type of ["dragenter", "dragover", "drop"] as const) {
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
  }
  return true;
}

/**
 * Purpose: prevent user-supplied text from being interpreted as HTML in any overlay.
 * Args: `value` is a string originating from a validated protocol message.
 * Returns: an HTML-escaped display string.
 * Examples: `escapeHtml("tabs")` returns `"tabs"`; `escapeHtml("<x>")` returns `"&lt;x&gt;"`.
 */
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

const OVERLAY_STYLE =
  ":host{all:initial}section{position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:18px;background:#111827;color:#f9fafb;border:1px solid #60a5fa;border-radius:10px;font:14px system-ui;box-shadow:0 8px 28px #0008}button{margin:10px 8px 0 0;padding:7px 12px;border-radius:6px;border:0;font:inherit;cursor:pointer}#approve,#submit{background:#2563eb;color:white}#deny{background:#374151;color:white}ul.details{margin:8px 0;padding:8px 10px;background:#1f2937;border-radius:6px;list-style:none;font:12px/1.5 ui-monospace,monospace;max-height:160px;overflow:auto}ul.details li{word-break:break-all}";

chrome.runtime.onMessage.addListener(onBackgroundMessage);
