# Life HQ

A private, installable dashboard (PWA) for Android Chrome, hosted on public GitHub Pages at
`https://rav-pawar.github.io/life-hq/`, plus Web Push alerts so important things are never missed.

**Because the site is public, all personal data is encrypted before it reaches this repo.** Since v2 it is
encrypted with **per-device public keys** (ECDH P-256), like HTTPS key pairs: each enrolled browser holds its own
non-extractable private key, and the public `data.enc.json` can only be opened by those devices. There is no
password, so there is nothing to brute-force.

Sections: 📅 Today · 💳 Money · 🏫 Family / school · 🔌 Charging · 🧰 Home maintenance (with a fortnightly
maintenance weekend) · 🛒 Supplies / pantry · 🚨 Alerts history · 🔄 Changes to sync.

## Layout

```
life-hq/                      (this repo: code + data.enc.json only; canonical copy on the Windows PC,
│                              D:\Downloads\repos\life-hq; the box copy is a synced working clone)
├── index.html styles.css app.js     UI: enroll screen, dashboard, push setup, alert history
├── logic.js                         due-date / maintenance / supplies logic, shared by the app and tools/notify.js
├── crypto.js                        WebCrypto: device key pair + v2 decrypt (ECDH P-256 → HKDF → AES-256-GCM)
├── db.js                            IndexedDB: alerts, device key pair, on-device taps
├── sw.js  config.js  manifest.webmanifest  icons/
├── data.enc.json                    encrypted data (written by tools/encrypt.js; safe to publish)
└── tools/                           code only, no secrets
    ├── encrypt.js       data file → data.enc.json (one recipient per enrolled device)
    ├── enroll.js        add / list / remove devices (devices.json + push subscription)
    ├── v2-crypto.js  devices-lib.js   envelope crypto (Node built-in WebCrypto) and devices.json helpers
    ├── publish.sh       encrypt → safety check → commit → push (if a remote exists)
    ├── safety-check.js  pre-commit leak check (installed by install-hooks.sh)
    ├── notify.js        push sender: `due-check`, direct `--type` sends, `add-sub`
    ├── add-sub.js  merge-changes.js  push-lib.js  paths.js  package.json
    └── SCHEMA.md        data file format
```

Private files live **outside** the repo (never commit them; `.gitignore` also blocks the names):

| What | Env var | Default (box) |
|------|---------|---------------|
| Plaintext data file | `LIFE_HQ_DATA` | `/home/box/life-hq-data/data.json` (folder 700, file 600) |
| Secrets folder: `vapid.json`, `subscriptions.json`, `devices.json` (enrolled device public keys), `notify-state.json` (`kdf.json` is a v1 leftover, unused) | `LIFE_HQ_SECRETS` | `/home/box/.life-hq/` (700) |

On Windows set both, e.g. `set LIFE_HQ_DATA=C:\Users\<you>\life-hq-private\data.json` and
`set LIFE_HQ_SECRETS=C:\Users\<you>\life-hq-private\secrets`, keep that folder out of the repo, and run
`publish.sh` from Git Bash.

## Encryption (v2: per-device public keys)

- **Enrollment (browser).** On first run the app creates an ECDH P-256 key pair with WebCrypto. The private key is
  created with `extractable: false` (usages `deriveBits`/`deriveKey`), stored as a `CryptoKey` in IndexedDB and can
  never be read or exported, not even by the app's own code; the app also calls `navigator.storage.persist()`.
  The **Enroll this device** screen shows a device name field, the key fingerprint and one code to copy:
  `{lifeHqEnroll:2, deviceName, devicePublicKey (JWK), kid, pushSubscription}` (one paste = encryption + push).
- **Enroll (box).** `node tools/enroll.js '<code>'` checks the key (P-256, on the curve, imported with WebCrypto, no
  private part, fingerprint matches), adds/updates `<secrets>/devices.json` and the push subscription, and prints
  the fingerprint. Then publish.
- **Publish (box).** `tools/encrypt.js` makes a fresh random 256-bit data key (DEK) every run and encrypts the
  data with AES-256-GCM (random 12-byte IV). For each device it wraps the DEK with ECIES: ephemeral P-256 key,
  ECDH with the device public key, HKDF-SHA256 (random 16-byte salt, info `'life-hq v2 dek-wrap' || kid`) → 256-bit
  KEK, AES-256-GCM over the DEK. Output: `{v:2, alg, recipients:[{kid, epk, salt, iv, wrapped}], iv, ct}`.
  `kid` is a truncated SHA-256 fingerprint of the public key, so no device names appear in public.
  No password-based recipient exists. Node's built-in `crypto.webcrypto` only.
- **Open (browser).** The app finds its own `kid`, derives the KEK with its private key, unwraps the DEK
  (non-extractable) and decrypts. No prompt. If the device is not a recipient it shows
  *“This device isn't enrolled yet — paste the enrollment code to your assistant”*; if the GCM check fails
  (tampered/corrupted file) nothing is shown. 🔒 **Lock / Forget this device** deletes the key pair: that device
  needs a new key (made on the next start) and re-enrolling.
