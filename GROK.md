# GROK.md — Life HQ public site contract

Read this before changing this repo. The private repo `rav-pawar/life-hq-private` is the canonical
copy of the tools, plaintext data, secrets, docs and the Android app. This repo is only the public
site served by GitHub Pages.

## What is here

- `index.html`, `styles.css`, `app.js`, `logic.js`, `crypto.js`, `db.js`, `sw.js`, `config.js`
- `manifest.webmanifest`, `icons/`, `privacy.html`
- `data.enc.json` — ciphertext only; v2 per-device ECDH envelope
- `tests/smoke.mjs` — dependency-free public-site invariants
- `.nojekyll` — serve files verbatim (needed for dot directories such as `.well-known` on a user site)

## Rules

1. **No plaintext personal data.** Never add `data.json`, `devices*.json`, `vapid*`,
   `subscriptions*`, `box-key*`, `inbox-token*`, `notify-state.json`, `*.pem`, `.env*`, private keys
   or push endpoints. The private repo's safety check blocks these; do not bypass it.
2. **Publish from the private repo** with `tools/publish.sh`. It encrypts, runs
   `tests/smoke.mjs`, safety-checks, pushes this repo and backs up the private one.
3. **Keep the CSP strict.** No inline scripts or styles. `script-src 'self'`, `style-src 'self'`,
   `default-src 'self'`, `connect-src 'self' https://api.github.com`, `worker-src 'self'`,
   `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. If you change the CSP, update the
   smoke test deliberately, not to make a failure disappear.
4. **Site versioning:** every site change bumps `sw.js` `CACHE` and `app.js` `APP_VERSION` together.
   GitHub Pages caches for up to 10 minutes; the service worker fetches the shell with a cache
   buster, so a missing bump leaves installed PWAs on old code.
5. **`data.enc.json` stays v2.** `v:2`, `alg:ECDH-P256+HKDF-SHA256+A256GCM`, recipients with exactly
   `kid, epk, salt, iv, wrapped`, no `kdf`/password fields. The smoke test enforces the shape. The
   private `tools/encrypt.js` is the only writer.
6. **No secrets in `config.js`.** It contains only the public VAPID key, the box public inbox key, the
   inbox repo name and the data URL.
7. **Alert history is IndexedDB.** Web Push is handled by `sw.js`, which writes each alert with
   `HQDB.putAlert` before showing it. Do not replace Web Push with a native channel without feeding
   the Alerts tab; the Android app deliberately keeps the TWA/Web Push path.
8. **Android app:** it lives in the private repo's `android/` folder. It is a TWA plus a native
   widget; no Android code belongs here. TWA assetlinks must be at the **origin root**
   `https://rav-pawar.github.io/.well-known/assetlinks.json` — this repo's Pages root is
   `/life-hq/`, so it cannot serve that file. The root file lives in `rav-pawar/rav-pawar.github.io`.
9. **Tests:** `node tests/smoke.mjs` must pass. For Android/data changes also run the checks in the
   private repo (`node tools/test-android-vector.js`, the Gradle unit tests).

## Common commands

```bash
node tests/smoke.mjs
git status --short
```

Publishing happens in the private repo:

```bash
cd ../life-hq-private
tools/publish.sh
```

## What not to "fix"

- Do not add a password/KDF recipient to the envelope.
- Do not move `data.enc.json` into a subdirectory or change its name; the app and service worker
  expect `./data.enc.json`.
- Do not remove the `#s-...` section anchors; the Android widget deep-links to them.
- Do not loosen the CSP to load remote fonts, CDNs or analytics. The site is intentionally
  self-contained.
- Do not put the TWA assetlinks file at `/life-hq/.well-known/`; Chrome checks the origin root.
