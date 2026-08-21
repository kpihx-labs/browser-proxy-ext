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

## Install and run locally

```sh
bun install
make check
make build
```

In Microsoft Edge, open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository directory. Open the extension's **Details → Extension options** and provision the same shared secret as the local daemon. The default local endpoint is `ws://127.0.0.1:8765/v1/extension`.

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
