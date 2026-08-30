import { parseServerMessage, serializeClientMessage, type ClientMessage, type RequestMessage } from "./protocol";
import {
  buildDismissOverlaysMessage,
  buildDropFileMessage,
  buildSetComboboxMessage,
  buildSetDateMessage,
  buildShowApprovalMessage,
  buildShowAskMessage,
  buildSolveCaptchaMessage,
  isApprovalResponseMessage,
  isAskResponseMessage,
  isDismissOverlaysResponseMessage,
  isDropFileResponseMessage,
  isPlainRecord,
  isSetComboboxResponseMessage,
  isSetDateResponseMessage,
  isSolveCaptchaResponseMessage,
  type BackgroundToContentMessage,
  type CaptchaAction,
} from "./messages";

const EXTENSION_ID = "kpihx-browser-proxy-ext";
// Using the daemon's configured loopback port.
const ENDPOINT = "ws://127.0.0.1:37291";
const SECRET_KEY = "bridgeSharedSecret";
const PROFILE_KEY = "browserProxyProfile";
const DEFAULT_PROFILE = "default";
const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const DEFAULT_CONTENT_REPLY_TIMEOUT_MS = 15_000;
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_ALARM_NAME = "browser-proxy-reconnect-watchdog";
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;
const PROTOCOL_VIOLATION_CLOSE_CODE = 4008;
const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

type SessionState = "connecting" | "handshaking" | "authenticated" | "closed";
type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

interface PendingApproval {
  readonly request: RequestMessage;
  readonly tabId: number;
  readonly expiresAt: number;
}

interface PendingContentReply {
  readonly tabId: number;
  readonly expiresAt: number;
  resolve(data: Record<string, unknown>): void;
  reject(error: Error): void;
}

/** One handler per daemon `kind`; every handler performs the real `chrome.*` operation and returns real data. */
type KindHandler = (payload: unknown) => Promise<Record<string, unknown>>;

let socket: WebSocket | undefined;
let sessionState: SessionState = "closed";
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
const approvals = new Map<string, PendingApproval>();
const contentReplies = new Map<string, PendingContentReply>();

/**
 * Purpose: open the sole loopback WebSocket and attach the fail-closed protocol state machine.
 * Args: none.
 * Returns: nothing; duplicate calls reuse an existing connecting or open session.
 * Examples: `connectBridge()` at worker startup; `connectBridge()` after a socket close event.
 */
function connectBridge(): void {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  sessionState = "connecting";
  socket = new WebSocket(ENDPOINT);
  socket.addEventListener("open", onSocketOpen);
  socket.addEventListener("message", onSocketMessage);
  socket.addEventListener("close", onSocketClose);
  socket.addEventListener("error", onSocketError);
}

/**
 * Purpose: return the bounded exponential reconnect delay for one failed bridge attempt.
 * Args: `attempt` is the zero-based number of prior failed reconnect attempts.
 * Returns: a delay from 500ms up to 30 seconds.
 * Examples: `reconnectDelayMs(0)` returns `500`; `reconnectDelayMs(100)` returns `30000`.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_DELAY_MS);
}

/**
 * Purpose: retry an unavailable local daemon quickly while the service worker is still warm.
 * Args: none; retry state is held only in this service-worker lifetime.
 * Returns: nothing; schedules at most one pending reconnect timer.
 * Examples: `scheduleReconnect()` after `ERR_CONNECTION_REFUSED`; repeated close events retain one timer.
 *
 * NOTE: this is a fast-path OPTIMIZATION only, not the sole reconnection mechanism. A `setTimeout`
 * scheduled inside an MV3 service worker is silently discarded if Chromium evicts the worker
 * (idle eviction can happen within ~30s) before the timer fires — the daemon being down for any
 * length of time (e.g. its own idle-TTL self-stop) was enough to permanently strand the extension
 * with no live reconnect attempt until some unrelated event happened to wake the worker again.
 * `ensureReconnectAlarm()`'s `chrome.alarms` watchdog below is the mechanism that actually
 * guarantees eventual recovery, because Chromium always redelivers alarms by waking the worker.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectBridge();
  }, delay);
}

/**
 * Purpose: arm the `chrome.alarms` watchdog that survives service-worker eviction.
 * Args: none.
 * Returns: nothing; (re)creates one idempotent periodic alarm.
 * Examples: `ensureReconnectAlarm()` at module load; `ensureReconnectAlarm()` again after a
 * cold-start wake — both leave exactly one alarm named `RECONNECT_ALARM_NAME` armed.
 */
function ensureReconnectAlarm(): void {
  chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES });
}

