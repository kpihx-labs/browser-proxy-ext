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
const TEMPORARY_APPROVAL_TAB_URL = "https://example.com/";
const APPROVAL_EXPIRY_ALARM_PREFIX = "browser-proxy-approval-expiry:";
const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

type SessionState = "connecting" | "handshaking" | "authenticated" | "closed";
type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

interface PendingApproval {
  readonly request: RequestMessage;
  readonly tabId: number;
  readonly expiresAt: number;
  readonly temporaryTabId?: number;
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
 * Purpose: report whether a tab URL can actually host the injected overlay content script.
 * Args: `url` is a tab's current URL, possibly `undefined`.
 * Returns: `true` only for `http://`/`https://` pages — never `edge://`, `chrome-extension://`
 * (this extension's OWN Options/other pages included), or any other internal scheme, none of
 * which ever receive the content script (manifest `content_scripts.matches` never targets them).
 * Examples: `isApprovableUrl('https://example.com')` is `true`;
 * `isApprovableUrl('chrome-extension://.../options.html')` is `false`;
 * `isApprovableUrl('edge://settings/profiles')` is `false`.
 */
function isApprovableUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

/**
 * Purpose: resolve a real, content-script-capable tab id for every overlay/DOM interaction.
 * Args: none.
 * Returns: the active tab's id if it can host the overlay; otherwise the first `http(s)` tab found
 * in the last-focused window (root-caused bug: the active tab is routinely this EXTENSION'S OWN
 * Options page, or an `edge://` settings page — `chrome.tabs.sendMessage` to either silently fails
 * because no content script is ever injected there, previously misreported as an outright approval
 * rejection with zero human interaction, confirmed live: 4 rapid "APPROVAL_REJECTED" results with
 * the Options page active the whole time).
 * Throws: when no `http(s)` tab exists anywhere in the last-focused window.
 * Examples: `await getActiveTabId()` returns the active tab's id when it is a real web page; if the
 * active tab is `chrome-extension://.../options.html`, it instead returns another open `https://`
 * tab's id in that same window; with no open window or no `http(s)` tab at all, it rejects with
 * "No active tab available".
 */
async function getActiveTabId(): Promise<number> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id && isApprovableUrl(activeTab.url)) return activeTab.id;
  const [fallbackTab] = await chrome.tabs.query({
    url: ["http://*/*", "https://*/*"],
    lastFocusedWindow: true,
  });
  if (!fallbackTab?.id) throw new Error("No active tab available");
  return fallbackTab.id;
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

const SENSITIVE_APPROVAL_PAYLOAD_FIELDS = new Set(["value", "content_base64", "password"]);

/**
 * Purpose: build the real, human-readable, non-secret proposal details shown in the overlay.
 * Args: `request` is the validated `"approval"` request; the real gated action's own payload lives
 * at `request.payload.payload` (redacted request envelope: `{action, payload, timeout_seconds}`).
 * Returns: one `"field: value"` line per field of the real payload — 100% transparency of WHAT is
 * being proposed (tab ids, titles, colors, URLs, ...), except genuinely secret-shaped fields
 * (`value` on `cookie-set`, `content_base64` on `browser-drop-file`, any `password`), which are
 * shown as `<redacted>` instead of their real content — never silently omitted, so the overlay
 * still names every field that exists, just without leaking its content.
 * Examples: `describeApprovalDetails({...,payload:{action:"group-create",payload:{tab_ids:[1,2],title:"Research"}}})`
 * returns `["tab_ids: [1,2]", "title: \"Research\"", "", "tab 1: ...", "tab 2: ..."]` (illustrated —
 * see `describeNativeReferences`); `describeApprovalDetails({...,payload:{action:"cookie-set",
 * payload:{name:"session",value:"abc"}}})` returns `["name: \"session\"", "value: <redacted>"]`.
 *
 * ANY payload field whose value is a non-empty array of PLAIN STRINGS (never numbers/objects) is
 * rendered ONE LINE PER ELEMENT instead of a single `JSON.stringify`-flattened blob — covers both
 * the daemon-computed `"context"` field (CDP `target_id`/`target_ids` resolved server-side, see
 * `windows_preview_for_targets`/`format_window_preview`) AND the extension-computed illustrations
 * appended below by `describeNativeReferences` — one universal rule, not a `window-close`-only
 * special case (root-caused live, KπX: "je ne connais pas quel id correspond à quel window ds le
 * hitl de close" — opaque ids alone gave no recognizable context; then, more broadly: "juste me
 * montrer les ids ça ne m'aide pas... le hitl doit être human readable 100% transparent bien fait
 * intuitif" — every gated action's native chrome references (window/group/tab ids) get the exact
 * same first-class illustration treatment, never just window-close).
 */
async function describeApprovalDetails(request: RequestMessage): Promise<string[]> {
  if (!isPlainRecord(request.payload)) return [];
  const actionPayload = request.payload.payload;
  if (!isPlainRecord(actionPayload)) return [];
  const lines: string[] = [];
  for (const [field, value] of Object.entries(actionPayload)) {
    if (field === "profile") continue; // routing detail, not part of the proposed action itself
    if (SENSITIVE_APPROVAL_PAYLOAD_FIELDS.has(field)) {
      lines.push(`${field}: <redacted>`);
      continue;
    }
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
      lines.push(`${field}:`, ...value.map((line) => `  ${line}`));
      continue;
    }
    lines.push(`${field}: ${JSON.stringify(value)}`);
  }
  const actionName = typeof request.payload.action === "string" ? request.payload.action : "";
  const illustrations = await describeNativeReferences(actionName, actionPayload);
  if (illustrations.length > 0) lines.push("", ...illustrations);
  return lines;
}

