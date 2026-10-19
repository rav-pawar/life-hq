/* Life HQ v2 decryption (WebCrypto), per-device public-key encryption.
   Envelope written by tools/encrypt.js:
     {v:2, alg:'ECDH-P256+HKDF-SHA256+A256GCM', recipients:[{kid, epk, salt, iv, wrapped}], iv, ct}
   - Each device owns an ECDH P-256 key pair created here; the PRIVATE key is non-extractable and lives only in
     this browser's IndexedDB (it can be used, never read or exported). Only the public key is shown for enrollment.
   - kid = base64url(SHA-256(raw uncompressed public point))[first 12 bytes] : identifies the device, no names.
   - Per recipient: Z = ECDH(device private, epk); KEK = HKDF-SHA256(Z, salt, 'life-hq v2 dek-wrap' || kid);
     DEK = AES-256-GCM-unwrap(KEK, iv, wrapped). Data = AES-256-GCM-decrypt(DEK, env.iv, env.ct).
   There is no password and no password-derived key anywhere. */
(function (g) {
  'use strict';
  const ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';
  const INFO = 'life-hq v2 dek-wrap';
  const te = new TextEncoder();
  const subtle = () => g.crypto.subtle;

  // Accepts standard base64 or base64url, with or without padding.
  function b64ToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  }
  function bytesToB64url(b) {
    let s = '';
    new Uint8Array(b).forEach(x => { s += String.fromCharCode(x); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Same computation as tools/v2-crypto.js kidFromJwk().
  async function kidFromJwk(jwk) {
    const raw = concat(new Uint8Array([4]), b64ToBytes(jwk.x), b64ToBytes(jwk.y));
    if (raw.length !== 65) throw new Error('bad P-256 public key');
    const h = new Uint8Array(await subtle().digest('SHA-256', raw));
    return bytesToB64url(h.slice(0, 12));
  }

  // Creates a new device key pair. privateKey: extractable=false (WebCrypto always leaves the public half exportable).
  async function createDeviceKey() {
    const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
    if (kp.privateKey.extractable) throw new Error('private key unexpectedly extractable');
    const full = await subtle().exportKey('jwk', kp.publicKey);
    const publicJwk = { kty: 'EC', crv: 'P-256', x: full.x, y: full.y };
    return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicJwk, kid: await kidFromJwk(publicJwk), createdAt: Date.now() };
  }

  function validate(env) {
    if (!env || typeof env !== 'object') throw new Error('Unsupported encrypted data format');
    if (env.v === 1) { const e = new Error('FORMAT_V1'); e.code = 'FORMAT_V1'; throw e; }
    if (env.v !== 2 || env.alg !== ALG || !Array.isArray(env.recipients) || !env.iv || !env.ct) throw new Error('Unsupported encrypted data format');
  }

  // Throws Error with .code: FORMAT_V1 | NOT_RECIPIENT | DECRYPT_FAILED.
  async function decryptForDevice(env, dev) {
    validate(env);
    const r = env.recipients.find(x => x && x.kid === dev.kid);
    if (!r) { const e = new Error('NOT_RECIPIENT'); e.code = 'NOT_RECIPIENT'; throw e; }
    try {
      const epk = await subtle().importKey('raw', b64ToBytes(r.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const z = await subtle().deriveBits({ name: 'ECDH', public: epk }, dev.privateKey, 256);
      const ikm = await subtle().importKey('raw', z, 'HKDF', false, ['deriveKey']);
      const kek = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: b64ToBytes(r.salt), info: concat(te.encode(INFO), te.encode(dev.kid)) },
        ikm, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
      const dek = await subtle().unwrapKey('raw', b64ToBytes(r.wrapped), kek, { name: 'AES-GCM', iv: b64ToBytes(r.iv), tagLength: 128 },
        { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const buf = await subtle().decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv), tagLength: 128 }, dek, b64ToBytes(env.ct));
      return JSON.parse(new TextDecoder().decode(buf));
    } catch (e) {
      const err = new Error('DECRYPT_FAILED'); err.code = 'DECRYPT_FAILED'; err.cause = e; throw err;
    }
  }

  // Sync-back (device -> box): encrypt a JSON object to the box public key (config.js inboxPublicKey).
  //   Z1 = ECDH(ephemeral, box), Z2 = ECDH(this device's private key, box)  (Z2 lets the box verify the enrolled sender)
  //   K = HKDF-SHA256(Z1 || Z2, salt, 'life-hq v2 inbox' || box kid);  ct = AES-256-GCM(K, iv, JSON, AAD 'lhq-inbox|boxKid|deviceKid')
  // Same as tools/v2-crypto.js encryptInbox / decryptInbox. Output is ciphertext only.
  const INBOX_ALG = 'ECDH-ES+S-P256+HKDF-SHA256+A256GCM';
  const INBOX_INFO = 'life-hq v2 inbox';
  async function encryptForBox(obj, boxJwk, dev) {
    const P256 = { name: 'ECDH', namedCurve: 'P-256' };
    const boxKid = await kidFromJwk(boxJwk);
    const boxPub = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: boxJwk.x, y: boxJwk.y }, P256, false, []);
    const eph = await subtle().generateKey(P256, false, ['deriveBits']);
    const z1 = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: boxPub }, eph.privateKey, 256));
    const z2 = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: boxPub }, dev.privateKey, 256));
    const salt = g.crypto.getRandomValues(new Uint8Array(16)), iv = g.crypto.getRandomValues(new Uint8Array(12));
    const ikm = await subtle().importKey('raw', concat(z1, z2), 'HKDF', false, ['deriveKey']);
    const key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: concat(te.encode(INBOX_INFO), te.encode(boxKid)) },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('lhq-inbox|' + boxKid + '|' + dev.kid), tagLength: 128 },
      key, te.encode(JSON.stringify(obj)));
    const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
    return { v: 2, t: 'lhq-inbox', alg: INBOX_ALG, kid: boxKid, from: dev.kid, epk: b64(await subtle().exportKey('raw', eph.publicKey)),
      salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  // Device-local secret sealing (the sync token): AES-256-GCM with a NON-extractable key kept in IndexedDB.
  // Best effort: it keeps the token out of plaintext storage; code running in this origin can still use the key.
  async function newSealKey() { return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  async function seal(key, text) {
    const iv = g.crypto.getRandomValues(new Uint8Array(12));
    return { iv, ct: new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, te.encode(text))) };
  }
  async function unseal(key, box) { return new TextDecoder().decode(await subtle().decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.ct)); }

  g.LifeCrypto = { ALG, createDeviceKey, kidFromJwk, decryptForDevice, encryptForBox, newSealKey, seal, unseal };
})(self);