/**
 * Purpose: introduce this extension version to browser-proxyd after a local socket opens.
 * Args: `_event` is the native WebSocket open event and is intentionally unused.
 * Returns: nothing.
 * Examples: browser invokes it after `new WebSocket(ENDPOINT)` opens; tests can call it with `new Event("open")`.
 */
async function onSocketOpen(_event: Event): Promise<void> {
  sessionState = "handshaking";
  const token = await loadSecret();
  if (!token) {
    return closeForProtocolViolation();
  }
  const profile = await loadProfile();
  // TODO(protocol): crypto.ts's createProof() (HMAC-SHA-256 challenge-response) is intentionally NOT
  // wired in here. The current daemon (`browser_proxy`'s bridge `_handle()`) still validates the raw
  // shared secret via `secrets.compare_digest(token, self._token())` and never issues a
  // `{type:"challenge",nonce}` frame. Wiring createProof requires a coordinated cross-repo protocol
  // change (the daemon must send a nonce first) which is out of scope for this pass — keep sending the
  // raw token until that change lands on the Python side.
  send({ type: "handshake", token: token, extension_id: EXTENSION_ID, profile });
}

/**
 * Purpose: validate and process one daemon frame according to the current authentication state.
 * Args: `event` contains a WebSocket frame expected to be textual JSON.
 * Returns: a promise that resolves once the frame is processed or the socket is closed.
 * Examples: `onSocketMessage(new MessageEvent("message", { data: '{"type":"handshake","status":"accepted","protocol":1}' }))`; `onSocketMessage(new MessageEvent("message", { data: "[]" }))` closes the socket.
 */
async function onSocketMessage(event: MessageEvent): Promise<void> {
  if (typeof event.data !== "string") return closeForProtocolViolation();
  const message = parseServerMessage(event.data);
  if (!message) return closeForProtocolViolation();

  if (message.type === "handshake" && message.status === "accepted" && sessionState === "handshaking") {
    sessionState = "authenticated";
    reconnectAttempt = 0;
    return;
  }
  if (message.type === "request" && sessionState === "authenticated") {
    // If it's a request, handle it (approval overlay or real kind dispatch).
    await handleRequest(message);
    return;
  }
  closeForProtocolViolation();
}

/**
 * Purpose: route a daemon request to the pre-mutation approval overlay or to a real kind handler.
 * Args: `request` is a typed RequestMessage.
 * Returns: a promise that resolves once handled, queued for approval, or answered with an error.
 * Examples: `handleRequest({type:"request", id:"1", kind:"approval", payload:{action:"bookmark.create", payload:{}, timeout_seconds:30}})` shows the overlay; `handleRequest({type:"request", id:"2", kind:"bookmark.list", payload:{}})` returns the real bookmark tree.
 */
export async function handleRequest(request: RequestMessage): Promise<void> {
  if (request.kind === "approval") return void requestApproval(request);
  const handler = KIND_HANDLERS[request.kind];
  if (!handler) {
    send({ type: "response", id: request.id, ok: false, data: { message: `unknown kind: ${request.kind}` } });
    return;
  }
  try {
    const data = await handler(request.payload);
    send({ type: "response", id: request.id, ok: true, data });
  } catch (error) {
    send({ type: "response", id: request.id, ok: false, data: { message: error instanceof Error ? error.message : String(error) } });
  }
}

/**
 * Purpose: discard ephemeral authorization state and reject in-flight content-script round trips after a disconnected bridge session.
 * Args: `_event` is the close event and is intentionally unused.
 * Returns: nothing.
 * Examples: browser invokes it when the daemon exits; tests can call it with `new CloseEvent("close")`.
 */
function onSocketClose(event: CloseEvent): void {
  sessionState = "closed";
  socket = undefined;
  approvals.clear();
  for (const pending of contentReplies.values()) pending.reject(new Error("bridge session closed"));
  contentReplies.clear();
  if (event.code < 4000 || event.code > 4999) scheduleReconnect();
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
 * Examples: `send({ type: "response", id: "1", ok: false, data: {} })`.
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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  socket?.close(PROTOCOL_VIOLATION_CLOSE_CODE, "Protocol violation");
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
 * Purpose: read the operator-declared browser-proxy profile identity from extension-private storage.
 * Args: none.
 * Returns: the saved profile name, or `DEFAULT_PROFILE` when the operator never changed it — Chrome
 * extensions have no API to discover which `--user-data-dir` they run inside, so this identity can
 * only come from an explicit, human-declared value on the Options page (see `options.ts`).
 * Examples: `loadProfile()` returns `"research"` after Options saved it; `loadProfile()` returns
 * `"default"` in a freshly installed extension that never touched the Options page.
 */
export async function loadProfile(): Promise<string> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY];
  return typeof profile === "string" && profile.length > 0 ? profile : DEFAULT_PROFILE;
}

