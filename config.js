// Public configuration. The VAPID *public* key is safe to publish.
// The matching private keys (VAPID, box inbox key) live only on the box, never in this repo.
self.LIFE_HQ_CONFIG = {
  vapidPublicKey: 'BH24n_KSQPijOKSu8Mby0eM6C7cZ-uhIHZemzxfTJyJX8BjDLIPEM_68mo7nFHuyqQMoHqFPQ6gGJPcljhYBzAg',
  dataUrl: './data.enc.json',
  // Sync back: devices encrypt their changes to this box PUBLIC key (private half stays in the private repo) and post
  // them as issues to this private repo. Safe to publish.
  inboxRepo: 'rav-pawar/life-hq-inbox',
  inboxPublicKey: { kty: 'EC', crv: 'P-256', x: 'pwy2_3qKXO1t5YwBQy1Qgr40l2HIg1i0NJSEbJrSydU', y: 'Hi4oE38HP8WxRC_ZfEmWKNKTILWA2aK-dm379H92E3M' },
  inboxKid: 'kiuUV_ujU3HhbxPS'
};
