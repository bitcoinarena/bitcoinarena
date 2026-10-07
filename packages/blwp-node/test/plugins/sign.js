// A TEST GAME'S MANIFEST, SIGNED AS ITS DEVELOPER WOULD (kanban #202): with the dev client's signer
// (blwp-donor/src/manifest-sign.js, the owner 2026-10-07 15:40: the dev client signs games, never a node), giving a
// registration { name, manifest, gameId, cores } as a launcher hands serve() one, for a game that exists only in the
// tests. Its developer key is derived from a fixed seed - a test key, never a real game's - so every run gives the game
// the same id.
import { createHash } from 'node:crypto';
import { gameDevKey, signManifest } from '../../../blwp-donor/src/manifest-sign.js';
import { gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../../protocol/src/manifest.js';
import { fromHex } from '../../../protocol/src/hash.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 key from a word: the same word, the same key. */
export function testDevKey(word) {
  const seed = createHash('sha256').update(`test game developer: ${word}`).digest();
  return gameDevKey(Buffer.concat([PKCS8_ED25519, seed]));
}

/**
 * THE REGISTRATION OF A TEST GAME: `cores` a Map of hash (hex) to { name, hash, adapter, configs (Map of hex to config),
 * replayFile? }, every one listed in the manifest with the configs it installs. The rest are the manifest's terms.
 */
export function testGame({ name, cores, runTicksMax, rankNumerator = 3, rankDenominator = 4, minScore = 1, version = 1,
  parentManifestId = NO_PARENT, dev = name, clients = [], gameDonationSetId = new Uint8Array(32) }) {
  const devKey = testDevKey(dev);
  const pubkey = devKey.pubkey;
  const sorted = (hs) => [...hs].sort();
  const body = {
    gameName: name, gameDevPubkey: pubkey, version, parentManifestId, resultType: RESULT_TYPE.REPLAY,
    cores: sorted([...cores.keys()]).map((h) => ({ hash: fromHex(h), configs: sorted([...cores.get(h).configs.keys()]).map(fromHex) })),
    runTicksMax, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator, rankDenominator, minScore,
    clients, gameDonationSetId,
  };
  const manifest = signManifest(body, devKey);
  return Object.freeze({ name, manifest, gameId: gameIdOf(manifest), cores });
}
