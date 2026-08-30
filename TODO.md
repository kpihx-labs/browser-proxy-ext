# TODO

## Before release

- [ ] Add signed-release packaging and reproducible artifact verification.
- [ ] Add integration tests against the browser-proxyd handshake fixture.
- [ ] Add an accessibility review for the approval overlay (now also renders a `details` field
  list — real proposal fields — inside the closed-shadow-root dialog; screen-reader labeling for
  that list is not yet reviewed).
- [ ] Add configurable, allowlisted local endpoint selection with strict loopback validation.

## Honest scope gaps (documented, not faked)

- [ ] The declared profile name (Options page) is entirely operator-trusted — nothing prevents two
  different Edge windows from accidentally declaring the same profile name (last-connect-wins,
  matching the daemon's pre-existing single-slot recovery semantics). No uniqueness check exists.

- [ ] `form.set_date` / `form.set_combobox` only support native `<input type="date">` and generic `[role=option]`/`li` widgets; MUI/AntD and other custom date-picker/combobox component libraries are not specifically wired and remain unimplemented.
- [ ] `captcha.solve` with `action: "click_grid"` (image-grid captcha solving) is not implemented; it honestly returns `{clicked:false, reason:"grid solving not implemented"}` instead of pretending to solve it.
- [ ] `captcha.solve` with `action: "click_checkbox"` only reaches same-origin captcha iframes; cross-origin click-through requires CDP-level input dispatch (already available via the Python daemon's `page-click` action), not this extension's content-script path.
- [ ] Wiring `crypto.ts`'s HMAC-SHA-256 `createProof()` into the handshake needs a coordinated cross-repo protocol change: the Python daemon's bridge handshake must first send a `{type:"challenge",nonce}` frame before the extension can compute/send a proof instead of the raw shared secret.
