// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { bondMarker } from '../src/constants.js';
import { computeNetworkId, genesisFor, RANDOMNESS_SOURCE } from '../src/genesis.js';
import { computeGenesisConfigHash } from '../../nextblock/config/game-config.js';
import {
  GENESIS_CONFIG_HASH, NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4,
  AUTHORITY_PUBKEY_REGTEST, RECOVERY_PUBKEY_REGTEST,
  AUTHORITY_PUBKEY_TESTNET4, RECOVERY_PUBKEY_TESTNET4,
} from '../src/genesis-ids.js';

test('game config hash matches the committed id', () => {
  assert.equal(toHex(computeGenesisConfigHash()), toHex(GENESIS_CONFIG_HASH));
});

test('regtest and testnet4 network ids match the committed ids', () => {
  const r = computeNetworkId({
    genesis: genesisFor('regtest'),
    authorityPubkey: AUTHORITY_PUBKEY_REGTEST,
    recoveryPubkey: RECOVERY_PUBKEY_REGTEST,
  });
  const t = computeNetworkId({
    genesis: genesisFor('testnet4'),
    authorityPubkey: AUTHORITY_PUBKEY_TESTNET4,
    recoveryPubkey: RECOVERY_PUBKEY_TESTNET4,
  });
  assert.equal(toHex(r), toHex(NETWORK_ID_REGTEST));
  assert.equal(toHex(t), toHex(NETWORK_ID_TESTNET4));
  assert.notEqual(toHex(r), toHex(t));
});

test('test nets use 2-of-2, one confirmation, 100-block maturity, bitcoin block hash', () => {
  const g = genesisFor('testnet4');
  assert.equal(g.chain, 'bitcoin-testnet4');
  assert.equal(g.gameVerifySlots, 2);
  assert.equal(g.gameVerifyThreshold, 2);
  assert.equal(g.censusConfirmations, 1);
  assert.equal(g.bondMaturity, 100);
  assert.equal(g.randomnessSource, RANDOMNESS_SOURCE);
  assert.equal(RANDOMNESS_SOURCE, 'bitcoin-block-hash');
  assert.deepEqual(g.bondMarker, bondMarker('testnet'));
});

// THE FOUNDING CONFIG STAYS THE NETWORK'S, AND THE CURRENT CORE'S ROUNDS NAME THEIR OWN (2026-10-04, fix 1 of the
// spec audit; §27A.6 "a round is bound to the config it was created under"). The founding hash is the pinned one and the
// network ids above do not move; the current config is versioned, hashed from the current core's own constants, and names
// what the founding encoding cannot - par, the time bounds and the cargo rule.
import { computeGenesisConfigHash as foundingHash, computeCurrentConfigHash, encodeGameConfigV2, encodeGameConfigV3, computeDe2fConfigHash, encodeGameConfig as founding, GAME_CONFIG_V2, GAME_CONFIG_V3, EXPOSURE_WEIGHT_HEAT, CARGO_RULE_BED_FILL } from '../../nextblock/config/game-config.js';
import { REFERENCE_TICKS, T_TICKS_MIN, T_TICKS_MAX } from '../../nextblock/src/rules/score.js';
import { LEGACY_CARGO } from '../../nextblock/src/sim.js';
import { KNOWN_GOOD_GAMES } from '../src/known-games.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';

test('the current core plays a config of its own, beside the founding one the network id commits to', () => {
  assert.equal(toHex(foundingHash()), toHex(GENESIS_CONFIG_HASH), 'the founding config moved');
  const v2 = encodeGameConfigV2();
  assert.equal(v2[0], GAME_CONFIG_V2, 'the current config does not open with its version');
  assert.notEqual(toHex(computeCurrentConfigHash()), toHex(GENESIS_CONFIG_HASH), 'the current core names the founding config');
  assert.notEqual(v2.length, founding().length);
  const dv = new DataView(v2.buffer, v2.byteOffset, v2.byteLength);
  // the tail: par, T bounds, the cargo rule, the legacy C, the bed's room - read back from the encoding itself
  const end = v2.length;
  assert.equal(dv.getUint32(end - 4 - 4 - 1 - 4 - 4 - 4), REFERENCE_TICKS);
  assert.equal(dv.getUint32(end - 4 - 4 - 1 - 4 - 4), T_TICKS_MIN);
  assert.equal(dv.getUint32(end - 4 - 4 - 1 - 4), T_TICKS_MAX);
  assert.equal(v2[end - 4 - 4 - 1], CARGO_RULE_BED_FILL);
  assert.equal(dv.getUint32(end - 4 - 4), LEGACY_CARGO);
  // and the client lists the current core with the config it plays
  assert.ok((KNOWN_GOOD_GAMES[toHex(NEXTBLOCK_GAME_ID)].cores[coreHashHex()] || []).includes(toHex(computeCurrentConfigHash())),
    'the current core is not listed with its config: sign a new nextblock manifest and run node packages/arena-protocol/tools/known-games.js');
});

test('de2f263d keeps dbb49344 from its frozen constants; the current core names v3, whose last field is the heat weight', () => {
  assert.equal(toHex(computeDe2fConfigHash()), 'dbb493445fd56ba099bf8651a444f7c6de4b36add1cb01275bd1857920bd0801', 'de2f263d\'s config moved');
  const v3 = encodeGameConfigV3();
  assert.equal(v3[0], GAME_CONFIG_V3);
  assert.equal(v3[v3.length - 1], EXPOSURE_WEIGHT_HEAT);
  assert.notEqual(toHex(computeCurrentConfigHash()), toHex(computeDe2fConfigHash()));
});