/**
 * Purpose: resolve NATIVE chrome reference ids (never opaque CDP ids — those are the daemon's own
 * `"context"` field, see above) into human-readable illustrations for the approval overlay.
 * Args: `actionName` is the real gated action name (`request.payload.action`); `payload` is that
 * action's real payload (`request.payload.payload`).
 * Returns: extra lines to append after the raw field dump — a window's real tabs, a group's real
 * name+tabs, each resolved tab's real title+url, or a bookmark's real title+url; `[]` when the
 * payload carries no recognizable native id at all (e.g. `cookie-set`, `bookmark-create`).
 * Examples: `describeNativeReferences("group-update", {group_id: 5})` resolves group 5's CURRENT
 * title/color/tabs (KπX: "son nom très important" — renaming a group needs its EXISTING name
 * shown, not just the proposed new one already visible in the raw field dump above);
 * `describeNativeReferences("group-create", {tab_ids: [1,2]})` resolves both tabs' real title/url;
 * `describeNativeReferences("group-sync", {layout: [{type:"tab",tab_id:1},{type:"group",
 * tab_ids:[2,3]}]})` resolves every real tab id referenced ANYWHERE inside `layout` (used by both
 * `group-sync` and `window-sync` — same nested schema, one shared illustration path, never a
 * `layout`-only special case duplicated per action).
 */
async function describeNativeReferences(actionName: string, payload: Record<string, unknown>): Promise<string[]> {
  const lines: string[] = [];
  if (typeof payload.group_id === "number") lines.push(...(await describeGroupContext(payload.group_id)));
  if (typeof payload.window_id === "number") lines.push(...(await describeWindowContext(payload.window_id)));
  const tabIds = Array.isArray(payload.tab_ids)
    ? payload.tab_ids.filter((value): value is number => typeof value === "number")
    : [];
  if (tabIds.length > 0) lines.push(...(await describeTabsContext(tabIds)));
  if (Array.isArray(payload.layout)) {
    const layoutTabIds = new Set<number>();
    for (const entry of payload.layout) {
      if (!isPlainRecord(entry)) continue;
      if (typeof entry.tab_id === "number") layoutTabIds.add(entry.tab_id);
      if (Array.isArray(entry.tab_ids)) {
        for (const id of entry.tab_ids) if (typeof id === "number") layoutTabIds.add(id);
      }
    }
    if (layoutTabIds.size > 0) lines.push(...(await describeTabsContext([...layoutTabIds])));
  }
  if (actionName === "bookmark-remove" && typeof payload.id === "string") {
    lines.push(...(await describeBookmarkContext(payload.id)));
  }
  return lines;
}

/**
 * Purpose: describe one real Edge tab group's CURRENT name, color, and real tabs.
 * Args: `groupId` is the real numeric `chrome.tabGroups` id to describe.
 * Returns: one header line (`"group <id> — current title: ..., color: ..., N tab(s):"`) followed
 * by one indented line per real tab (`"    - \"<title>\" (<url>)"`), or a single unavailable line
 * if the group no longer exists — never a thrown error blocking the rest of the overlay.
 * Examples: `await describeGroupContext(5)` resolves live `chrome.tabGroups.get`/`chrome.tabs.query`;
 * a removed group id resolves to `["group 5: (could not be resolved — may no longer exist)"]`.
 */
async function describeGroupContext(groupId: number): Promise<string[]> {
  try {
    const group = await chrome.tabGroups.get(groupId);
    const tabs = await chrome.tabs.query({ groupId });
    return [
      `group ${groupId} — current title: "${group.title || "(untitled)"}", color: ${group.color}, ${tabs.length} tab(s):`,
      ...tabs.map((tab) => `    - "${tab.title ?? ""}" (${tab.url ?? ""})`),
    ];
  } catch {
    return [`group ${groupId}: (could not be resolved — may no longer exist)`];
  }
}

/**
 * Purpose: describe one real Edge window's real tabs.
 * Args: `windowId` is the real numeric `chrome.windows` id to describe.
 * Returns: one header line (`"window <id> — N tab(s):"`) followed by one indented line per real
 * tab, or a single unavailable line if the window no longer exists.
 * Examples: `await describeWindowContext(42)` resolves live `chrome.tabs.query({windowId})`;
 * a removed window id resolves to `["window 42: (could not be resolved — may no longer exist)"]`.
 */
async function describeWindowContext(windowId: number): Promise<string[]> {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return [
      `window ${windowId} — ${tabs.length} tab(s):`,
      ...tabs.map((tab) => `    - "${tab.title ?? ""}" (${tab.url ?? ""})`),
    ];
  } catch {
    return [`window ${windowId}: (could not be resolved — may no longer exist)`];
  }
}

/**
 * Purpose: describe each real Edge tab's title and url by its native `chrome.tabs.Tab.id`.
 * Args: `tabIds` are the real numeric tab ids to resolve, in the given order.
 * Returns: one `"tab <id>: \"<title>\" (<url>)"` line per id, or an unavailable line for any id
 * that no longer resolves — never a thrown error skipping the remaining ids.
 * Examples: `await describeTabsContext([1,2])` resolves live `chrome.tabs.get`; a closed tab id
 * resolves to `"tab 99: (could not be resolved — may no longer exist)"` for that entry alone.
 */
async function describeTabsContext(tabIds: number[]): Promise<string[]> {
  const lines: string[] = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      lines.push(`  tab ${tabId}: "${tab.title ?? ""}" (${tab.url ?? ""})`);
    } catch {
      lines.push(`  tab ${tabId}: (could not be resolved — may no longer exist)`);
    }
  }
  return lines;
}

/**
 * Purpose: describe one real Edge bookmark's title and url, for `bookmark-remove` specifically.
 * Args: `bookmarkId` is the real `chrome.bookmarks` node id about to be removed.
 * Returns: one `"bookmark <id>: \"<title>\" (<url>)"` line, or an unavailable line if it no longer
 * exists (already removed, or an invalid id).
 * Examples: `await describeBookmarkContext("42")` resolves live `chrome.bookmarks.get`; an unknown
 * id resolves to `"bookmark 42: (could not be resolved — may no longer exist)"`.
 */
