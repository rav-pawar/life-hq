'use strict';
/*
 Life HQ v2 envelope (shared by encrypt.js and enroll.js). Node built-in WebCrypto only; interoperates with
 the browser code in ../crypto.js.
   DEK  = fresh random AES-256 key per publish;  ct = AES-256-GCM(DEK, iv[12], data)        (ct includes 16-byte tag)
   per device (ECIES): ephemeral P-256 key pair e;  Z = ECDH(e.priv, device.pub)  (32 bytes)
                       KEK = HKDF-SHA256(IKM=Z, salt=random 16, info='life-hq v2 dek-wrap' || kid) -> 256 bits
                       wrapped = AES-256-GCM(KEK, iv[12], raw DEK)
   kid = base64url(SHA-256(0x04 || x || y))[first 12 bytes]  (16 chars; no names in public)
*/
const { webcrypto } = require('crypto');
const subtle = webcrypto.subtle;

const ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';
const INFO = 'life-hq v2 dek-wrap';
const P256 = { name: 'ECDH', namedCurve: 'P-256' };

const b64 = b => Buffer.from(b).toString('base64');
const fromB64 = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64url = b => Buffer.from(b).toString('base64url');

// P-256 domain parameters, for an explicit on-curve check (in addition to WebCrypto's own import validation).
const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const bCoef = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const toBig = buf => BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
const mod = (a, m) => ((a % m) + m) % m;
function onCurve(xBuf, yBuf) {
  const x = toBig(xBuf), y = toBig(yBuf);
  if (x >= p || y >= p) return false;
  return mod(y * y, p) === mod(x * x * x - 3n * x + bCoef, p);
}

function rawFromJwk(jwk) {
  const x = fromB64(jwk.x), y = fromB64(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('x and y must be 32 bytes each');
  return Buffer.concat([Buffer.from([4]), x, y]);
}
async function kidFromJwk(jwk) {
  const h = Buffer.from(await subtle.digest('SHA-256', rawFromJwk(jwk)));
  return b64url(h.subarray(0, 12));
}
// Throws if not a valid P-256 public key. Returns the clean JWK {kty, crv, x, y}.
async function validatePublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') throw new Error('public key must be a JWK object');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('public key must be kty EC, crv P-256');
  if (jwk.d) throw new Error('that JWK contains a PRIVATE key (d). Never paste private keys; send only the public key');
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jwk.x + jwk.y)) throw new Error('x / y must be base64url strings');
  const raw = rawFromJwk(jwk);
  if (!onCurve(raw.subarray(1, 33), raw.subarray(33))) throw new Error('point is not on the P-256 curve');
  const clean = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  await subtle.importKey('jwk', clean, P256, true, []); // WebCrypto's own validation
  return clean;
}

async function wrapFor(dek, device) {
  const kid = await kidFromJwk(device.publicKeyJwk);
  const pub = await subtle.importKey('jwk', device.publicKeyJwk, P256, false, []);
  const eph = await subtle.generateKey(P256, true, ['deriveBits']);
  const z = await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const ikm = await subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
  const kek = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: Buffer.concat([Buffer.from(INFO), Buffer.from(kid)]) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrapped = await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, tagLength: 128 });
  const epk = await subtle.exportKey('raw', eph.publicKey); // 65-byte uncompressed point
  return { kid, epk: b64(epk), salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped) };
}

async function encryptEnvelope(plainBytes, devices) {
  if (!devices || !devices.length) throw new Error('no enrolled devices');
  const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, dek, plainBytes);
  const recipients = [];
  for (const d of devices) recipients.push(await wrapFor(dek, d));
  return { v: 2, alg: ALG, recipients, iv: b64(iv), ct: b64(ct) };
}

// Test helper (the box never holds device private keys; used only by self-tests with throwaway keys).
async function decryptEnvelope(env, privateKey, kid) {
  const r = env.recipients.find(x => x.kid === kid);
  if (!r) throw new Error('NOT_RECIPIENT');
  const epk = await subtle.importKey('raw', fromB64(r.epk), P256, false, []);
  const z = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
  const ikm = await subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
  const kek = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fromB64(r.salt), info: Buffer.concat([Buffer.from(INFO), Buffer.from(kid)]) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
  const dek = await subtle.unwrapKey('raw', fromB64(r.wrapped), kek, { name: 'AES-GCM', iv: fromB64(r.iv) }, { name: 'AES-GCM' }, false, ['decrypt']);
  return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, dek, fromB64(env.ct)));
}

module.exports = { ALG, INFO, kidFromJwk, validatePublicJwk, encryptEnvelope, decryptEnvelope, onCurve };
