import { createProof } from "./crypto";
import { PROTOCOL_VERSION, parseServerMessage, serializeClientMessage, type ClientMessage, type SnapshotRequestMessage } from "./protocol";
import { collectSnapshot } from "./snapshot";

const ENDPOINT = "ws://127.0.0.1:8765/v1/extension";
const EXTENSION_VERSION = "0.1.0";
const SECRET_KEY = "bridgeSharedSecret";

type SessionState = "connecting" | "challenged" | "authenticated" | "closed";

interface PendingApproval {
  readonly request: SnapshotRequestMessage;
  readonly tabId: number;
  readonly expiresAt: number;
}

let socket: WebSocket | undefined;
let sessionState: SessionState = "closed";
const approvals = new Map<string, PendingApproval>();

/**
 * Purpose: open the sole loopback WebSocket and attach the fail-closed protocol state machine.
 * Args: none.
 * Returns: nothing; duplicate calls reuse an existing connecting or open session.
 * Examples: `connectBridge()` at worker startup; `connectBridge()` after a socket close event.
 */
function connectBridge(): void {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  sessionState = "connecting";
  socket = new WebSocket(ENDPOINT);
  socket.addEventListener("open", onSocketOpen);
  socket.addEventListener("message", onSocketMessage);
  socket.addEventListener("close", onSocketClose);
  socket.addEventListener("error", onSocketError);
}

/**
 * Purpose: introduce this extension version to browser-proxyd after a local socket opens.
 * Args: `_event` is the native WebSocket open event and is intentionally unused.
 * Returns: nothing.
 * Examples: browser invokes it after `new WebSocket(ENDPOINT)` opens; tests can call it with `new Event("open")`.
 */
function onSocketOpen(_event: Event): void {
  send({ type: "hello", protocolVersion: PROTOCOL_VERSION, extensionVersion: EXTENSION_VERSION });
}

/**
 * Purpose: validate and process one daemon frame according to the current authentication state.
 * Args: `event` contains a WebSocket frame expected to be textual JSON.
 * Returns: a promise that resolves once the frame is processed or the socket is closed.
 * Examples: `onSocketMessage(new MessageEvent("message", { data: '{"type":"authenticated"}' }))`; `onSocketMessage(new MessageEvent("message", { data: "[]" }))` closes the socket.
 */
async function onSocketMessage(event: MessageEvent): Promise<void> {
  if (typeof event.data !== "string") return closeForProtocolViolation();
  const message = parseServerMessage(event.data);
  if (!message) return closeForProtocolViolation();

  if (message.type === "challenge" && sessionState === "connecting") {
    sessionState = "challenged";
    const secret = await loadSecret();
    if (!secret) return closeForProtocolViolation();
    send({ type: "authenticate", nonce: message.nonce, proof: await createProof(secret, message.nonce) });
    return;
  }
  if (message.type === "authenticated" && sessionState === "challenged") {
    sessionState = "authenticated";
    return;
  }
  if (message.type === "requestSnapshot" && sessionState === "authenticated") {
    await requestApproval(message);
    return;
  }
  closeForProtocolViolation();
}

/**
 * Purpose: discard ephemeral authorization state after a disconnected bridge session.
 * Args: `_event` is the close event and is intentionally unused.
 * Returns: nothing.
 * Examples: browser invokes it when the daemon exits; tests can call it with `new CloseEvent("close")`.
 */
function onSocketClose(_event: CloseEvent): void {
  sessionState = "closed";
  socket = undefined;
  approvals.clear();
}

/**
 * Purpose: avoid exposing transport details while letting the close handler reset state.
 * Args: `_event` is the native WebSocket error event and is intentionally unused.
 * Returns: nothing.
 * Examples: browser invokes it for a refused loopback connection; tests can call it with `new Event("error")`.
 */
function onSocketError(_event: Event): void {
  // Deliberately silent: errors can contain endpoint or implementation details.
}

