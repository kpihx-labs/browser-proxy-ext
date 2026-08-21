/** The only protocol revision accepted by this extension. */
export const PROTOCOL_VERSION = 1;

/** A daemon-issued authentication challenge. */
export interface ChallengeMessage {
  readonly type: "challenge";
  readonly nonce: string;
}

/** An authenticated, read-only snapshot request. */
export interface SnapshotRequestMessage {
  readonly type: "requestSnapshot";
  readonly requestId: string;
  readonly scopes: readonly SnapshotScope[];
}

/** The data categories that a user may approve for a snapshot. */
export type SnapshotScope = "bookmarks" | "tabs" | "workspaceHints";

/** A structurally valid server message before state-machine validation. */
export type ServerMessage = ChallengeMessage | { readonly type: "authenticated" } | SnapshotRequestMessage;

/** A client protocol message. */
export type ClientMessage =
  | { readonly type: "hello"; readonly protocolVersion: number; readonly extensionVersion: string }
  | { readonly type: "authenticate"; readonly nonce: string; readonly proof: string }
  | { readonly type: "requestDenied"; readonly requestId: string }
  | { readonly type: "snapshot"; readonly requestId: string; readonly snapshot: unknown };

/**
 * Purpose: parse and strictly validate an inbound daemon WebSocket frame.
 * Args: `raw` is the raw text received from the WebSocket.
 * Returns: a typed server message, or `null` when the frame is invalid or unsupported.
 * Examples: `parseServerMessage('{"type":"authenticated"}')`; `parseServerMessage('[]')` returns `null`.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.type !== "string") return null;

    if (value.type === "challenge" && hasExactKeys(value, ["type", "nonce"]) && isNonce(value.nonce)) {
      return { type: "challenge", nonce: value.nonce };
    }
    if (value.type === "authenticated" && hasExactKeys(value, ["type"])) {
      return { type: "authenticated" };
    }
    if (
      value.type === "requestSnapshot" &&
      hasExactKeys(value, ["type", "requestId", "scopes"]) &&
      isRequestId(value.requestId) &&
      isScopes(value.scopes)
    ) {
      return { type: "requestSnapshot", requestId: value.requestId, scopes: value.scopes };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Purpose: serialize a validated client message into the protocol's JSON text form.
 * Args: `message` is a message constructed by the extension state machine.
 * Returns: a JSON string safe to pass to `WebSocket.send`.
 * Examples: `serializeClientMessage({ type: "hello", protocolVersion: 1, extensionVersion: "0.1.0" })`; `serializeClientMessage({ type: "requestDenied", requestId: "r-1" })`.
 */
export function serializeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

/**
 * Purpose: verify that a value is a non-null plain JSON object.
 * Args: `value` is an untrusted parsed JSON value.
 * Returns: `true` when the value can safely be inspected as a record.
 * Examples: `isRecord({ type: "authenticated" })` is `true`; `isRecord(null)` is `false`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Purpose: require an object to contain exactly the expected protocol fields.
 * Args: `value` is an untrusted record; `keys` lists every permitted field.
 * Returns: `true` only when no optional, inherited, or unexpected fields are present.
 * Examples: `hasExactKeys({ type: "authenticated" }, ["type"])` is `true`; `hasExactKeys({ type: "authenticated", x: 1 }, ["type"])` is `false`.
 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

/**
 * Purpose: validate a bounded server nonce without imposing a daemon-specific encoding.
 * Args: `value` is the candidate nonce.
 * Returns: `true` for a printable 16–512 character nonce.
 * Examples: `isNonce("server-nonce-12345")` is `true`; `isNonce(42)` is `false`.
 */
function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,512}$/.test(value);
}

/**
 * Purpose: reject empty or unbounded request identifiers before recording approval state.
 * Args: `value` is an untrusted request identifier.
 * Returns: `true` for a non-empty printable identifier of at most 128 characters.
 * Examples: `isRequestId("7c445b3d")` is `true`; `isRequestId("")` is `false`.
 */
function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/**
 * Purpose: validate snapshot scopes and reject duplicate or unsupported categories.
 * Args: `value` is the untrusted `scopes` field.
 * Returns: `true` only for a non-empty unique list of supported scopes.
 * Examples: `isScopes(["tabs", "bookmarks"])` is `true`; `isScopes(["tabs", "tabs"])` is `false`.
 */
function isScopes(value: unknown): value is readonly SnapshotScope[] {
  const allowed = new Set<SnapshotScope>(["bookmarks", "tabs", "workspaceHints"]);
  return Array.isArray(value) && value.length > 0 && value.every((scope) => typeof scope === "string" && allowed.has(scope as SnapshotScope)) && new Set(value).size === value.length;
}
