// BITCOIN UP OR DOWN 15M ON TESTNET4 AS A SEAT HOSTS IT (kanban #293): the registration ARENA_GAMES names (src/main.js reads
// `GAME`) - its signed manifest, no cores (an attested market runs no game code), its developer donation set.
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { UPDOWN_TN4_MANIFEST_HEX } from './updown-tn4-manifest.js';
import { INFO } from './info.js';

export const UPDOWN_TN4_MANIFEST = decodeManifest(fromHex(UPDOWN_TN4_MANIFEST_HEX));
export const UPDOWN_TN4_GAME_ID = gameIdOf(UPDOWN_TN4_MANIFEST);
export const UPDOWN_TN4 = Object.freeze({ name: 'btc-updown-15m', manifest: UPDOWN_TN4_MANIFEST, gameId: UPDOWN_TN4_GAME_ID, info: INFO,
  cores: new Map(), title: 'Bitcoin Up or Down', donationSet: TESTNET4_DONATION_SET_KEYS.recipients,
  // its square icon (kanban #338): served at GET /game-icon, shown on the chooser's tile
  icon: new URL('../brand/updown-icon.svg', import.meta.url) });
export const GAME = UPDOWN_TN4;
