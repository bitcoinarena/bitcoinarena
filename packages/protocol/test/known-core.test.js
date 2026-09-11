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
