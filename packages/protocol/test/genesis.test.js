import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { bondMarker } from '../src/constants.js';
import {
  computeGenesisConfigHash, computeNetworkId, genesisFor, RANDOMNESS_SOURCE,
} from '../src/genesis.js';
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
