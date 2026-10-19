// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST GAME'S MANIFEST, SIGNED AS ITS DEVELOPER WOULD (kanban #202): with the dev client's signer
// (arena-donor/src/manifest-sign.js, Daniel 2026-10-07 15:40: the dev client signs games, never a node), giving a
// registration { name, manifest, gameId, cores } as a launcher hands serve() one, for a game that exists only in the
// tests. Its developer key is derived from a fixed seed - a test key, never a real game's - so every run gives the game
// the same id.
import { createHash } from 'node:crypto';
import { gameDevKey, signManifest } from '../../../arena-donor/src/manifest-sign.js';
import { sign as edSign } from 'node:crypto';
import { gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../../arena-protocol/src/manifest.js';
import { attestationBodyId } from '../../../arena-protocol/src/attested.js';
import { valueAttestationBodyId } from '../../../arena-protocol/src/scalar.js';
import { fromHex } from '../../../arena-protocol/src/hash.js';
import { donationSetId } from '../../../arena-protocol/src/donation.js';

/**
 * A TEST GAME'S DONATION SET (kanban #205): one 33-byte key derived from the developer's word, all 10000 bps - a set of its
 * own, never the network's, so a round of it pays the protocol devs and the game dev to different keys.
 */
export function testDonationSet(word) {
  const x = createHash('sha256').update(`test game donation key: ${word}`).digest();
  return [{ recipientPk: Uint8Array.from([0x02, ...x]), label: `${word} dev`, shareBps: 10000 }];
}

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
  parentManifestId = NO_PARENT, dev = name, clients = [], donationSet = testDonationSet(dev), roundPeriodMs = 0n }) {
  const gameDonationSetId = donationSetId(donationSet);
  const devKey = testDevKey(dev);
  const pubkey = devKey.pubkey;
  const sorted = (hs) => [...hs].sort();
  const body = {
    gameName: name, gameDevPubkey: pubkey, version, parentManifestId, resultType: RESULT_TYPE.REPLAY,
    cores: sorted([...cores.keys()]).map((h) => ({ hash: fromHex(h), configs: sorted([...cores.get(h).configs.keys()]).map(fromHex) })),
    runTicksMax, roundPeriodMs, payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator, rankDenominator, minScore,
    clients, gameDonationSetId,
  };
  const manifest = signManifest(body, devKey);
  return Object.freeze({ name, manifest, gameId: gameIdOf(manifest), cores, donationSet });
}

/**
 * AN ATTESTED TEST GAME (§0A.7a, kanban #206): a market with `outcomes`, its attestors test keys derived from words (the
 * same word, the same key), `threshold` of them needed - no core, no run, the pari-mutuel rule. Answers the registration
 * and the attestors' keys, so a test can sign outcomes as they would.
 */
export function testAttestedGame({ name, outcomes, attestors = ['attestor a', 'attestor b', 'attestor c'], threshold = 2, dev = name,
  donationSet = testDonationSet(dev), version = 1, parentManifestId = NO_PARENT, clients = [], marketTerms = null, roundPeriodMs = 0n,
  template = null, requiredProtocolVersion = null, gameSource = null, scalar = null }) {
  const devKey = testDevKey(dev);
  // in key order, as the manifest lists them - and none for a market on a game (kanban #362 feature 6): its source round decides it
  const keys = (gameSource ? [] : attestors).map((w) => testDevKey(`attestor: ${w}`)).sort((x, y) => Buffer.compare(Buffer.from(x.pubkey), Buffer.from(y.pubkey)));
  const body = {
    gameName: name, gameDevPubkey: devKey.pubkey, version, parentManifestId, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [...clients].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))), gameDonationSetId: donationSetId(donationSet),
    outcomes, attestors: keys.map((k) => k.pubkey), attestThreshold: gameSource ? 0 : threshold,
    ...(marketTerms ? { marketTerms } : {}),
    // AN EVENT-MARKET TEMPLATE (kanban #362 feature 5): its rounds ask their own question; it requires a protocol version (#349)
    ...(template ? { template } : {}),
    ...(gameSource ? { gameSource } : {}),
    // A SCALAR MARKET (kanban #362 feature 8): bounds and a unit, its outcomes LONG and SHORT; it requires protocol version 7
    ...(scalar ? { scalar } : {}),
    ...(requiredProtocolVersion ? { requiredProtocolVersion } : {}),
  };
  const manifest = signManifest(body, devKey);
  return { registration: Object.freeze({ name, manifest, gameId: gameIdOf(manifest), cores: new Map(), donationSet }), attestors: keys };
}

/**
 * A HEAD-TO-HEAD TEST GAME (kanban #233): one decide adapter `core` ({ name, hash, adapter, configs }), `players`, `moveCount`
 * and a reveal window - no run, the rank curve, min_score 2 - signed by a test developer key derived from `dev`.
 */
export function testHeadToHeadGame({ name, core, players = 2, moveCount = 3, revealWindowMs = 60000n, dev = name,
  donationSet = testDonationSet(dev), clients = [] }) {
  const devKey = testDevKey(dev);
  const body = {
    gameName: name, gameDevPubkey: devKey.pubkey, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: fromHex(core.hash), configs: [...core.configs.keys()].sort().map(fromHex) }], runTicksMax: 0, roundPeriodMs: 0n,
    payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 2,
    clients: [...clients].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))), gameDonationSetId: donationSetId(donationSet),
    players, moveCount, revealWindowMs,
  };
  const manifest = signManifest(body, devKey);
  return Object.freeze({ name, manifest, gameId: gameIdOf(manifest), cores: new Map([[core.hash, core]]), donationSet });
}

/** An attestor's signature on an outcome attestation's body: { key, signature } as the attestation carries it. */
export const attestorSign = (attestor, body) => ({ key: attestor.pubkey, signature: new Uint8Array(edSign(null, Buffer.from(attestationBodyId(body)), attestor.key)) });
/** One attestor's signature over a scalar market's value attestation body { roundId, value, observedAtMs } (kanban #362 feature 8). */
export const attestorSignValue = (attestor, body) => ({ key: attestor.pubkey, signature: new Uint8Array(edSign(null, Buffer.from(valueAttestationBodyId(body)), attestor.key)) });
