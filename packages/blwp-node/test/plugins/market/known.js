// The regtest market's entry for the client's known-games list (protocol/tools/known-games.js): its signed manifest, and the
// one network it is pinned for - regtest. Its attestors' keys come from public test words; pinned anywhere else, anybody
// could attest its outcome.
import { encodeManifest } from '../../../../protocol/src/manifest.js';
import { toHex } from '../../../../protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../../../protocol/src/genesis-ids.js';
import { MARKET } from './index.js';

export const KNOWN_GAME = Object.freeze({ manifestHex: toHex(encodeManifest(MARKET.registration.manifest)), sharedWorld: [], networks: [toHex(NETWORK_ID_REGTEST)] });