/**
 * Purpose: send a typed message only through an authenticated/open protocol transport.
 * Args: `message` is a client message already constructed from trusted extension state.
 * Returns: `true` when the frame was queued; otherwise `false` without side effects.
 * Examples: `send({ type: "requestDenied", requestId: "r-1" })`; `send({ type: "hello", protocolVersion: 1, extensionVersion: "0.1.0" })`.
 */
function send(message: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(serializeClientMessage(message));
  return true;
}

/**
 * Purpose: terminate a suspicious session without returning error details to an untrusted peer.
 * Args: none.
 * Returns: nothing.
 * Examples: `closeForProtocolViolation()` after malformed JSON; `closeForProtocolViolation()` after an invalid state transition.
 */
function closeForProtocolViolation(): void {
  approvals.clear();
  sessionState = "closed";
  socket?.close(1008, "Protocol violation");
}

/**
 * Purpose: read the user-provisioned secret exclusively from extension-private storage.
 * Args: none.
 * Returns: a non-empty secret or `null` when setup is incomplete.
 * Examples: `loadSecret()` after saving options; `loadSecret()` in a newly installed extension returns `null`.
 */
async function loadSecret(): Promise<string | null> {
  const stored = await chrome.storage.local.get(SECRET_KEY);
  const secret = stored[SECRET_KEY];
  return typeof secret === "string" && secret.length >= 16 ? secret : null;
}

/**
 * Purpose: show a redacted approval request in the active Edge tab and bind it to that tab.
 * Args: `request` is a validated, authenticated daemon snapshot request.
 * Returns: a promise that resolves after prompting or immediately denies if no active tab is available.
 * Examples: `requestApproval({ type: "requestSnapshot", requestId: "r-1", scopes: ["tabs"] })`; `requestApproval({ type: "requestSnapshot", requestId: "r-2", scopes: ["bookmarks", "workspaceHints"] })`.
 */
async function requestApproval(request: SnapshotRequestMessage): Promise<void> {
  if (approvals.has(request.requestId)) return closeForProtocolViolation();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return void send({ type: "requestDenied", requestId: request.requestId });
  const pending: PendingApproval = { request, tabId: tab.id, expiresAt: Date.now() + 60_000 };
  approvals.set(request.requestId, pending);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "showApproval", requestId: request.requestId, scopes: request.scopes });
  } catch {
    approvals.delete(request.requestId);
    send({ type: "requestDenied", requestId: request.requestId });
  }
}

/**
 * Purpose: validate a content-script approval response and execute only a single approved read.
 * Args: `message` is an untrusted extension message; `sender` identifies its originating tab.
 * Returns: a promise resolving after denial, collection, or fail-closed rejection.
 * Examples: `onRuntimeMessage({ type: "approvalResponse", requestId: "r-1", approved: true }, sender)`; `onRuntimeMessage({ type: "approvalResponse", requestId: "r-1", approved: false }, sender)`.
 */
async function onRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!isApprovalResponse(message)) return;
  const pending = approvals.get(message.requestId);
  if (!pending || pending.tabId !== sender.tab?.id || Date.now() > pending.expiresAt) return;
  approvals.delete(message.requestId);
  if (!message.approved) return void send({ type: "requestDenied", requestId: message.requestId });
  try {
    const snapshot = await collectSnapshot(pending.request.scopes);
    send({ type: "snapshot", requestId: message.requestId, snapshot });
  } catch {
    send({ type: "requestDenied", requestId: message.requestId });
  }
}

/**
 * Purpose: recognize the minimal, redacted response shape permitted from a content script.
 * Args: `value` is an untrusted runtime-message payload.
 * Returns: `true` only for a syntactically valid approval response.
 * Examples: `isApprovalResponse({ type: "approvalResponse", requestId: "r-1", approved: true })` is `true`; `isApprovalResponse({ type: "approvalResponse", approved: true })` is `false`.
 */
function isApprovalResponse(value: unknown): value is { type: "approvalResponse"; requestId: string; approved: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.type === "approvalResponse" && typeof record.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(record.requestId) && typeof record.approved === "boolean";
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);
connectBridge();
