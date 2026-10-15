// __TITLE__: WHAT A NODE LOADS (made from the devnet's game template). A node hosts a game from a module that exports `GAME`,
// named in its ARENA_GAMES - on the devnet, DEVNET_GAMES=<this file> before `devnet.mjs up`. The node checks every piece
// against the signed manifest at start (arena-node/src/plugins.js hostedPlugins): the developer's signature, the core's hash
// and that it loads in its sandbox, each config, and that the donation set hashes to the one the manifest names. A game that
// does not stand is refused and the node says why.
import { readFileSync } from 'node:fs';
import { decodeManifest, gameIdOf } from '__PROTOCOL__/manifest.js';
import { fromHex } from '__PROTOCOL__/hash.js';
import { CORE_HASH, CONFIG, CONFIG_HASH, DONATION_SET } from './body.mjs';

const here = (f) => new URL(f, import.meta.url);
/** The manifest as you signed it (dev/__NAME__-manifest.hex, public bytes only), and its id: what a round of it names. */
export const MANIFEST = decodeManifest(fromHex(readFileSync(here('./dev/__NAME__-manifest.hex'), 'utf8').trim()));
export const GAME_ID = gameIdOf(MANIFEST);
/** The core as a node installs it: its file and hash, and the configs it runs (no adapter: a node runs it only in its sandbox). */
export const CORES = new Map([[CORE_HASH, Object.freeze({ name: '__NAME__', hash: CORE_HASH, url: here('./core.js').href,
  configs: new Map([[CONFIG_HASH, CONFIG]]) })]]);
export const GAME = Object.freeze({ name: '__NAME__', title: '__TITLE__', manifest: MANIFEST, gameId: GAME_ID, cores: CORES,
  donationSet: DONATION_SET });
