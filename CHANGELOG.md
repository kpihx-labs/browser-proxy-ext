# Changelog

All notable changes are documented here.

## 0.2.0 — 2026-08-29

- **Fixed approval overlays silently failing whenever the active tab is this extension's OWN
  Options page (or any `edge://` page)**: root-caused live — 4 consecutive `group-create` approval
  requests were rejected instantly with zero human interaction while the "Browser Proxy Bridge
  settings" tab happened to be active; `getActiveTabId()` only ever looked at the active tab of the
  last-focused window, and `chrome.tabs.sendMessage` to an extension page or `edge://` page silently
  fails (manifest `content_scripts.matches` never targets either), which `requestApproval()`
  reported as a generic "Failed to show approval UI" — the daemon side then surfaced this
  indistinguishably from a genuine human "Deny." New `isApprovableUrl()` gate: `getActiveTabId()`
  now falls back to the first `http(s)` tab in the same window whenever the active tab cannot host
  the overlay. As a further, KπX-requested last resort — when NO `http(s)` tab exists anywhere in
  the window at all — `requestApproval()` now creates a real temporary tab
  (`createTemporaryApprovalTab()`, `https://example.com/`, never focused) purely to host the
  overlay, and always closes it again the instant the approval settles: on an explicit decision
  (`handleApprovalResponse`) or, new, on a timeout with no answer at all (`expireApprovalIfStillPending`,
  a `setTimeout` now scheduled per pending approval — previously nothing ever proactively expired a
  request that never received a reply). **Second root cause found live in the same investigation**:
  a found candidate tab (active or fallback) can still fail delivery for an unrelated reason — most
  concretely, right after THIS extension itself reloads, every PREVIOUSLY-open tab's content script
  is orphaned (a fresh background service worker cannot message a stale one), so
  `chrome.tabs.sendMessage` silently fails even to an otherwise perfectly normal, currently-open
  `http(s)` tab. `requestApproval()` now ALWAYS retries once via a brand-new temporary tab whenever
  the first delivery attempt fails for any reason, not only when no candidate existed at all. 4 new
  regression tests (temporary-tab creation, retry-after-stale-content-script, cleanup on approval,
  cleanup on timeout).
- **Fixed the extension never declaring which profile it belongs to** (paired daemon-side fix:
  3 profiles used to return the byte-identical bookmark tree because the daemon had only one global
  connection slot and this extension gave it nothing to key on). Options page (`options.html`) gained
  a **Browser-proxy profile** field (defaults to `default`, pre-filled from storage on reopen),
  saved together with the shared secret so neither can be half-configured. New `browserProxyProfile`
  storage key, `loadProfile()` (defaults to `"default"` when unset — Chrome extensions have no API
  to discover which `--user-data-dir` they run inside, so this can only be a human-declared value).
  `ClientMessage`'s handshake variant (`protocol.ts`) gained a required `profile: string` field,
  sent by `onSocketOpen()` on every connection attempt.
- **Fixed reconnection silently dying on Manifest V3 service-worker eviction:** `scheduleReconnect()`'s
  `setTimeout` is discarded by Chromium if the service worker is evicted (idle eviction can happen
  within ~30s) before the timer fires. Any daemon downtime longer than that (e.g. its own idle-TTL
  self-stop) could permanently strand the extension with zero live reconnect attempt until an
  unrelated browser event happened to wake the worker again. Added a `chrome.alarms`-based watchdog
  (new `"alarms"` permission; `RECONNECT_ALARM_NAME` fired every `RECONNECT_ALARM_PERIOD_MINUTES`
  = 30s) registered synchronously at module load, same pattern as the pre-existing
  `chrome.runtime.onMessage` listener — Chromium always redelivers alarms by waking the worker,
  guaranteeing eventual reconnection. `setTimeout`-based `scheduleReconnect()` remains as a
  fast-path optimization for quick recovery while the worker is still warm, no longer the sole
  mechanism.
- Fixed the approval-overlay message-shape mismatch: `background.ts` now sends `{type:"showApproval", requestId, scopes}`, matching `content.ts`'s existing (redaction-safe) validator exactly, and the reverse `approvalResponse` reply now also uses `requestId` consistently on both sides (the old code sent `requestId` from content.ts but validated `id` in background.ts, so approvals could never round-trip either).
- Implemented real `chrome.*` handlers for `bookmark.list`/`bookmark.create`/`bookmark.remove` and `group.list`/`group.create`/`group.update`/`group.move` (previously stubs: `bookmark.list` was hardcoded to `{bookmarks: []}`, and every other kind fell through to an approval that never performed any actual browser operation).
- Added 7 new HITL kinds: `user.ask`, `overlay.dismiss`, `captcha.solve`, `form.set_date`, `form.set_combobox`, `form.drop_file`, `tab.capture_next`.
- Added `src/messages.ts`: the internal, typed `chrome.runtime` messaging contract between `background.ts` and `content.ts` (distinct from the public daemon protocol in `protocol.ts`/`CONTRACT.md`), with builders + fail-closed validators for every command/reply pair.
- Added content-script DOM heuristics for overlay dismissal, best-effort same-origin captcha detection/click, native date-field assignment, combobox type-and-select, and synthetic drag-and-drop file upload — all routed through the existing content script (no new `scripting`/`host_permissions` needed).
- Used the real `chrome.tabGroups.move(groupId, {windowId, index})` API for `group.move`, which preserves the group's id/title/color across windows (avoids the `chrome.tabs.move` "does not preserve groups" caveat entirely).
- Documented why `crypto.ts`'s HMAC proof stays unwired from the handshake (protocol mismatch with the current Python daemon; needs a coordinated cross-repo change) via a `TODO` comment in `background.ts`.

## 0.1.0 — 2026-08-21

- Initial Microsoft Edge-only Manifest V3 extension.
- Added typed, authenticated, fail-closed local WebSocket bridge.
- Added bookmark/tab/tab-group snapshots, clearly non-authoritative workspace hints, and isolated approval overlay.
