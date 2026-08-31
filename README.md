# browser-proxy-ext

`browser-proxy-ext` is a production-oriented Manifest V3 bridge for **Microsoft Edge only**. It exposes a narrowly scoped, locally authenticated WebSocket session to `browser-proxyd`; it is not a browser automation backdoor.

## Capabilities

- serializes the profile-scoped bookmark tree through `chrome.bookmarks`;
- snapshots Edge windows, tabs, and tab groups through extension APIs;
- derives **heuristic** workspace hints from window/tab-group structure. Edge exposes no official Workspace API to this extension, so these hints are never authoritative;
- authenticates the local daemon using a per-install shared secret and challenge HMAC;
- displays an isolated in-page approval overlay before any daemon-requested collection.

## Security model

The background service worker is the sole holder of the shared secret. It sends only an HMAC proof for a server-issued nonce; the secret itself is never sent. Content scripts receive redacted approval requests only and cannot access snapshots, WebSocket traffic, or extension storage. Invalid JSON, unknown message types, malformed payloads, unauthenticated sessions, replayed approvals, and unexpected server requests are rejected without side effects.

## Connection resilience

The background service worker reconnects to the local daemon through two complementary mechanisms:
a fast `setTimeout`-based exponential backoff (500ms–30s) for quick recovery while the worker is
still warm, and a `chrome.alarms` watchdog (fires every 30s) as the mechanism that actually
guarantees eventual recovery — Manifest V3 can evict an idle service worker (~30s) and silently
discard any pending `setTimeout`, but Chromium always redelivers a registered alarm by waking the
worker first. Requires the `alarms` permission.

## Install and run locally

```sh
bun install
make check
make build
```

In Microsoft Edge, open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository directory. Open the extension's **Details → Extension options** and provision the same shared secret as the local daemon **and** the exact browser-proxy profile name this Edge window belongs to (must match `admin profile start <profile>`/`profile-start`; defaults to `default`). The default local endpoint is `ws://127.0.0.1:8765/v1/extension`.

Each profile is a fully separate Edge install with its own copy of this extension and its own
storage — the profile name is never shared or auto-discovered (Chrome extensions cannot see which
`--user-data-dir` they run inside); it must be set once per profile in Options.

## Development commands

| Command | Purpose |
| --- | --- |
| `make install` | Install locked project dependencies. |
| `make build` | Bundle worker, content overlay, and options UI into `dist/`. |
| `make test` | Run unit tests. |
| `make typecheck` | Run strict TypeScript checking. |
| `make check` | Type-check and test. |

## Protocol

See [CONTRACT.md](CONTRACT.md) for the versioned JSON protocol, request authorization, schema rejection, and safety guarantees.

## License

MIT. See [LICENSE](LICENSE).
