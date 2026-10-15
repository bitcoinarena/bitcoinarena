// THE BALLOT'S GENESIS IS NEXTBLOCK'S v4 CONFIG (kanban #329, arena-protocol/src/ballot-chain.js BALLOT_GENESIS): the engine writes
// the bytes out because it imports no game; here they are held to the encoder that makes them and to the hash every truck round names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { encodeGameConfigV4, TAG_GAME_CONFIG } from '../config/game-config.js';
import { TRUCK_CURRENT_CONFIG } from '../plugin/truck-cores.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

test('BALLOT_GENESIS is encodeGameConfigV4, and its hash is the config the truck\'s rounds name', () => {
  assert.equal(toHex(BALLOT_GENESIS.config), toHex(encodeGameConfigV4()));
  assert.equal(toHex(taggedHash(TAG_GAME_CONFIG, BALLOT_GENESIS.config)), toHex(BALLOT_GENESIS.configHash));
  assert.equal(toHex(BALLOT_GENESIS.configHash), TRUCK_CURRENT_CONFIG);
});