/**
 * Purpose: resolve the currently active, last-focused tab id used for every overlay/DOM interaction.
 * Args: none.
 * Returns: a promise resolving to the active tab id.
 * Throws: when no active tab is available.
 * Examples: `await getActiveTabId()` returns e.g. `42`; with no open window it rejects with "No active tab available".
 */
async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab available");
  return tab.id;
}

/**
 * Purpose: derive a single redacted scope label for the approval overlay from a gated daemon action request.
 * Args: `request` is the validated request; for kind "approval" the real action name lives in `request.payload.action`.
 * Returns: a one-element array naming the action, never the literal kind `"approval"` itself when an action is known.
 * Examples: `describeApprovalScopes({type:"request",id:"1",kind:"approval",payload:{action:"bookmark.create"}})` returns `["bookmark.create"]`; `describeApprovalScopes({type:"request",id:"2",kind:"approval",payload:{}})` returns `["approval"]`.
 */
function describeApprovalScopes(request: RequestMessage): string[] {
  if (isPlainRecord(request.payload) && typeof request.payload.action === "string" && request.payload.action.length > 0) {
    return [request.payload.action];
  }
  return [request.kind];
}

/**
 * Purpose: resolve the approval overlay timeout from the daemon's declared `timeout_seconds`, if any.
 * Args: `payload` is the untrusted `approval` request payload.
 * Returns: a millisecond timeout, defaulting to 60s when absent or invalid.
 * Examples: `resolveApprovalTimeoutMs({ timeout_seconds: 30 })` returns `30000`; `resolveApprovalTimeoutMs({})` returns `60000`.
 */
function resolveApprovalTimeoutMs(payload: unknown): number {
  if (isPlainRecord(payload) && typeof payload.timeout_seconds === "number" && payload.timeout_seconds > 0) {
    return payload.timeout_seconds * 1000;
  }
  return DEFAULT_APPROVAL_TIMEOUT_MS;
}

/**
 * Purpose: show a redacted approval request in the active Edge tab and bind it to that tab.
 * Args: `request` is a validated, authenticated daemon action request of kind `"approval"`.
 * Returns: a promise that resolves after prompting or immediately denies if no active tab is available.
 * Examples: `requestApproval({ type: "request", id: "1", kind: "approval", payload: { action: "window-create" } })`.
 */
async function requestApproval(request: RequestMessage): Promise<void> {
  if (approvals.has(request.id)) return closeForProtocolViolation();
  let tabId: number;
  try {
    tabId = await getActiveTabId();
  } catch {
    send({ type: "response", id: request.id, ok: false, data: { message: "No active tab for approval" } });
    return;
  }

  const pending: PendingApproval = { request, tabId, expiresAt: Date.now() + resolveApprovalTimeoutMs(request.payload) };
  approvals.set(request.id, pending);
  try {
    await chrome.tabs.sendMessage(tabId, buildShowApprovalMessage(request.id, describeApprovalScopes(request)));
  } catch {
    approvals.delete(request.id);
    send({ type: "response", id: request.id, ok: false, data: { message: "Failed to show approval UI" } });
  }
}

/**
 * Purpose: validate and settle a content-script approval decision for a pending `"approval"` request.
 * Args: `message` is a validated `ApprovalResponseMessage`; `sender` identifies its originating tab.
 * Returns: nothing; sends the daemon-facing response as a side effect.
 * Examples: `handleApprovalResponse({type:"approvalResponse",requestId:"1",approved:true}, sender)` sends `{decision:"approved"}`.
 */
function handleApprovalResponse(message: { requestId: string; approved: boolean }, sender: chrome.runtime.MessageSender): void {
  const pending = approvals.get(message.requestId);
  if (!pending || pending.tabId !== sender.tab?.id || Date.now() > pending.expiresAt) return;
  approvals.delete(message.requestId);

  if (!message.approved) {
    send({ type: "response", id: message.requestId, ok: false, data: { decision: "rejected", message: "Rejected by user" } });
    return;
  }
  send({ type: "response", id: message.requestId, ok: true, data: { decision: "approved" } });
}

/**
 * Purpose: send one command to a tab's content script and await its correlated reply, with a timeout.
 * Args: `tabId` is the target tab; `requestId` correlates the reply; `message` is the command to send; `timeoutMs` bounds the wait.
 * Returns: a promise resolving with the reply's data fields, or rejecting on timeout/delivery failure/session close.
 * Examples: `awaitContentReply(7, "r-1", buildDismissOverlaysMessage("r-1"))` resolves with `{ dismissed: 2 }`; a tab without the content script rejects with a delivery error.
 */
