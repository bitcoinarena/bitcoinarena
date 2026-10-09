// ROCK PAPER SCISSORS AS A PLUGIN (kanban #233): the registration a node's launcher hands serve() (ARENA_GAMES) - the signed
// manifest, its id, the decide adapter installed as its one core (checked against the manifest by hash), and the game's name
// and donation set. The engine imports none of this; it reads the game through its manifest and the adapter it is handed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DECIDE } from './decide.js';
import { RPS_MANIFEST_HEX } from './rps-manifest.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
export const RPS_MANIFEST = decodeManifest(fromHex(RPS_MANIFEST_HEX));
export const RPS_GAME_ID = gameIdOf(RPS_MANIFEST);
const DECIDE_URL = new URL('./decide.js', import.meta.url);
export const RPS_DECIDE_CORE = Object.freeze({ name: DECIDE.name, hash: sha(readFileSync(DECIDE_URL)), url: DECIDE_URL.href, adapter: DECIDE,
  configs: new Map([[sha('rock-paper-scissors-config:v1'), {}]]) });
export const RPS_CLIENT_FILE = new URL('../client/index.html', import.meta.url);

export const ROCK_PAPER_SCISSORS = Object.freeze({ name: 'rock-paper-scissors', manifest: RPS_MANIFEST, gameId: RPS_GAME_ID,
  cores: new Map([[RPS_DECIDE_CORE.hash, RPS_DECIDE_CORE]]), title: 'Rock Paper Scissors',
  donationSet: TESTNET4_DONATION_SET_KEYS.recipients });

/** What a launcher loads from this module (ARENA_GAMES): the registration. */
export const GAME = ROCK_PAPER_SCISSORS;
