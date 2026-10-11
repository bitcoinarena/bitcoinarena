// HELLO WORLD AS A SEAT HOSTS IT (kanban #276): the registration ARENA_GAMES names (src/main.js reads `GAME`) - its signed
// manifest, no cores (an attested market runs no game code), its developer's donation set, its signed description.
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { HELLO_WORLD_MANIFEST_HEX } from './hello-world-manifest.js';
import { INFO } from './info.js';

export const HELLO_WORLD_MANIFEST = decodeManifest(fromHex(HELLO_WORLD_MANIFEST_HEX));
export const HELLO_WORLD_GAME_ID = gameIdOf(HELLO_WORLD_MANIFEST);
export const HELLO_WORLD = Object.freeze({ name: 'hello-world', manifest: HELLO_WORLD_MANIFEST, gameId: HELLO_WORLD_GAME_ID, info: INFO,
  cores: new Map(), title: 'Hello World', donationSet: TESTNET4_DONATION_SET_KEYS.recipients });
export const GAME = HELLO_WORLD;