async function awaitContentReply(tabId: number, requestId: string, message: BackgroundToContentMessage, timeoutMs = DEFAULT_CONTENT_REPLY_TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      contentReplies.delete(requestId);
      reject(new Error("content script did not respond in time"));
    }, timeoutMs);
    contentReplies.set(requestId, {
      tabId,
      expiresAt: Date.now() + timeoutMs,
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    chrome.tabs.sendMessage(tabId, message).catch((error: unknown) => {
      clearTimeout(timer);
      contentReplies.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Purpose: recognize any content-script reply message and extract its correlation id and redacted data.
 * Args: `message` is an untrusted runtime message.
 * Returns: the reply's `requestId` and data fields, or `null` when the message matches no known reply shape.
 * Examples: `matchContentReply({type:"askResponse",requestId:"r-1",answer:"x"})` returns `{requestId:"r-1",data:{answer:"x"}}`; `matchContentReply({type:"unknown"})` returns `null`.
 */
function matchContentReply(message: unknown): { requestId: string; data: Record<string, unknown> } | null {
  if (isAskResponseMessage(message)) return { requestId: message.requestId, data: { answer: message.answer } };
  if (isDismissOverlaysResponseMessage(message)) return { requestId: message.requestId, data: { dismissed: message.dismissed } };
  if (isSolveCaptchaResponseMessage(message)) {
    return { requestId: message.requestId, data: { detected: message.detected, clicked: message.clicked, ...(message.reason !== undefined ? { reason: message.reason } : {}) } };
  }
  if (isSetDateResponseMessage(message)) return { requestId: message.requestId, data: { applied: message.applied } };
  if (isSetComboboxResponseMessage(message)) return { requestId: message.requestId, data: { matched: message.matched } };
  if (isDropFileResponseMessage(message)) return { requestId: message.requestId, data: { dropped: message.dropped } };
  return null;
}

/**
 * Purpose: settle a pending `awaitContentReply` promise once its matching, same-tab reply arrives.
 * Args: `requestId` correlates the reply; `sender` identifies its originating tab; `data` is the extracted reply payload.
 * Returns: nothing.
 * Examples: `resolveContentReply("r-1", sender, { dismissed: 2 })` resolves the pending `awaitContentReply("r-1", ...)` call.
 */
function resolveContentReply(requestId: string, sender: chrome.runtime.MessageSender, data: Record<string, unknown>): void {
  const pending = contentReplies.get(requestId);
  if (!pending || pending.tabId !== sender.tab?.id || Date.now() > pending.expiresAt) return;
  contentReplies.delete(requestId);
  pending.resolve(data);
}

/**
 * Purpose: validate a content-script message and route it to the approval flow or the generic reply resolver.
 * Args: `message` is an untrusted extension message; `sender` identifies its originating tab.
 * Returns: a promise resolving after routing or silently ignoring an unrecognized/mismatched message.
 * Examples: `onRuntimeMessage({ type: "approvalResponse", requestId: "1", approved: true }, sender)`; `onRuntimeMessage({ type: "askResponse", requestId: "1", answer: "hi" }, sender)`.
 */
async function onRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  if (isPlainRecord(message) && message.type === "bridgeSecretSaved") {
    reconnectAttempt = 0;
    connectBridge();
    return;
  }
  if (isApprovalResponseMessage(message)) return void handleApprovalResponse(message, sender);
  const reply = matchContentReply(message);
  if (reply) resolveContentReply(reply.requestId, sender, reply.data);
}

// ---------------------------------------------------------------------------
// Real kind handlers — every entry performs the actual chrome.* operation.
// ---------------------------------------------------------------------------

/**
 * Purpose: validate that a value has a given set of required string/optional fields for bookmark payloads.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` when `value` has a non-empty string `title` and `url`, and an optional string `parentId`.
 * Examples: `isBookmarkCreatePayload({title:"a",url:"https://x"})` is `true`; `isBookmarkCreatePayload({title:"a"})` is `false`.
 */
function isBookmarkCreatePayload(value: unknown): value is { title: string; url: string; parentId?: string } {
  if (!isPlainRecord(value)) return false;
  return typeof value.title === "string" && typeof value.url === "string" && (value.parentId === undefined || typeof value.parentId === "string");
}

/**
 * Purpose: flatten `chrome.bookmarks.getTree()` into a real, profile-scoped bookmark list (folders included).
 * Args: `_payload` is unused (no filtering options today).
 * Returns: `{ bookmarks: [{id,title,url,parentId}] }` for every node in the tree.
 * Examples: `handleBookmarkList({})` returns every bookmark and folder in the profile; on an empty profile it returns `{ bookmarks: [] }` only for the implicit root nodes' folders.
 */
export async function handleBookmarkList(): Promise<Record<string, unknown>> {
  const roots = await chrome.bookmarks.getTree();
  const bookmarks: Array<{ id: string; title: string; url: string | null; parentId: string | null }> = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): void => {
    for (const node of nodes) {
      bookmarks.push({ id: node.id, title: node.title, url: node.url ?? null, parentId: node.parentId ?? null });
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return { bookmarks };
}

/**
 * Purpose: create a real bookmark in the Edge profile via `chrome.bookmarks.create`.
 * Args: `payload` must be `{title, url, parentId?}`.
 * Returns: the created node as `{id,title,url,parentId}`.
 * Examples: `handleBookmarkCreate({title:"KpihX",url:"https://kpihx-labs.com"})`; `handleBookmarkCreate({title:"Docs",url:"https://x",parentId:"1"})`.
 */
export async function handleBookmarkCreate(payload: unknown): Promise<Record<string, unknown>> {
  if (!isBookmarkCreatePayload(payload)) throw new Error("bookmark.create requires {title: string, url: string, parentId?: string}");
  const node = await chrome.bookmarks.create({ title: payload.title, url: payload.url, parentId: payload.parentId });
  return { id: node.id, title: node.title, url: node.url ?? null, parentId: node.parentId ?? null };
}

/**
 * Purpose: remove a real bookmark from the Edge profile via `chrome.bookmarks.remove`.
 * Args: `payload` must be `{id: string}`.
 * Returns: `{id, removed: true}`.
 * Examples: `handleBookmarkRemove({id:"42"})`; a non-existent id rejects with the underlying `chrome.runtime.lastError` message.
 */
export async function handleBookmarkRemove(payload: unknown): Promise<Record<string, unknown>> {
  if (!isPlainRecord(payload) || typeof payload.id !== "string") throw new Error("bookmark.remove requires {id: string}");
  await chrome.bookmarks.remove(payload.id);
  return { id: payload.id, removed: true };
}

/**
 * Purpose: list every real tab group and its tabs via `chrome.tabGroups.query` + `chrome.tabs.query`.
 * Args: none.
 * Returns: `{ groups: [{id,title,color,tabs:[{id,url,title}]}] }`.
 * Examples: `handleGroupList()` on a profile with one group returns one entry with its tabs; on a profile with no groups returns `{ groups: [] }`.
 */
export async function handleGroupList(): Promise<Record<string, unknown>> {
  const groups = await chrome.tabGroups.query({});
  const result: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    result.push({
      id: group.id,
      title: group.title ?? null,
      color: group.color,
      tabs: tabs.map((tab) => ({ id: tab.id ?? null, url: tab.url ?? null, title: tab.title ?? null })),
    });
  }
  return { groups: result };
}

/**
 * Purpose: validate a tab-group color against the exact `chrome.tabGroups.ColorEnum` values.
 * Args: `value` is an untrusted field.
 * Returns: `true` when `value` is one of the nine supported color names.
 * Examples: `isTabGroupColor("blue")` is `true`; `isTabGroupColor("magenta")` is `false`.
 */
function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(value);
}

/**
 * Purpose: validate the payload required to create a new tab group.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{tab_ids: number[], title?: string, color?: ColorEnum}` with at least one tab id.
 * Examples: `isGroupCreatePayload({tab_ids:[1,2]})` is `true`; `isGroupCreatePayload({tab_ids:[]})` is `false`.
 */
function isGroupCreatePayload(value: unknown): value is { tab_ids: number[]; title?: string; color?: TabGroupColor } {
  if (!isPlainRecord(value)) return false;
  if (!Array.isArray(value.tab_ids) || value.tab_ids.length === 0 || !value.tab_ids.every((id) => typeof id === "number")) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  return value.color === undefined || isTabGroupColor(value.color);
}

/**
 * Purpose: create a real tab group via `chrome.tabs.group` and optionally set its title/color.
 * Args: `payload` must be `{tab_ids: number[], title?, color?}`.
 * Returns: `{group_id, title, color}`.
 * Examples: `handleGroupCreate({tab_ids:[12,13], title:"Research", color:"blue"})`; `handleGroupCreate({tab_ids:[12]})`.
 */
export async function handleGroupCreate(payload: unknown): Promise<Record<string, unknown>> {
  if (!isGroupCreatePayload(payload)) throw new Error("group.create requires {tab_ids: number[], title?: string, color?: ColorEnum}");
  const groupId = await chrome.tabs.group({ tabIds: payload.tab_ids });
  if (payload.title !== undefined || payload.color !== undefined) {
    await chrome.tabGroups.update(groupId, { title: payload.title, color: payload.color });
  }
  return { group_id: groupId, title: payload.title ?? null, color: payload.color ?? null };
}

/**
 * Purpose: validate the payload required to update an existing tab group.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{group_id: number, title?, color?, collapsed?}`.
 * Examples: `isGroupUpdatePayload({group_id:1,title:"x"})` is `true`; `isGroupUpdatePayload({})` is `false`.
 */
function isGroupUpdatePayload(value: unknown): value is { group_id: number; title?: string; color?: TabGroupColor; collapsed?: boolean } {
  if (!isPlainRecord(value) || typeof value.group_id !== "number") return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.color !== undefined && !isTabGroupColor(value.color)) return false;
  return value.collapsed === undefined || typeof value.collapsed === "boolean";
}

/**
 * Purpose: update a real tab group's title/color/collapsed state via `chrome.tabGroups.update`.
 * Args: `payload` must be `{group_id: number, title?, color?, collapsed?}`.
 * Returns: `{id, title, color, collapsed}` reflecting the updated group.
 * Examples: `handleGroupUpdate({group_id:1, collapsed:true})`; `handleGroupUpdate({group_id:1, title:"Renamed", color:"green"})`.
 */
export async function handleGroupUpdate(payload: unknown): Promise<Record<string, unknown>> {
  if (!isGroupUpdatePayload(payload)) throw new Error("group.update requires {group_id: number, title?, color?, collapsed?}");
  const updated = await chrome.tabGroups.update(payload.group_id, { title: payload.title, color: payload.color, collapsed: payload.collapsed });
  return { id: updated.id, title: updated.title ?? null, color: updated.color, collapsed: updated.collapsed };
}

/**
 * Purpose: validate the payload required to move a tab group to another window.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{group_id: number, window_id: number}`.
 * Examples: `isGroupMovePayload({group_id:1,window_id:2})` is `true`; `isGroupMovePayload({group_id:1})` is `false`.
 */
function isGroupMovePayload(value: unknown): value is { group_id: number; window_id: number } {
  return isPlainRecord(value) && typeof value.group_id === "number" && typeof value.window_id === "number";
}

/**
 * Purpose: move a real tab group (with all its tabs) into another window via `chrome.tabGroups.move`.
 * Args: `payload` must be `{group_id: number, window_id: number}`.
 * Returns: `{group_id, window_id}` of the moved group; `chrome.tabGroups.move` preserves the group's id, title, and color across windows (unlike `chrome.tabs.move`, which does not preserve group membership — see k-browser's documented caveat, avoided here on purpose).
 * Examples: `handleGroupMove({group_id:1, window_id:99})`; moving a group already in the target window is a no-op reposition.
 */
export async function handleGroupMove(payload: unknown): Promise<Record<string, unknown>> {
  if (!isGroupMovePayload(payload)) throw new Error("group.move requires {group_id: number, window_id: number}");
  const moved = await chrome.tabGroups.move(payload.group_id, { windowId: payload.window_id, index: -1 });
  return { group_id: moved.id, window_id: moved.windowId };
}

/**
 * Purpose: validate the payload for a free-text/password question shown to the user.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{question: string, input_type?: "text"|"password"}`.
 * Examples: `isUserAskPayload({question:"Code?"})` is `true`; `isUserAskPayload({})` is `false`.
 */
function isUserAskPayload(value: unknown): value is { question: string; input_type?: "text" | "password" } {
  if (!isPlainRecord(value) || typeof value.question !== "string") return false;
  return value.input_type === undefined || value.input_type === "text" || value.input_type === "password";
}

/**
 * Purpose: ask the user a question via a content-script overlay and return the typed answer.
 * Args: `payload` must be `{question: string, input_type?: "text"|"password"}`.
 * Returns: `{answer: string}`.
 * Examples: `handleUserAsk({question:"2FA code?"})`; `handleUserAsk({question:"Confirm password", input_type:"password"})`.
 */
export async function handleUserAsk(payload: unknown): Promise<Record<string, unknown>> {
  if (!isUserAskPayload(payload)) throw new Error("user.ask requires {question: string, input_type?: 'text'|'password'}");
  const tabId = await getActiveTabId();
  const requestId = crypto.randomUUID();
  const reply = await awaitContentReply(tabId, requestId, buildShowAskMessage(requestId, payload.question, payload.input_type ?? "text"));
  return { answer: reply.answer };
}

/**
 * Purpose: heuristically dismiss cookie/consent overlays on the active tab's page.
 * Args: `_payload` is unused.
 * Returns: `{dismissed: number}`.
 * Examples: `handleOverlayDismiss({})` on a page with a cookie banner returns `{dismissed: 1}`.
 */
export async function handleOverlayDismiss(): Promise<Record<string, unknown>> {
  const tabId = await getActiveTabId();
  const requestId = crypto.randomUUID();
  const reply = await awaitContentReply(tabId, requestId, buildDismissOverlaysMessage(requestId));
  return { dismissed: reply.dismissed };
}

const CAPTCHA_ACTIONS: readonly CaptchaAction[] = ["detect", "click_checkbox", "click_grid"];

/**
 * Purpose: validate the payload for a best-effort captcha detection/interaction request.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{action: "detect"|"click_checkbox"|"click_grid", cells?: number[]}`.
 * Examples: `isCaptchaSolvePayload({action:"detect"})` is `true`; `isCaptchaSolvePayload({action:"solve"})` is `false`.
 */
function isCaptchaSolvePayload(value: unknown): value is { action: CaptchaAction; cells?: number[] } {
  if (!isPlainRecord(value) || typeof value.action !== "string" || !(CAPTCHA_ACTIONS as readonly string[]).includes(value.action)) return false;
  return value.cells === undefined || (Array.isArray(value.cells) && value.cells.every((cell) => typeof cell === "number"));
}

/**
 * Purpose: run a best-effort, same-origin-only captcha detection/interaction on the active tab.
 * Args: `payload` must be `{action, cells?}`. Image-grid solving (`click_grid`) is honestly reported as unimplemented.
 * Returns: `{detected, clicked, reason?}`.
 * Examples: `handleCaptchaSolve({action:"detect"})`; `handleCaptchaSolve({action:"click_grid"})` returns `{detected, clicked:false, reason:"grid solving not implemented"}`.
 */
export async function handleCaptchaSolve(payload: unknown): Promise<Record<string, unknown>> {
  if (!isCaptchaSolvePayload(payload)) throw new Error("captcha.solve requires {action: 'detect'|'click_checkbox'|'click_grid', cells?: number[]}");
  const tabId = await getActiveTabId();
  const requestId = crypto.randomUUID();
  const reply = await awaitContentReply(tabId, requestId, buildSolveCaptchaMessage(requestId, payload.action, payload.cells));
  return { detected: reply.detected, clicked: reply.clicked, ...(reply.reason !== undefined ? { reason: reply.reason } : {}) };
}

/**
 * Purpose: validate the payload for setting a native date field.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{selector: string, value: string}`.
 * Examples: `isFormSetDatePayload({selector:"#d", value:"2026-01-01"})` is `true`; `isFormSetDatePayload({selector:"#d"})` is `false`.
 */
function isFormSetDatePayload(value: unknown): value is { selector: string; value: string } {
  return isPlainRecord(value) && typeof value.selector === "string" && typeof value.value === "string";
}

/**
 * Purpose: set a native `<input type="date">` field on the active tab. MUI/AntD custom pickers are NOT supported (documented gap).
 * Args: `payload` must be `{selector: string, value: string}`.
 * Returns: `{applied: boolean}`.
 * Examples: `handleFormSetDate({selector:"#birthdate", value:"1990-01-01"})`; a missing selector returns `{applied:false}`.
 */
export async function handleFormSetDate(payload: unknown): Promise<Record<string, unknown>> {
  if (!isFormSetDatePayload(payload)) throw new Error("form.set_date requires {selector: string, value: string}");
  const tabId = await getActiveTabId();
  const requestId = crypto.randomUUID();
  const reply = await awaitContentReply(tabId, requestId, buildSetDateMessage(requestId, payload.selector, payload.value));
  return { applied: reply.applied };
}

/**
 * Purpose: validate the payload for the combobox type-and-select heuristic.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{selector: string, value: string}`.
 * Examples: `isFormSetComboboxPayload({selector:"#c", value:"x"})` is `true`; `isFormSetComboboxPayload({})` is `false`.
 */
function isFormSetComboboxPayload(value: unknown): value is { selector: string; value: string } {
  return isPlainRecord(value) && typeof value.selector === "string" && typeof value.value === "string";
}

/**
 * Purpose: heuristically type into and select from a combobox/autocomplete widget on the active tab.
 * Args: `payload` must be `{selector: string, value: string}`.
 * Returns: `{matched: boolean}`.
 * Examples: `handleFormSetCombobox({selector:"#country", value:"France"})`; no matching option returns `{matched:false}`.
 */
export async function handleFormSetCombobox(payload: unknown): Promise<Record<string, unknown>> {
  if (!isFormSetComboboxPayload(payload)) throw new Error("form.set_combobox requires {selector: string, value: string}");
  const tabId = await getActiveTabId();
  const requestId = crypto.randomUUID();
  const reply = await awaitContentReply(tabId, requestId, buildSetComboboxMessage(requestId, payload.selector, payload.value));
  return { matched: reply.matched };
}

/**
 * Purpose: validate the payload for a synthetic drag-and-drop file upload.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{selector, filename, content_base64, mime_type}` (all strings).
 * Examples: `isFormDropFilePayload({selector:"#d",filename:"a.png",content_base64:"AA==",mime_type:"image/png"})` is `true`; missing fields are `false`.
 */
function isFormDropFilePayload(value: unknown): value is { selector: string; filename: string; content_base64: string; mime_type: string } {
  if (!isPlainRecord(value)) return false;
  return typeof value.selector === "string" && typeof value.filename === "string" && typeof value.content_base64 === "string" && typeof value.mime_type === "string";
}

/**
 * Purpose: synthesize a drag-and-drop file upload onto a drop target on the active tab.
 * Args: `payload` must be `{selector, filename, content_base64, mime_type}`.
 * Returns: `{dropped: boolean}`.
 * Examples: `handleFormDropFile({selector:"#dropzone", filename:"a.png", content_base64:"AA==", mime_type:"image/png"})`; a missing selector returns `{dropped:false}`.
 */
export async function handleFormDropFile(payload: unknown): Promise<Record<string, unknown>> {
  if (!isFormDropFilePayload(payload)) throw new Error("form.drop_file requires {selector, filename, content_base64, mime_type} (all strings)");
  const tabId = await getActiveTabId();
  const requestId = crypto.randomUUID();
  const reply = await awaitContentReply(tabId, requestId, buildDropFileMessage(requestId, payload.selector, payload.filename, payload.content_base64, payload.mime_type));
  return { dropped: reply.dropped };
}

/**
 * Purpose: extract a positive timeout in seconds from an untrusted `tab.capture_next` payload.
 * Args: `value` is the untrusted request payload.
 * Returns: `value.timeout_seconds` when it is a positive number, else the default `15`.
 * Examples: `extractCaptureTimeoutSeconds({timeout_seconds: 5})` returns `5`; `extractCaptureTimeoutSeconds({})` returns `15`.
 */
function extractCaptureTimeoutSeconds(value: unknown): number {
  if (isPlainRecord(value) && typeof value.timeout_seconds === "number" && value.timeout_seconds > 0) return value.timeout_seconds;
  return 15;
}

/**
 * Purpose: wait for the next tab opened anywhere in the browser, via a one-shot `chrome.tabs.onCreated` listener.
 * Args: `payload` may contain `{timeout_seconds?: number}` (default 15s).
 * Returns: `{tab_id, url}` on the first newly created tab, or `{tab_id: null, timed_out: true}` after the timeout; the listener is always removed.
 * Examples: `handleTabCaptureNext({})` resolves once any new tab opens; `handleTabCaptureNext({timeout_seconds: 1})` resolves with `{tab_id: null, timed_out: true}` if nothing opens within 1 second.
 */
export async function handleTabCaptureNext(payload: unknown): Promise<Record<string, unknown>> {
  const timeoutSeconds = extractCaptureTimeoutSeconds(payload);
  let listener: ((tab: chrome.tabs.Tab) => void) | undefined;
  try {
    return await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => resolve({ tab_id: null, timed_out: true }), timeoutSeconds * 1000);
      listener = (tab: chrome.tabs.Tab): void => {
        clearTimeout(timer);
        resolve({ tab_id: tab.id ?? null, url: tab.url ?? null });
      };
      chrome.tabs.onCreated.addListener(listener);
    });
  } finally {
    if (listener) chrome.tabs.onCreated.removeListener(listener);
  }
}

