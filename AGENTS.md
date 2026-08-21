# Agent instructions

This repository is an independent Microsoft Edge-only Manifest V3 extension.

- Keep all implementation in TypeScript and use Bun for installation, build, tests, and checks.
- Do not describe, distribute, or claim compatibility with any non-Edge browser or store.
- The public bridge protocol is defined solely in `CONTRACT.md` and `src/protocol.ts`; validate every inbound message and fail closed.
- Secrets may be read only by the background worker from extension storage. Never place them in page DOM, content-script messages, logs, errors, snapshots, or protocol payloads.
- Any user-visible action requested by the daemon requires a local approval overlay. The overlay gets a redacted request only.
- Preserve the explicit heuristic status of Edge Workspace metadata: there is no official Workspace API exposed to this extension.
- Document every TypeScript function with purpose, arguments, return value, and at least two concrete examples.
