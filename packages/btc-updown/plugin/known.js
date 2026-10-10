// WHAT A CLIENT LISTS OF BITCOIN UP OR DOWN ON TESTNET4 (kanban #293): its signed manifest and the one network it is pinned
// for - testnet4 (an attested market pinned for one network is refused on any other; the regtest test market stays regtest's).
//   node packages/arena-protocol/tools/known-games.js packages/btc-updown/plugin/known.js
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { UPDOWN_TN4_MANIFEST_HEX } from './updown-tn4-manifest.js';

export const KNOWN_GAME = Object.freeze({ manifestHex: UPDOWN_TN4_MANIFEST_HEX, sharedWorld: [], networks: [toHex(NETWORK_ID_TESTNET4)] });
