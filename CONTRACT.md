# Public bridge contract

## Scope and version

The public bridge is protocol version `1`, transported over a WebSocket opened by the Microsoft Edge extension background worker to `ws://127.0.0.1:8765/v1/extension`. Every frame is a UTF-8 JSON object. The extension rejects non-JSON frames, arrays, unknown keys where a typed payload is required, unknown message types, and schema-invalid values.

The extension sends `{ "type": "hello", "protocolVersion": 1, "extensionVersion": "0.1.0" }`. The daemon replies with `{ "type": "challenge", "nonce": "base64url-random" }`. The extension replies with `{ "type": "authenticate", "nonce": "…", "proof": "base64url(HMAC-SHA-256(secret, nonce))" }`. The daemon must explicitly send `{ "type": "authenticated" }` before requests are accepted.

The secret is never a protocol field and never leaves extension storage. The daemon must use a fresh, single-use nonce and close the connection on authentication failure.

## Daemon requests

After authentication, only this request is valid:

```json
{ "type": "requestSnapshot", "requestId": "uuid-or-opaque-id", "scopes": ["bookmarks", "tabs", "workspaceHints"] }
```

`requestId` must be 1–128 characters, unique during the session. `scopes` is non-empty and contains only `bookmarks`, `tabs`, or `workspaceHints`. The extension relays a redacted approval prompt to the active tab. It sends a snapshot only after the user approves that exact request once. Denial returns `{ "type": "requestDenied", "requestId": "…" }`.

Approved output is `{ "type": "snapshot", "requestId": "…", "snapshot": { ... } }`. Bookmark and tab structures are profile-scoped to the Edge profile that installed the extension. Snapshot data excludes cookies, page DOM, form data, local storage, history, credentials, WebSocket payloads, and the bridge secret.

## Workspace hints

`workspaceHints` are derived only from visible window and tab-group structure. They are heuristic labels intended for grouping. They do **not** represent Edge Workspaces and must never be represented as official Workspace data: this extension has no official Edge Workspace API.

## Failure semantics

The extension fails closed: an invalid frame, unexpected state transition, authentication failure, missing secret, expired overlay response, missing active tab, or data-collection error yields no snapshot. It closes the socket for protocol/authentication violations. No daemon request can execute a browser action; the contract supports only approved read-only snapshots.