export const KIND_HANDLERS: Record<string, KindHandler> = {
  "bookmark.list": () => handleBookmarkList(),
  "bookmark.create": (payload) => handleBookmarkCreate(payload),
  "bookmark.remove": (payload) => handleBookmarkRemove(payload),
  "group.list": () => handleGroupList(),
  "group.create": (payload) => handleGroupCreate(payload),
  "group.update": (payload) => handleGroupUpdate(payload),
  "group.move": (payload) => handleGroupMove(payload),
  "user.ask": (payload) => handleUserAsk(payload),
  "overlay.dismiss": () => handleOverlayDismiss(),
  "captcha.solve": (payload) => handleCaptchaSolve(payload),
  "form.set_date": (payload) => handleFormSetDate(payload),
  "form.set_combobox": (payload) => handleFormSetCombobox(payload),
  "form.drop_file": (payload) => handleFormDropFile(payload),
  "tab.capture_next": (payload) => handleTabCaptureNext(payload),
};

chrome.runtime.onMessage.addListener(onRuntimeMessage);
// Registered synchronously at module load — the same pattern as onMessage above — so Chromium
// keeps delivering this alarm (and re-waking this worker to do so) across every eviction/restart.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME) connectBridge();
});
ensureReconnectAlarm();
connectBridge();