async function describeBookmarkContext(bookmarkId: string): Promise<string[]> {
  try {
    const [node] = await chrome.bookmarks.get(bookmarkId);
    return [`bookmark ${bookmarkId}: "${node?.title ?? ""}" (${node?.url ?? ""})`];
  } catch {
    return [`bookmark ${bookmarkId}: (could not be resolved — may no longer exist)`];
  }
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
 * Purpose: wait until a tab finishes loading, so its content script is guaranteed injected.
 * Args: `tabId` is the real numeric tab id to wait for.
 * Returns: a promise resolving once `chrome.tabs.get(tabId).status === "complete"`.
 * Examples: `await waitForTabComplete(42)` resolves immediately if tab 42 is already loaded;
 * otherwise it resolves the moment `chrome.tabs.onUpdated` next reports `status: "complete"`.
 */
async function waitForTabComplete(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve) => {
    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Purpose: bring one tab to the front — the real page AND its window — so KπX actually SEES it.
 * Args: `tabId` is the real numeric tab id to activate and bring to front.
 * Returns: nothing; silently tolerates a tab/window that closed in the meantime.
 * Examples: `await focusHostTab(42)` makes tab 42 the active tab in its window AND focuses that
 * window (KπX directive: 100% transparency — a HITL prompt must never render in a tab/window KπX
 * has to go discover by accident; the browser must redirect them to it every time).
 */
async function focusHostTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Best-effort: the actual message delivery attempt right after this is what really matters.
  }
}

/**
 * Purpose: create a real, content-script-capable tab purely to host one HITL overlay, focused.
 * Args: none — always opens in the current window, and IS focused/activated immediately (KπX
 * directive: redirect to whichever tab hosts the prompt, found or created, every time).
 * Returns: the real numeric id of the newly created, fully loaded temporary tab.
 * Throws: if tab creation fails or never reports a usable id.
 * Examples: `await createTemporaryHostTab()` opens and focuses `https://example.com/`, resolving
 * once it has finished loading — used as a last resort when no existing `http(s)` tab can host the
 * prompt (see `getActiveTabId`'s fallback, and `sendToHostTab`'s retry-on-delivery-failure); this
 * temporary tab is always closed again once the interaction settles, never left behind.
 */
async function createTemporaryHostTab(): Promise<number> {
  const created = await chrome.tabs.create({ url: TEMPORARY_APPROVAL_TAB_URL, active: true });
  if (!created.id) throw new Error("Failed to create a temporary host tab");
  if (created.windowId !== undefined) await chrome.windows.update(created.windowId, { focused: true });
  await waitForTabComplete(created.id);
  return created.id;
}

/**
 * Purpose: close a temporary host tab, tolerating one that already closed itself.
 * Args: `temporaryTabId` is the id `createTemporaryHostTab` returned, or `undefined` (no-op).
 * Returns: nothing.
 * Examples: `await closeTemporaryHostTab(42)` closes tab 42;
 * `await closeTemporaryHostTab(undefined)` does nothing.
 */
async function closeTemporaryHostTab(temporaryTabId: number | undefined): Promise<void> {
  if (temporaryTabId === undefined) return;
  await chrome.tabs.remove(temporaryTabId).catch(() => undefined);
}

/**
 * Purpose: clean up ONE approval that never received a decision before its own declared timeout.
 * Args: `requestId` is the approval request id to check.
 * Returns: nothing; a no-op if the request already settled (approved/denied) before this fires.
 * Examples: `expireApprovalIfStillPending('r-1')` closes `r-1`'s temporary tab (if any) and sends a
 * timeout response if `r-1` is still pending; it does nothing if `r-1` was already resolved.
 */
async function expireApprovalIfStillPending(requestId: string): Promise<void> {
  const pending = approvals.get(requestId);
  if (!pending) return;
  approvals.delete(requestId);
  await closeTemporaryHostTab(pending.temporaryTabId);
  send({ type: "response", id: requestId, ok: false, data: { decision: "timeout", message: "Approval timed out" } });
}

/**
 * Purpose: arm a ONE-SHOT, service-worker-eviction-proof expiry sweep for one pending approval.
 * Args: `requestId` is the approval request id to expire later; `timeoutMs` is its declared timeout.
 * Returns: nothing; registers a uniquely-named `chrome.alarms` entry.
 * Examples: `armApprovalExpiryAlarm('r-1', 60000)` fires `expireApprovalIfStillPending('r-1')` in 60s.
 *
 * Root-caused bug (fixed): this used to be a plain `setTimeout`, which Chromium silently discards
 * if the service worker is evicted before it fires (the same MV3 pitfall already fixed for the
 * reconnect watchdog) — confirmed live: a temporary approval tab (`https://example.com`) was left
 * open for many minutes across several subsequent turns after one approval was abandoned mid-flow.
 * `chrome.alarms` always survives eviction — Chromium redelivers it by waking the worker.
 */
function armApprovalExpiryAlarm(requestId: string, timeoutMs: number): void {
  chrome.alarms.create(`${APPROVAL_EXPIRY_ALARM_PREFIX}${requestId}`, { when: Date.now() + timeoutMs });
}

/**
 * Purpose: register one approval as pending and attempt to deliver its overlay to one tab.
 * Args: `request` is the validated approval request; `tabId` is the candidate tab to try;
 * `temporaryTabId` is that same id ONLY if it is a temporary tab this call owns (so it gets
 * closed on failure), `undefined` for a pre-existing tab; `timeoutMs` bounds the approval.
 * Returns: `true` once the overlay message was actually delivered (and an expiry alarm armed);
 * `false` if delivery failed (the pending entry is rolled back, never left dangling).
 * Examples: `tryShowApproval(req, 12, undefined, 60000)` succeeds against an already-open tab;
 * `tryShowApproval(req, 55, 55, 60000)` succeeds against a freshly created temporary tab.
 */
