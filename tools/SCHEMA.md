# Life HQ data file schema (data v1, envelope v2)

The plaintext data file (`$LIFE_HQ_DATA`, default `/home/box/life-hq-data/data.json`) is **private** and never
committed. `tools/encrypt.js` turns it into `data.enc.json`. Examples below use made-up values.

All dates are `YYYY-MM-DD` in IST; times are 24-hour `HH:MM` IST.

```jsonc
{
  "schemaVersion": 1,                       // required
  "updatedAt": "2026-01-01T09:00:00+05:30", // ISO; device taps older than this are treated as merged
  "settings": {
    "cardAlertDays": 5,          // card/bill alerts start this many days before the due date (and while overdue)
    "dailyAlertTime": "09:00",   // earliest time for money / supplies pushes
    "leaveWindowMinutes": 7,     // school leave pushes fire within ± this of leaveAt
    "supplyLowLeadDays": 3,      // 'running low soon' = lastBought + intervalDays - this
    "maintenanceWeekend": { "anchorSaturday": "2026-01-03", "everyDays": 14, "lookaheadDays": 14, "alertTime": "08:30" }
  },
  "money": {
    "cards": [ { "id": "card-example", "label": "Example Bank card", "last4": "1234", "amount": 1234.5,
                 "currency": "INR", "dueDate": "2026-01-15", "status": "unpaid",   // unpaid | paid
                 "pushLabel": "Example card",   // generic name used in push text (no digits, no amount)
                 "paidOn": null } ],             // set by merge-changes
    "bills": [ { "id": "bill-example", "label": "Electricity", "amount": 900, "dueDate": "2026-01-20",
                 "status": "unpaid", "pushLabel": "Electricity bill" } ]
  },
  "school": {
    "days": [1, 2, 3, 4, 5],     // 0 = Sunday … 6 = Saturday
    "holidays": ["2026-01-26"],  // no school-run reminders on these dates
    "runs": [ { "id": "run-am", "label": "Morning drop", "leaveAt": "09:15", "eventAt": null },
              { "id": "run-noon", "label": "Noon collect",  "leaveAt": "12:20", "eventAt": "12:30" } ]
  },
  "charging": {
    "defaultReminderTime": "21:30",
    "devices": [ { "id": "chg-example", "name": "Example watch", "icon": "⌚", "reminderTime": "21:30", "lastCharged": null } ]
  },
  "maintenance": {
    "appliances": [ { "id": "example-appliance", "name": "Example appliance",
      "tasks": [ { "id": "ex-filter", "name": "Clean filter", "everyDays": 14, "lastDone": null } ] } ]
      // nextDue = lastDone + everyDays; lastDone null (unknown) = due at the next maintenance weekend
  },
  "supplies": {
    "note": "free text shown nowhere in push",
    "items": [ { "id": "sup-example", "name": "Example refill", "intervalDays": 30, "intervalEstimated": true,
                 "lastBought": "2026-01-01", "quantity": "1 pack", "store": "Amazon", // Amazon | Flipkart
                 "link": null, "status": "ok" } ]  // ok | low | out
  }
}
```

Rules

- `id`s must be unique and stable: device taps and push dedupe are keyed by them.
- Keep `pushLabel`, device names, task names and supply names free of amounts and account digits: they can
  appear in push notifications. Amounts and `last4` appear only inside the decrypted dashboard.
- Bump `updatedAt` on every edit (`merge-changes.js` does it).

Encrypted envelope (`data.enc.json`, public), **v2** (per-device public-key encryption):

```jsonc
{ "v": 2, "alg": "ECDH-P256+HKDF-SHA256+A256GCM",
  "recipients": [ { "kid": "<16 chars>",            // base64url(SHA-256(0x04||x||y))[0..12 bytes] of the device public key
                    "epk": "<65 bytes b64>",         // ephemeral P-256 public key (raw, uncompressed)
                    "salt": "<16 bytes b64>",        // HKDF salt
                    "iv": "<12 bytes b64>",          // IV for wrapping the DEK
                    "wrapped": "<48 bytes b64>" } ], // AES-256-GCM(KEK, DEK) incl. 16-byte tag
  "iv": "<12 bytes b64>", "ct": "<ciphertext+tag b64>" } // AES-256-GCM(DEK, JSON of the data file)
```

KEK = HKDF-SHA256(IKM = ECDH(ephemeral private, device public) 32 bytes, salt, info = UTF-8 `life-hq v2 dek-wrap` ||
UTF-8 kid), 256 bits. The DEK is fresh random every publish. No password or KDF recipient is ever included (the
safety check refuses one). The old v1 format `{v:1, kdf:'PBKDF2-SHA256', iter, salt, iv, ct}` is no longer read;
the app shows a “data format upgraded” message for it.

Device registry (`<secrets>/devices.json`, private, never committed; written by `tools/enroll.js`):

```json
[ { "id": "<kid>", "name": "Pixel phone", "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
    "addedAt": "2026-10-19T05:00:00.000Z", "updatedAt": "…(optional)" } ]
```

Enrollment code (from the app, input to `enroll.js`):

```json
{ "lifeHqEnroll": 2, "deviceName": "Pixel phone", "devicePublicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "kid": "<16 chars>", "pushSubscription": { "endpoint": "https://…", "expirationTime": null, "keys": { "p256dh": "…", "auth": "…" } } }
```

`pushSubscription` may be `null`. Subscriptions added this way carry `deviceId`/`deviceName` in `subscriptions.json`.

Changes-to-sync export (from the app, input to `merge-changes.js`):

```json
{ "lifeHqChanges": 1, "exportedAt": "…", "baseUpdatedAt": "…", "changes": [
  { "type": "maintenance.done", "id": "ex-filter", "date": "2026-01-10", "at": "…" },
  { "type": "supply.update", "id": "sup-example", "status": "low", "at": "…" },
  { "type": "supply.update", "id": "sup-example", "status": "ok", "lastBought": "2026-01-10", "at": "…" },
  { "type": "card.status", "id": "card-example", "status": "paid", "date": "2026-01-12", "at": "…" },
  { "type": "charging.charged", "id": "chg-example", "date": "2026-01-10", "at": "…" } ] }
```
