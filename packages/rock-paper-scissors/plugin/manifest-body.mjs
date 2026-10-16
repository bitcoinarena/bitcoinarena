// ROCK PAPER SCISSORS' MANIFEST BODY (kanban #233), as its developer signs it with the dev client:
//   node packages/arena-donor/bin/arena-donor.mjs sign ~/.config/blwp/rps-dev packages/rock-paper-scissors/plugin/manifest-body.mjs
// Its decide adapter (decide.js) and its client (../client/index.html) are named by their SHA-256, so a node installs only
// that adapter for it and the page runs only that client. The developer key is the game's own (db57bd7a…).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';

const sha = (b) => new Uint8Array(createHash('sha256').update(b).digest());
export const RPS_DECIDE_HASH = sha(readFileSync(new URL('./decide.js', import.meta.url)));
export const RPS_CONFIG_HASH = sha('rock-paper-scissors-config:v1');
export const RPS_CLIENT_HASH = sha(readFileSync(new URL('../client/index-v2.html', import.meta.url)));   // versions 1 and 2's bytes (kanban #396 keeps them there)
export const RPS_DEV_PUBKEY = fromHex('db57bd7ad41ef92d72fb53a6d4bf5f4b614150fadeedf5430be1af7814091dab');

export const BODY = {
  gameName: 'rock-paper-scissors', gameDevPubkey: RPS_DEV_PUBKEY, version: 1, parentManifestId: NO_PARENT,
  resultType: RESULT_TYPE.HEAD_TO_HEAD,
  cores: [{ hash: RPS_DECIDE_HASH, configs: [RPS_CONFIG_HASH] }], runTicksMax: 0, roundPeriodMs: 0n,
  payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 2,
  clients: [RPS_CLIENT_HASH],
  // its developer's donation set: the testnet4 key set, as nextblock's on this network
  gameDonationSetId: donationSetId(TESTNET4_DONATION_SET_KEYS.recipients),
  players: 2, moveCount: 3, revealWindowMs: 120000n,
};