async function tryShowApproval(
  request: RequestMessage,
  tabId: number,
  temporaryTabId: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const pending: PendingApproval = { request, tabId, temporaryTabId, expiresAt: Date.now() + timeoutMs };
  approvals.set(request.id, pending);
  try {
    const details = await describeApprovalDetails(request);
    await chrome.tabs.sendMessage(
      tabId,
      buildShowApprovalMessage(request.id, describeApprovalScopes(request), details),
    );
    armApprovalExpiryAlarm(request.id, timeoutMs);
    return true;
  } catch {
    approvals.delete(request.id);
    return false;
  }
}

/**
 * Purpose: show a redacted-but-transparent approval request in a real, focused tab.
 * Args: `request` is a validated, authenticated daemon action request of kind `"approval"`.
 * Returns: a promise that resolves after prompting, or denies if no tab could ever host it.
 * Examples: `requestApproval({ type: "request", id: "1", kind: "approval", payload: { action: "window-create" } })`
 * first tries the active tab when it can host the overlay, or another open `http(s)` tab
 * otherwise (see `getActiveTabId`), ALWAYS bringing that tab and its window to the front first
 * (KπX directive: never a prompt KπX has to go discover by accident); if that delivery ALSO fails
 * for any reason — root-caused live: an existing tab's content script becomes stale/orphaned right
 * after THIS extension itself reloads, so `chrome.tabs.sendMessage` to it silently fails even
 * though the tab looked perfectly usable — it retries ONCE more against a brand-new, focused
 * temporary tab (see `createTemporaryHostTab`), which always gets a fresh content script since it
 * loads AFTER any reload. That temporary tab (whichever attempt created one) is always closed
 * again the instant the approval settles, never left behind.
 */
async function requestApproval(request: RequestMessage): Promise<void> {
  if (approvals.has(request.id)) return closeForProtocolViolation();
  const timeoutMs = resolveApprovalTimeoutMs(request.payload);

  let candidateTabId: number | undefined;
  try {
    candidateTabId = await getActiveTabId();
  } catch {
    candidateTabId = undefined;
  }
  if (candidateTabId !== undefined) {
    await focusHostTab(candidateTabId);
    if (await tryShowApproval(request, candidateTabId, undefined, timeoutMs)) return;
  }

  try {
    const temporaryTabId = await createTemporaryHostTab();
    if (await tryShowApproval(request, temporaryTabId, temporaryTabId, timeoutMs)) return;
    await closeTemporaryHostTab(temporaryTabId);
  } catch {
    // No tab could ever be prepared — fall through to the failure response below.
  }
  send({ type: "response", id: request.id, ok: false, data: { message: "Failed to show approval UI" } });
}

/**
 * Purpose: validate and settle a content-script approval decision for a pending `"approval"` request.
 * Args: `message` is a validated `ApprovalResponseMessage`; `sender` identifies its originating tab.
 * Returns: nothing; sends the daemon-facing response as a side effect.
 * Examples: `handleApprovalResponse({type:"approvalResponse",requestId:"1",approved:true}, sender)` sends `{decision:"approved"}`.
 */