- Plaintext is kept in memory only. A strict Content-Security-Policy meta tag (`default-src 'self'; connect-src
  'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none';
  form-action 'none'`), no inline scripts or styles, and `referrer: no-referrer`. GitHub Pages cannot set HTTP
  headers, so `frame-ancestors` (meta-unsupported) is not set.

### Threat model

| Attacker | Result |
|---|---|
| Anyone downloading the public `data.enc.json` / git history (v2 files) | Needs a device private key (P-256 ECDH, ~128-bit security). No password exists, so offline guessing is impossible. Sees only: number of devices, opaque 16-char fingerprints, ciphertext size, publish times. |
| Someone who reads the box's `devices.json` | Gets only public keys: cannot decrypt. Could *encrypt* fake data that a device would accept (v2 is encryption, not signing), which is why devices.json is still kept private. |
| Someone who modifies the repo / Pages site | Any bit flip fails AES-GCM, nothing shown. They could serve old (still valid) published files or malicious JavaScript: the site code itself is the trust anchor (protect the GitHub account; review diffs before pushing). |
| Malware / a person with an unlocked enrolled browser profile | Can use the key inside that browser (it cannot be copied out). Use 🔒 Lock / Forget and `enroll.js remove`. |
| Lost or retired device | `node tools/enroll.js remove <name>` then publish: it cannot read anything published afterwards (it keeps whatever it had already downloaded). |
| Old v1 `data.enc.json` still in git history | Still protected only by the v1 password (PBKDF2 600k, 34 chars). Consider the v1 password retired; never reuse it. |

**If a device's browser data is cleared** (Clear site data, uninstalling the PWA, Chrome profile reset, storage
eviction), its private key is gone for good, by design: the data cannot be opened there and nothing is lost on
the box. Open the app again: it makes a new key; paste the new enrollment code, then `enroll.js remove <old id>`
and publish. Keep at least two devices enrolled so one is always usable.

## Commands

```bash
# install deps for the sender once
cd tools && npm install && cd ..
bash tools/install-hooks.sh                       # pre-commit safety check (once per clone)

node tools/enroll.js '<enrollment code from the app>'   # add / update a device (+ its push subscription)
node tools/enroll.js list                          # enrolled devices
node tools/enroll.js remove <id|name>              # remove a device (and its push subscription)
node tools/encrypt.js                              # data file → data.enc.json for all enrolled devices
tools/publish.sh                                   # encrypt, check, commit, push if a remote exists (no password)
tools/publish.sh --dry-run                         # encrypt + check, commit nothing
node tools/safety-check.js                         # run the leak check by hand

node tools/notify.js due-check                     # send what is due now (run every 5–10 min)
LIFE_HQ_NOW=2026-01-03T08:45:00+05:30 node tools/notify.js due-check --dry-run
node tools/notify.js --type urgent --title "Card bill due in 3 days" --body "Open Life HQ for details."
node tools/notify.js add-sub '<subscription json>' # push only (enroll.js already does this)
node tools/merge-changes.js '<changes json from the app>'   # then publish
```

## Push notifications

The lock screen shows push text, so **pushes never include amounts or account numbers**: e.g.
“🚨 Card bill due in 3 days”. `notify.js` refuses text that looks like an amount or account number.
Details live only inside the encrypted dashboard.

The safety check blocks committing `data.json`, `devices*.json`, `kdf.json`, `notify-state.json`, `vapid*`,
`subscriptions*`, `*.pem`, `.env*`, any private value from the data file, the value of `$LIFE_HQ_PASSWORD` (if
set; never printed), and any `data.enc.json` that is not a public-key-only v2 envelope.

`due-check` (IST) sends: school leave reminders (within ±7 minutes of the leave time, school days only),
charging reminders (from each device's reminder time), card/bill dues within 5 days or overdue (from 09:00),
the maintenance-weekend summary (maintenance Saturday morning) and supplies running low. It dedupes per
item per day in `<secrets>/notify-state.json`.

Payload: `{id, type: urgent|summary|info, title, body, items?, ts, url?}`. 🚨 urgent alerts stay on screen
until tapped (`requireInteraction`) and wait under Alerts until **Mark done**; 📋 summaries hold item lists.

## Phone setup (each device)

1. Open the site in **Chrome** on Android → ⋮ → **Install app**, open it from the home screen.
2. ⚙️ / setup card → **Enable notifications**, allow.
3. On **Enroll this device**: type a device name (e.g. “Pixel phone”), tap **Copy**, paste it to the assistant.
4. The assistant runs `enroll.js` and publishes; reopen the app (or **Check again**). No password, ever.
5. Optional: ⚙️ → **Test notification (local)**.

Battery: set Chrome to *Unrestricted* so pushes arrive promptly. If the “subscription changed” banner
appears, use ⚙️ → **Show my enrollment code again** and paste it again (`enroll.js` updates it).

## On-device taps

Done today, Charged ✓, Low / Out / Bought ✓ and Mark paid are stored only on the phone (IndexedDB, layered on
top of the encrypted data). **Changes to sync** shows them as JSON to paste to the assistant, who merges them
with `tools/merge-changes.js` and republishes; taps older than the data's `updatedAt` are then ignored.

## Changing the VAPID key

Put the new public key in `config.js`, bump `CACHE` in `sw.js`, then re-enable notifications and paste the
new enrollment code.
