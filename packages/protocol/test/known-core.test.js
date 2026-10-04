// THE KNOWN-GOOD LIST HOLDS THE CORE THIS TREE BUILDS (§5).
//
// The list is generated from `core/tools/hash-core.js`, and this recomputes the
// hash from the sources: a change to the core turns this red until the new core
// is deliberately listed (`node packages/protocol/tools/known-cores.js`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex } from '../src/hash.js';
import { coreHashHex } from '../../core/tools/hash-core.js';
import { KNOWN_GOOD_CORE_HASHES } from '../src/known-cores.js';
import { coreIsKnownGood } from '../src/known-core.js';

test('the core this tree builds is on the known-good list, and is accepted', () => {
  const now = coreHashHex();
  assert.match(now, /^[0-9a-f]{64}$/);
  assert.ok(KNOWN_GOOD_CORE_HASHES.includes(now),
    `core ${now} is not listed: run node packages/protocol/tools/known-cores.js`);
  assert.deepEqual(coreIsKnownGood(fromHex(now)), { ok: true });
  assert.ok(Object.isFrozen(KNOWN_GOOD_CORE_HASHES));
});

test('an unknown core, the old fixture constant, or no core at all is refused by name', () => {
  assert.match(coreIsKnownGood(new Uint8Array(32).fill(1)).why, /not on this client's known-good list/);
  assert.match(coreIsKnownGood(undefined).why, /names no 32-byte core hash/);
  assert.match(coreIsKnownGood(new Uint8Array(31)).why, /names no 32-byte core hash/);
});

// AND THE CONFIG (the owner 2026-10-04, fix 1 of the spec audit; §27A.6): a listed core plays the configs listed beside it.
import { computeCurrentConfigHash, computeGenesisConfigHash } from '../src/genesis.js';
test('a round on a listed core is refused under a config that core does not play, and accepted under its own', () => {
  const DE2F = fromHex('de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8');
  const OLD = fromHex('2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e');
  assert.deepEqual(coreIsKnownGood(DE2F, computeCurrentConfigHash()), { ok: true });
  assert.deepEqual(coreIsKnownGood(DE2F, computeGenesisConfigHash()), { ok: true }, 'the free rounds made before its config had a hash');
  assert.deepEqual(coreIsKnownGood(OLD, computeGenesisConfigHash()), { ok: true });
  assert.match(coreIsKnownGood(OLD, computeCurrentConfigHash()).why, /not a config this client knows that core to play/);
  assert.match(coreIsKnownGood(DE2F, new Uint8Array(32).fill(7)).why, /not a config this client knows that core to play/);
  assert.match(coreIsKnownGood(DE2F, new Uint8Array(3)).why, /names no 32-byte config hash/);
});
