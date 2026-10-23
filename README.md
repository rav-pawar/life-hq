# Life HQ (public site)

The installable Life HQ dashboard, served by GitHub Pages at:

**https://rav-pawar.github.io/life-hq/**

The site is public, but all personal data is encrypted before it reaches this repo. The browser
holds a per-device ECDH P-256 private key in IndexedDB and decrypts `data.enc.json` locally. There is
no password. The private repo (`rav-pawar/life-hq-private`) holds the plaintext data, tools and
secrets; this repo only holds the runtime, icons, tests and the encrypted envelope.

## Files

```text
index.html styles.css app.js logic.js crypto.js db.js sw.js config.js
manifest.webmanifest icons/ privacy.html data.enc.json .nojekyll
tests/smoke.mjs
```

- `data.enc.json` is a v2 envelope (`v:2`, `kid/epk/salt/iv/wrapped` recipients, AES-GCM payload).
  It is the only personal-data file here, and it is ciphertext.
- `config.js` contains only the public VAPID key, the public inbox key and the inbox repo name.
- The CSP is strict and has no inline scripts/styles. `connect-src` allows only the site and
  `https://api.github.com` for the sync-back inbox.
- `sw.js` handles Web Push, the alert history in IndexedDB and the offline shell. Bump `CACHE`
  whenever the shell changes; keep `APP_VERSION` in `app.js` in step.

## Test

```bash
node tests/smoke.mjs
```

The smoke test checks the CSP, manifest, section anchors, v2 envelope shape, service worker hooks and
that no private-looking files were committed. It has no dependencies. `tools/publish.sh` in the
private repo runs it before every publish.

## Android app

The native Android app (TWA + home-screen widget) lives in the private repo under `android/`. It
opens this site in a Trusted Web Activity and reads the same `data.enc.json` with its own enrolled
widget key. No Android code or personal data belongs in this repo.

TWA verification requires `https://rav-pawar.github.io/.well-known/assetlinks.json` — the **origin
root**, not a path inside this repo. That file lives in the small public `rav-pawar.github.io`
user-site repo; the `life-hq` repo cannot serve it because its Pages root is `/life-hq/`.

## Do not commit

Plaintext data (`data.json`), `devices*.json`, `vapid*`, `subscriptions*`, `box-key*`,
`inbox-token*`, `notify-state.json`, `*.pem`, `.env*` or any private value. The private repo's safety
check blocks these; do not bypass it. Publish via the private repo's `tools/publish.sh`.
