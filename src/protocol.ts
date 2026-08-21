/** The only protocol revision accepted by this extension. */
export const PROTOCOL_VERSION = 1;

/** A daemon-issued handshake response. */
export interface HandshakeAcceptedMessage {
  readonly type: "handshake";
  readonly status: "accepted";
  readonly protocol: number;
}

/** A daemon-issued proxy action request. */
export interface RequestMessage {
  readonly type: "request";
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

/** A structurally valid server message before state-machine validation. */
export type ServerMessage = HandshakeAcceptedMessage | RequestMessage;

/** A client protocol message. */
export type ClientMessage =
  | { readonly type: "handshake"; readonly token: string; readonly extension_id: string }
  | { readonly type: "response"; readonly id: string; readonly ok: boolean; readonly data: unknown };

/**
 * Purpose: parse and strictly validate an inbound daemon WebSocket frame.
 * Args: `raw` is the raw text received from the WebSocket.
 * Returns: a typed server message, or `null` when the frame is invalid or unsupported.
 * Examples: `parseServerMessage('{"type":"handshake","status":"accepted","protocol":1}')`; `parseServerMessage('[]')` returns `null`.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.type !== "string") return null;

    if (value.type === "handshake" && value.status === "accepted" && typeof value.protocol === "number") {
      return { type: "handshake", status: "accepted", protocol: value.protocol };
    }
    if (
      value.type === "request" &&
      typeof value.id === "string" &&
      typeof value.kind === "string"
    ) {
      return { type: "request", id: value.id, kind: value.kind, payload: value.payload };
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
 * Examples: `serializeClientMessage({ type: "handshake", token: "xyz", extension_id: "ext1" })`; `serializeClientMessage({ type: "response", id: "1", ok: true, data: {} })`.
 */
export function serializeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

/**
 * Purpose: verify that a value is a non-null plain JSON object.
 * Args: `value` is an untrusted parsed JSON value.
 * Returns: `true` when the value can safely be inspected as a record.
 * Examples: `isRecord({ type: "request" })` is `true`; `isRecord(null)` is `false`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
