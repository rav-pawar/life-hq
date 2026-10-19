'use strict';
// Where things live. Code is in the repo; private data and secrets are OUTSIDE it.
//   LIFE_HQ_DATA     plaintext data file   (default /home/box/life-hq-data/data.json)
//   LIFE_HQ_SECRETS  secrets folder        (default /home/box/.life-hq)  vapid.json, subscriptions.json, devices.json, notify-state.json
//   LIFE_HQ_REPO     repo root             (default: the folder above tools/)
const path = require('path');
const REPO = path.resolve(process.env.LIFE_HQ_REPO || path.join(__dirname, '..'));
const DATA = path.resolve(process.env.LIFE_HQ_DATA || '/home/box/life-hq-data/data.json');
const SECRETS = path.resolve(process.env.LIFE_HQ_SECRETS || process.env.IMP_ALERTS_DIR || '/home/box/.life-hq');
module.exports = {
  REPO, DATA, SECRETS,
  ENC: path.join(REPO, 'data.enc.json'),
  VAPID_FILE: path.join(SECRETS, 'vapid.json'),
  SUBS_FILE: path.join(SECRETS, 'subscriptions.json'),
  DEVICES_FILE: path.join(SECRETS, 'devices.json'),
  STATE_FILE: path.join(SECRETS, 'notify-state.json'),
  ALLOW_FILE: path.join(SECRETS, 'safety-allow.txt')
};
