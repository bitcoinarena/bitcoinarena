// ROCK PAPER SCISSORS AS A PLUGIN (kanban #233): the registration a node's launcher hands serve() (ARENA_GAMES) - the signed
// manifest, its id, the decide adapter installed as its one core (checked against the manifest by hash), and the game's name
// and donation set. The engine imports none of this; it reads the game through its manifest and the adapter it is handed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { RPS_MANIFEST_HEX } from './rps-manifest.js';
import { fromHex, toHex } from 'arena-sdk/hash';
import { decodeManifest, gameIdOf } from 'arena-sdk/manifest';
import { TESTNET4_DONATION_SET_KEYS } from 'arena-sdk/testnet4-donation-set-keys';
import { INFO } from './info.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
export const RPS_MANIFEST = decodeManifest(fromHex(RPS_MANIFEST_HEX));
export const RPS_GAME_ID = gameIdOf(RPS_MANIFEST);
const DECIDE_URL = new URL('./decide.js', import.meta.url);
// THE REGISTRATION IMPORTS NO CORE (kanban #328, spec §0A.6): a node loads this module in its own thread, and runs the decide
// adapter only in its sandbox (arena-node/src/core-sandbox.js) from the file DECIDE_URL names, checked against its hash.
// `adapter` is the file imported natively for a player's own use (tests, tools): not enumerable, loaded only when asked for.
const requireCore = createRequire(import.meta.url);
export const RPS_DECIDE_NAME = 'rock-paper-scissors decide v1';
export const RPS_DECIDE_CORE = Object.freeze(Object.defineProperty({ name: RPS_DECIDE_NAME, hash: sha(readFileSync(DECIDE_URL)), url: DECIDE_URL.href,
  configs: new Map([[sha('rock-paper-scissors-config:v1'), {}]]) }, 'adapter', { get: () => requireCore('./decide.js').DECIDE, enumerable: false }));
// THE BYTES VERSIONS 1 AND 2 PIN, kept as client/index-v2.html; client/index.html is version 3's ("← Arena", kanban #396)
export const RPS_CLIENT_FILE = new URL('../client/index-v2.html', import.meta.url);
export const RPS_CLIENT_V3_FILE = new URL('../client/index.html', import.meta.url);

export const ROCK_PAPER_SCISSORS = Object.freeze({ name: 'rock-paper-scissors', manifest: RPS_MANIFEST, gameId: RPS_GAME_ID, info: INFO,
  // its square icon (kanban #338): served at GET /game-icon, shown on the chooser's tile
  icon: new URL('../brand/rps-icon.svg', import.meta.url),
  cores: new Map([[RPS_DECIDE_CORE.hash, RPS_DECIDE_CORE]]), title: 'Rock Paper Scissors',
  donationSet: TESTNET4_DONATION_SET_KEYS.recipients,
  // its client, so the plugin store can hand the game to another seat (kanban #276 step 5)
  clientUrls: [new URL('../client/index-v2.html', import.meta.url).href] });

/** What a launcher loads from this module (ARENA_GAMES): the registration. */
export const GAME = ROCK_PAPER_SCISSORS;
// A ROCK PAPER SCISSORS ROUND'S FIELDS (kanban #292/#293): its game, its decide adapter and config; no run - its 600 ticks and
// 300-tick deadline make the reveal window (entry close to the round's end) about 20 s, inside the game's 120 s. One place for
// the free demo (the Arena's arena-node/tools/rps-demo-regtest.mjs) and the paid regtest stack (run-testnet4-paid.mjs PAID_RPS=1).
export const RPS_ROUND_FIELDS = Object.freeze({ gameId: RPS_GAME_ID, simCoreHash: fromHex(RPS_DECIDE_CORE.hash),
  configHash: fromHex([...RPS_DECIDE_CORE.configs.keys()][0]), blockTicks: 600, startDeadlineTicks: 300, minScore: 2 });