export function handleApprovalResponse(message: { requestId: string; approved: boolean }, sender: chrome.runtime.MessageSender): void {
  const pending = approvals.get(message.requestId);
  if (!pending || pending.tabId !== sender.tab?.id || Date.now() > pending.expiresAt) return;
  approvals.delete(message.requestId);
  void chrome.alarms.clear(`${APPROVAL_EXPIRY_ALARM_PREFIX}${message.requestId}`);
  void closeTemporaryHostTab(pending.temporaryTabId);

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
 * Purpose: deliver ONE content-script command to a real, focused tab — the single centralized
 * entry point every non-approval HITL interaction (`user.ask`, `overlay.dismiss`, `captcha.solve`,
 * `form.set_date`, `form.set_combobox`, `form.drop_file`) goes through, so they all share the exact
 * same tab-resolution, focus-redirect, and stale-content-script retry behavior `requestApproval`
 * already has — never six separately hand-duplicated copies drifting apart.
 * Args: `buildMessage` builds the actual command once a request id is known; `timeoutMs` bounds
 * each delivery attempt (defaults to the standard content-reply timeout).
 * Returns: the content script's reply data.
 * Throws: only if NO tab could ever be prepared at all (creating a temporary tab itself failed).
 * Examples: `sendToHostTab((id) => buildShowAskMessage(id, "Code?", "text"))` resolves with
 * `{answer: "..."}` from whichever real, focused tab actually hosted the prompt.
 */
async function sendToHostTab(
  buildMessage: (requestId: string) => BackgroundToContentMessage,
  timeoutMs = DEFAULT_CONTENT_REPLY_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let candidateTabId: number | undefined;
  try {
    candidateTabId = await getActiveTabId();
  } catch {
    candidateTabId = undefined;
  }
  if (candidateTabId !== undefined) {
    await focusHostTab(candidateTabId);
    try {
      const requestId = crypto.randomUUID();
      return await awaitContentReply(candidateTabId, requestId, buildMessage(requestId), timeoutMs);
    } catch {
      // Root-caused live (same class of bug as requestApproval's): a found candidate tab's content
      // script can still be stale/orphaned (e.g. right after this extension itself reloads).
      // Retry once via a brand-new, focused temporary tab before giving up entirely.
    }
  }
  const temporaryTabId = await createTemporaryHostTab();
  try {
    const requestId = crypto.randomUUID();
    return await awaitContentReply(temporaryTabId, requestId, buildMessage(requestId), timeoutMs);
  } finally {
    await closeTemporaryHostTab(temporaryTabId);
  }
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

/** One real tab entry inside `computeWindowLayouts()`'s per-window canonical layout. */
interface WindowLayoutTab {
  readonly chrome_tab_id: number;
  readonly index: number;
  readonly url: string | null;
  readonly title: string | null;
  readonly group_id: number | null;
  readonly active: boolean;
  readonly pinned: boolean;
}

/** One real tab-group's metadata, keyed by its numeric id as a string in `WindowLayout.groups`. */
interface WindowLayoutGroup {
  readonly title: string | null;
  readonly color: TabGroupColor;
  readonly collapsed: boolean;
}

/** One entry in `WindowLayout.order` — the exact visual left-to-right sequence Edge itself shows. */
type WindowLayoutOrderEntry =
  | { readonly kind: "tab"; readonly chrome_tab_id: number }
  | {
      readonly kind: "group";
      readonly group_id: number;
      readonly title: string | null;
      readonly color: TabGroupColor;
      readonly collapsed: boolean;
      readonly tabs: number[];
    };

/** The single canonical structural truth for one real Edge window. */
interface WindowLayout {
  readonly window_id: number;
  readonly tabs: WindowLayoutTab[];
  readonly groups: Record<string, WindowLayoutGroup>;
  readonly order: WindowLayoutOrderEntry[];
}

/**
 * Purpose: compute the ONE canonical tab/group structural truth for every real window, in one pass.
 * Args: none — always queries the full browser instance (`chrome.tabs.query({})` +
 * `chrome.tabGroups.query({})`), never a single window, so every window is consistent with the
 * others in the same snapshot.
 * Returns: a map keyed by `String(windowId)`. `tabs` is flat and ordered by real `index`, each tab
 * carrying its own `group_id` (`null` when ungrouped). `groups` is pure per-group metadata, never
 * duplicated tab data. `order` is the exact visual left-to-right sequence Edge itself renders —
 * standalone tabs interleaved with contiguous group blocks (Chromium always keeps one group's tabs
 * contiguous; this is derived here, never independently re-fetched). `group.list`,
 * `window.layout`, `tab.move`, `group.add_tabs`, and `group.remove_tabs` all read or mutate this
 * SAME real Chromium state — there is no second, independently-maintained copy anywhere.
 * Examples: `computeWindowLayouts()` on a window with tab1, tab2, then a 2-tab group, then tab3
 * returns that window's `order` as `[tab,tab,group(2 tabs),tab]`, matching Edge's own layout
 * exactly; on a window with no groups, every `order` entry is `{kind:"tab",...}`.
 */
async function computeWindowLayouts(): Promise<Record<string, WindowLayout>> {
  const [allTabs, allGroups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const groupById = new Map(allGroups.map((group) => [group.id, group]));
  const byWindow = new Map<number, chrome.tabs.Tab[]>();
  for (const tab of allTabs) {
    if (tab.windowId === undefined || tab.id === undefined) continue;
    const list = byWindow.get(tab.windowId) ?? [];
    list.push(tab);
    byWindow.set(tab.windowId, list);
  }
  const layouts: Record<string, WindowLayout> = {};
  for (const [windowId, tabsInWindow] of byWindow) {
    const sorted = [...tabsInWindow].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const tabs: WindowLayoutTab[] = sorted.map((tab) => ({
      chrome_tab_id: tab.id as number,
      index: tab.index,
      url: tab.url ?? null,
      title: tab.title ?? null,
      group_id: tab.groupId !== undefined && tab.groupId >= 0 ? tab.groupId : null,
      active: tab.active,
      pinned: tab.pinned,
    }));
    const groups: Record<string, WindowLayoutGroup> = {};
    const order: WindowLayoutOrderEntry[] = [];
    let cursor = 0;
    while (cursor < tabs.length) {
      const tab = tabs[cursor] as WindowLayoutTab;
      if (tab.group_id === null) {
        order.push({ kind: "tab", chrome_tab_id: tab.chrome_tab_id });
        cursor += 1;
        continue;
      }
      const groupId = tab.group_id;
      const run: number[] = [];
      while (cursor < tabs.length && tabs[cursor]?.group_id === groupId) {
        run.push((tabs[cursor] as WindowLayoutTab).chrome_tab_id);
        cursor += 1;
      }
      const realGroup = groupById.get(groupId);
      const groupMeta: WindowLayoutGroup = {
        title: realGroup?.title ?? null,
        color: (realGroup?.color as TabGroupColor | undefined) ?? "grey",
        collapsed: realGroup?.collapsed ?? false,
      };
      groups[String(groupId)] = groupMeta;
      order.push({ kind: "group", group_id: groupId, tabs: run, ...groupMeta });
    }
    layouts[String(windowId)] = { window_id: windowId, tabs, groups, order };
  }
  return layouts;
}

/**
 * Purpose: return the canonical tab/group layout for one real window, or every window at once.
 * Args: `payload` optionally `{window_id: number}`; omitted or `{}` returns every window.
 * Returns: `{window_id, tabs, groups, order}` for one window (empty layout if that window has no
 * tabs right now), or `{windows: {"<id>": {...}, ...}}` for all real windows.
 * Examples: `handleWindowLayout({})` returns every window; `handleWindowLayout({window_id:99})`
 * returns just that window's `{tabs, groups, order}`.
 */
export async function handleWindowLayout(payload: unknown): Promise<Record<string, unknown>> {
  if (isPlainRecord(payload) && payload.window_id !== undefined && typeof payload.window_id !== "number") {
    throw new Error("window.layout accepts an optional {window_id: number}");
  }
  const layouts = await computeWindowLayouts();
  const windowId = isPlainRecord(payload) && typeof payload.window_id === "number" ? payload.window_id : undefined;
  if (windowId === undefined) return { windows: layouts };
  const layout = layouts[String(windowId)];
  return layout ? { ...layout } : { window_id: windowId, tabs: [], groups: {}, order: [] };
}

/**
 * Purpose: list every real tab group and its tabs, derived from the same canonical window layout.
 * Args: none.
 * Returns: `{ groups: [{id,window_id,title,color,collapsed,tabs:[{id,url,title}]}] }`.
 * Examples: `handleGroupList()` on a profile with one group returns one entry with its tabs and its
 * `window_id`; on a profile with no groups returns `{ groups: [] }`.
 */
export async function handleGroupList(): Promise<Record<string, unknown>> {
  const layouts = await computeWindowLayouts();
  const result: Array<Record<string, unknown>> = [];
  for (const layout of Object.values(layouts)) {
    for (const [groupIdText, group] of Object.entries(layout.groups)) {
      const groupTabs = layout.tabs.filter((tab) => String(tab.group_id) === groupIdText);
      result.push({
        id: Number(groupIdText),
        window_id: layout.window_id,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabs: groupTabs.map((tab) => ({ id: tab.chrome_tab_id, url: tab.url, title: tab.title })),
      });
    }
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
 * Purpose: validate the payload for the ONE fine-grained way to change anything about one tab.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{tab_id: number}` plus ANY combination of `url` (string), `window_id`
 * (number), `group_id` (number, or explicit `null` to remove it from its group), and AT MOST ONE
 * of `index` (`-1` moves to the end, matching `chrome.tabs.move`'s own convention),
 * `before_tab_id`, or `after_tab_id` — never two position hints at once. At least ONE field beyond
 * `tab_id` must be given (a no-op call is rejected).
 * Examples: `isTabUpdatePayload({tab_id:1,index:0})` is `true`; `isTabUpdatePayload({tab_id:1,
 * url:"https://a"})` is `true`; `isTabUpdatePayload({tab_id:1})` is `false` (nothing to change);
 * `isTabUpdatePayload({tab_id:1,index:0,before_tab_id:2})` is `false` (two position hints).
 */
function isTabUpdatePayload(value: unknown): value is {
  tab_id: number;
  url?: string;
  window_id?: number;
  group_id?: number | null;
  index?: number;
  before_tab_id?: number;
  after_tab_id?: number;
} {
  if (!isPlainRecord(value) || typeof value.tab_id !== "number") return false;
  if (value.url !== undefined && typeof value.url !== "string") return false;
  if (value.window_id !== undefined && typeof value.window_id !== "number") return false;
  if (value.group_id !== undefined && value.group_id !== null && typeof value.group_id !== "number") return false;
  if (value.index !== undefined && typeof value.index !== "number") return false;
  if (value.before_tab_id !== undefined && typeof value.before_tab_id !== "number") return false;
  if (value.after_tab_id !== undefined && typeof value.after_tab_id !== "number") return false;
  const positionsGiven = [value.index, value.before_tab_id, value.after_tab_id].filter((v) => v !== undefined).length;
  if (positionsGiven > 1) return false;
  const anyFieldGiven =
    value.url !== undefined || value.window_id !== undefined || value.group_id !== undefined || positionsGiven === 1;
  return anyFieldGiven;
}

/**
 * Purpose: the ONE fine-grained way to change anything mutable about one real, already-open tab —
 * its url, its window, its group/folder, or its position — any subset, in one call. Renamed from
 * `tab.move` (KπX directive, GRAVÉ: "renomme en tab-update... url, window, folder, index...
 * centralise vraiment tout cela pour redistribuer partout cette philo de fin ajustement").
 * Args: `payload` must satisfy `isTabUpdatePayload`.
 * Returns: `{tab_id, url, index, window_id, group_id}` reflecting the tab's REAL state after every
 * requested change (a field applied via a distinct chrome.tabs call, in this fixed order: url
 * navigation, then group membership, then position/window — the same order a human would do it by
 * hand: load the right page, file it in the right folder, THEN place it precisely).
 * Examples: `handleTabUpdate({tab_id:12,url:"https://a"})` navigates tab 12 in place;
 * `handleTabUpdate({tab_id:12,group_id:null})` removes tab 12 from its current group;
 * `handleTabUpdate({tab_id:12,window_id:99,index:-1})` moves tab 12 to the end of window 99.
 */
export async function handleTabUpdate(payload: unknown): Promise<Record<string, unknown>> {
  if (!isTabUpdatePayload(payload)) {
    throw new Error(
      "tab.update requires {tab_id: number} plus at least one of: url, window_id, group_id, index/before_tab_id/after_tab_id"
    );
  }
  let tabId = payload.tab_id;
  if (payload.url !== undefined) {
    const updated = await chrome.tabs.update(tabId, { url: payload.url });
    tabId = updated?.id ?? tabId;
  }
  if (payload.group_id === null) {
    await chrome.tabs.ungroup(tabId);
  } else if (payload.group_id !== undefined) {
    await chrome.tabs.group({ tabIds: tabId, groupId: payload.group_id });
  }
  let index = payload.index;
  if (index === undefined && payload.before_tab_id !== undefined) {
    index = (await chrome.tabs.get(payload.before_tab_id)).index;
  }
  if (index === undefined && payload.after_tab_id !== undefined) {
    index = (await chrome.tabs.get(payload.after_tab_id)).index + 1;
  }
  let tab: chrome.tabs.Tab;
  if (index !== undefined || payload.window_id !== undefined) {
    const moved = await chrome.tabs.move(tabId, { index: (index ?? -1) as number, windowId: payload.window_id });
    tab = Array.isArray(moved) ? moved[0] : moved;
  } else {
    tab = await chrome.tabs.get(tabId);
  }
  return { tab_id: tab.id ?? tabId, url: tab.url, index: tab.index, window_id: tab.windowId, group_id: tab.groupId };
}

/**
 * Purpose: validate the payload for adjusting an EXISTING window's own bounds/state/focus.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{window_id: number}` plus ANY combination of `bounds`
 * (`{left?,top?,width?,height?}`, any subset), `state` (a real `chrome.windows.WindowState`), and
 * `focused` (boolean) — at least one field beyond `window_id` required.
 * Examples: `isWindowUpdatePayload({window_id:1,state:"maximized"})` is `true`;
 * `isWindowUpdatePayload({window_id:1})` is `false` (nothing to change).
 */
function isWindowUpdatePayload(value: unknown): value is {
  window_id: number;
  bounds?: { left?: number; top?: number; width?: number; height?: number };
  state?: chrome.windows.windowStateEnum;
  focused?: boolean;
} {
  if (!isPlainRecord(value) || typeof value.window_id !== "number") return false;
  if (value.bounds !== undefined && !isPlainRecord(value.bounds)) return false;
  if (value.focused !== undefined && typeof value.focused !== "boolean") return false;
  const validStates = ["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen"];
  if (value.state !== undefined && !validStates.includes(value.state as string)) return false;
  return value.bounds !== undefined || value.state !== undefined || value.focused !== undefined;
}

/**
 * Purpose: adjust an EXISTING real Edge window's own bounds, state, or focus — the window-level
 * counterpart to `tab.update`, via `chrome.windows.update`.
 * Args: `payload` must satisfy `isWindowUpdatePayload`.
 * Returns: `{window_id, bounds, state, focused}` reflecting the window's REAL properties after
 * the update.
 * Examples: `handleWindowUpdate({window_id:1,state:"maximized"})` maximizes window 1;
 * `handleWindowUpdate({window_id:1,bounds:{width:800,height:600}})` resizes it.
 */
export async function handleWindowUpdate(payload: unknown): Promise<Record<string, unknown>> {
  if (!isWindowUpdatePayload(payload)) {
    throw new Error("window.update requires {window_id: number} plus at least one of: bounds, state, focused");
  }
  const updated = await chrome.windows.update(payload.window_id, {
    ...payload.bounds,
    state: payload.state,
    focused: payload.focused,
  });
  return {
    window_id: updated.id ?? payload.window_id,
    bounds: { left: updated.left, top: updated.top, width: updated.width, height: updated.height },
    state: updated.state,
    focused: updated.focused,
  };
}

/**
 * Purpose: validate the payload required to add existing tabs to an ALREADY-CREATED tab group.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{group_id: number, tab_ids: number[]}` with at least one tab id.
 * Examples: `isGroupAddTabsPayload({group_id:1,tab_ids:[2,3]})` is `true`;
 * `isGroupAddTabsPayload({group_id:1,tab_ids:[]})` is `false`.
 */
function isGroupAddTabsPayload(value: unknown): value is { group_id: number; tab_ids: number[] } {
  if (!isPlainRecord(value) || typeof value.group_id !== "number") return false;
  return Array.isArray(value.tab_ids) && value.tab_ids.length > 0 && value.tab_ids.every((id) => typeof id === "number");
}

/**
 * Purpose: add existing real tabs into an ALREADY-CREATED tab group (never creates a new one) —
 * the drag-a-tab-into-an-existing-folder primitive, via `chrome.tabs.group({tabIds, groupId})`.
 * Args: `payload` must be `{group_id: number, tab_ids: number[]}`.
 * Returns: `{group_id, tab_ids}` of the tabs now inside that group.
 * Examples: `handleGroupAddTabs({group_id:5, tab_ids:[12,13]})` adds tabs 12 and 13 to group 5;
 * a `tab_ids` already partly inside another group is silently re-grouped (matches manual drag).
 */
export async function handleGroupAddTabs(payload: unknown): Promise<Record<string, unknown>> {
  if (!isGroupAddTabsPayload(payload)) throw new Error("group.add_tabs requires {group_id: number, tab_ids: number[]}");
  const groupId = await chrome.tabs.group({ tabIds: payload.tab_ids, groupId: payload.group_id });
  return { group_id: groupId, tab_ids: payload.tab_ids };
}

/**
 * Purpose: validate the payload required to remove tabs from their group without closing them.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{tab_ids: number[]}` with at least one tab id.
 * Examples: `isGroupRemoveTabsPayload({tab_ids:[1]})` is `true`;
 * `isGroupRemoveTabsPayload({tab_ids:[]})` is `false`.
 */
function isGroupRemoveTabsPayload(value: unknown): value is { tab_ids: number[] } {
  return isPlainRecord(value) && Array.isArray(value.tab_ids) && value.tab_ids.length > 0 && value.tab_ids.every((id) => typeof id === "number");
}

/**
 * Purpose: remove real tabs from whichever group they are currently in, WITHOUT closing them — the
 * drag-a-tab-out-of-its-folder primitive, via `chrome.tabs.ungroup`.
 * Args: `payload` must be `{tab_ids: number[]}`.
 * Returns: `{tab_ids, ungrouped: true}`.
 * Examples: `handleGroupRemoveTabs({tab_ids:[12,13]})` ungroups both tabs, leaving them open at
 * their current position; a tab that was already ungrouped is a harmless no-op for that id.
 */
export async function handleGroupRemoveTabs(payload: unknown): Promise<Record<string, unknown>> {
  if (!isGroupRemoveTabsPayload(payload)) throw new Error("group.remove_tabs requires {tab_ids: number[]}");
  await chrome.tabs.ungroup(payload.tab_ids);
  return { tab_ids: payload.tab_ids, ungrouped: true };
}

/** One entry of a `group.sync` batch: either a standalone ungrouped tab, or a whole group (new or
 * existing — `group_id` present reuses/renames/re-colors/adds-to that exact group; absent creates
 * a brand-new one), always with the real tab ids it owns. */
type GroupSyncEntry =
  | { readonly type: "tab"; readonly tab_id: number }
  | { readonly type: "group"; readonly group_id?: number; readonly title?: string; readonly color?: TabGroupColor; readonly tab_ids: number[] };

/**
 * Purpose: validate one `group.sync` layout entry (a standalone tab or a whole group).
 * Args: `value` is an untrusted layout array element.
 * Returns: `true` for `{type:"tab",tab_id:number}` or `{type:"group",group_id?,title?,color?,tab_ids:number[]}`.
 * Examples: `isGroupSyncEntry({type:"tab",tab_id:1})` is `true`;
 * `isGroupSyncEntry({type:"group",tab_ids:[1,2],title:"Research"})` is `true`;
 * `isGroupSyncEntry({type:"group",tab_ids:[]})` is `false` (a group needs at least one tab).
 */
function isGroupSyncEntry(value: unknown): value is GroupSyncEntry {
  if (!isPlainRecord(value)) return false;
  if (value.type === "tab") return typeof value.tab_id === "number";
  if (value.type !== "group") return false;
  if (!Array.isArray(value.tab_ids) || value.tab_ids.length === 0 || !value.tab_ids.every((id) => typeof id === "number")) return false;
  if (value.group_id !== undefined && typeof value.group_id !== "number") return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  return value.color === undefined || isTabGroupColor(value.color);
}

/**
 * Purpose: validate the full `group.sync` payload — an ordered, non-empty layout of entries.
 * Args: `value` is the untrusted request payload.
 * Returns: `true` for `{layout: GroupSyncEntry[]}` with at least one entry, all individually valid.
 * Examples: `isGroupSyncPayload({layout:[{type:"tab",tab_id:1}]})` is `true`;
 * `isGroupSyncPayload({layout:[]})` is `false`.
 */
function isGroupSyncPayload(value: unknown): value is { layout: GroupSyncEntry[] } {
  return isPlainRecord(value) && Array.isArray(value.layout) && value.layout.length > 0 && value.layout.every(isGroupSyncEntry);
}

/**
 * Purpose: reorganize a WHOLE window's tab/group structure in one call — total flexibility (create,
 * rename, recolor, add-to, remove-from, and reposition, all at once), never N separate
 * approval-free calls for what is conceptually one deliberate rearrangement.
 * Args: `payload` must be `{layout: [...]}`, an ORDERED list processed left to right, each entry
 * either `{type:"tab",tab_id}` (a standalone, ungrouped tab at this position) or
 * `{type:"group",group_id?,title?,color?,tab_ids}` (a whole group at this position — `group_id`
 * given reuses that EXACT existing group, applying any given `title`/`color` and ADDING these
 * `tab_ids` to it; `group_id` absent creates a brand-new group from these `tab_ids`).
 * Returns: `{layout: [...]}` — one entry per input entry, in the same order, each carrying the real
 * `tab_id` or the real (possibly newly created) `group_id`.
 * Examples: `handleGroupSync({layout:[{type:"tab",tab_id:1},{type:"group",title:"Research",
 * tab_ids:[2,3]},{type:"tab",tab_id:4}]})` ungroups tab 1, creates (or reuses) a group titled
 * "Research" containing tabs 2 and 3, then places tab 4 after it — the exact final visual order
 * KπX sees in Edge, built in one deliberate command instead of N separate ones.
 */
export async function handleGroupSync(payload: unknown): Promise<Record<string, unknown>> {
  if (!isGroupSyncPayload(payload)) {
    throw new Error("group.sync requires {layout: [{type:'tab',tab_id}|{type:'group',group_id?,title?,color?,tab_ids}]}");
  }
  const results: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const entry of payload.layout) {
    if (entry.type === "tab") {
      await chrome.tabs.ungroup([entry.tab_id]).catch(() => undefined);
      await chrome.tabs.move(entry.tab_id, { index: cursor });
      cursor += 1;
      results.push({ type: "tab", tab_id: entry.tab_id });
      continue;
    }
    const groupId =
      entry.group_id !== undefined
        ? await chrome.tabs.group({ tabIds: entry.tab_ids, groupId: entry.group_id })
        : await chrome.tabs.group({ tabIds: entry.tab_ids });
    if (entry.title !== undefined || entry.color !== undefined) {
      await chrome.tabGroups.update(groupId, { title: entry.title, color: entry.color });
    }
    await chrome.tabGroups.move(groupId, { index: cursor });
    cursor += entry.tab_ids.length;
    results.push({ type: "group", group_id: groupId, tab_ids: entry.tab_ids });
  }
  return { layout: results };
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
  const reply = await sendToHostTab((requestId) => buildShowAskMessage(requestId, payload.question, payload.input_type ?? "text"));
  return { answer: reply.answer };
}

/**
 * Purpose: heuristically dismiss cookie/consent overlays on the active tab's page.
 * Args: `_payload` is unused.
 * Returns: `{dismissed: number}`.
 * Examples: `handleOverlayDismiss({})` on a page with a cookie banner returns `{dismissed: 1}`.
 */
export async function handleOverlayDismiss(): Promise<Record<string, unknown>> {
  const reply = await sendToHostTab((requestId) => buildDismissOverlaysMessage(requestId));
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
  const reply = await sendToHostTab((requestId) => buildSolveCaptchaMessage(requestId, payload.action, payload.cells));
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
  const reply = await sendToHostTab((requestId) => buildSetDateMessage(requestId, payload.selector, payload.value));
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
  const reply = await sendToHostTab((requestId) => buildSetComboboxMessage(requestId, payload.selector, payload.value));
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
  const reply = await sendToHostTab((requestId) => buildDropFileMessage(requestId, payload.selector, payload.filename, payload.content_base64, payload.mime_type));
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
  "group.add_tabs": (payload) => handleGroupAddTabs(payload),
  "group.remove_tabs": (payload) => handleGroupRemoveTabs(payload),
  "group.sync": (payload) => handleGroupSync(payload),
  "window.layout": (payload) => handleWindowLayout(payload),
  "window.update": (payload) => handleWindowUpdate(payload),
  "tab.update": (payload) => handleTabUpdate(payload),
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
  if (alarm.name.startsWith(APPROVAL_EXPIRY_ALARM_PREFIX)) {
    void expireApprovalIfStillPending(alarm.name.slice(APPROVAL_EXPIRY_ALARM_PREFIX.length));
  }
});
ensureReconnectAlarm();
connectBridge();
