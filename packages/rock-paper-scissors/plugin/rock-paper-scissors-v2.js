// ROCK-PAPER-SCISSORS AT 2026.0.2 (kanban #348, RULED the owner 2026-10-13: "The version bump is 2026.0.2 with new market and game
// ids"): the same game - cores, client, info, donation set - under manifest version 2, whose parent is 1e9ab4b7 and which
// requires protocol version 2, the round that names no draw. Signed with the game's developer key; a node that does not
// speak version 2 cannot host it, and a round of it at an older version is refused (manifest.js roundFitsManifest).
import { GAME as V1 } from './rock-paper-scissors.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

export const MANIFEST_V2_HEX = '1c00010013726f636b2d70617065722d73636973736f7273db57bd7ad41ef92d72fb53a6d4bf5f4b614150fadeedf5430be1af7814091dab000000021e9ab4b7d402d51f46def727e6db58da0ad70c4afafc295c82357d612543cd50030001d65609877c2681c17a8c97a4203c26172464ffd2f598624e5abf1aafdcaf443400010d562087b31feef63e89c7b558f725f6ca44a1eb1e88f5c2779ea8055ae3617200000000000000000000010304000000020001b895f3b16d9cef663130faacbf5d37e2fe60271ba5e4748024db2d27e1174206a5dc55c1ffef31fae9b7450fb687334675089bb33aea54c667e233c9b3c237790203000000000001d4c002000279ed11bf5bd3035a5df0729954f3ea11e3cf7e1ccf305bf5eae914d8bbac5d95476fdc1ec99027dee9118b2cd17a526ce107043838af98d5f4f56cae70853603';
export const MANIFEST_V2 = decodeManifest(fromHex(MANIFEST_V2_HEX));
export const GAME_ID_V2 = gameIdOf(MANIFEST_V2);
/** What a launcher loads from this module (ARENA_GAMES): the registration. */
export const GAME = Object.freeze({ ...V1, manifest: MANIFEST_V2, gameId: GAME_ID_V2 });
