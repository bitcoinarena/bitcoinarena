// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1331 / #1383 (§13A.1 RULED 2026-11-09): an AUDIT's tick hash = tagged_hash("ARENA/v1/AuditTick", t || for each entry in entry-id order:
// entry_id || H(its run's state at min(t, its last tick))), 32 zero bytes for an entry with no run. The replay hands the state at any tick
// (`hashTicks`), the same state a checkpoint mark at that tick names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { auditTickHash, AUDIT_TICK_TAG } from '../../arena-protocol/src/auditor.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const [, installed] = [...NEXTBLOCK.cores][0];
const core = { ...installed, config: [...installed.configs.values()][0] };
const words = (n) => Array.from({ length: n }, (_, i) => ({ tick: i, words: [i % 7, (i * 3) % 11, 2, 0, 1] }));

test('#1383 the replay\'s state at a tick is the one a checkpoint mark there names; past the run\'s end, its last state', () => {
  const T = words(400);
  const r = replay({ ticks: T }, { joinTick: 0 }, { core, seedWord: 7, hashTicks: [137, 5000] });
  assert.equal(r.ok, true, r.why);
  const [at137, past] = r.hashes;
  assert.deepEqual([at137.asked, at137.tick, past.asked], [137, 137, 5000]);
  assert.ok(past.tick <= 400 && typeof past.stateHash === 'string');
  console.log('  MEASURED #1383:', JSON.stringify({ t137: String(at137.stateHash).slice(0, 16), past: [past.tick, String(past.stateHash).slice(0, 16)], final: String(r.stateHash).slice(0, 16) }));
  assert.equal(past.stateHash, r.stateHash, 'past the end is not the run\'s last state');
  // a mark at 137 naming that hash agrees; one naming another does not
  const good = replay({ ticks: T }, { joinTick: 0 }, { core, seedWord: 7, marks: [{ tick: 137, stateHash: fromHex(at137.stateHash) }] });
  assert.equal(good.agrees, true);
  const bad = replay({ ticks: T }, { joinTick: 0 }, { core, seedWord: 7, marks: [{ tick: 137, stateHash: fromHex(past.stateHash) }] });
  assert.equal(bad.agrees, false);
  // another seed, another state at 137
  const other = replay({ ticks: T }, { joinTick: 0 }, { core, seedWord: 8, hashTicks: [137] });
  assert.notEqual(other.hashes[0].stateHash, at137.stateHash);
});

test('#1383 the tick hash: t, then every entry in entry-id order with its state; an entry with no run is 32 zeros', () => {
  const e1 = new Uint8Array(32).fill(1), e2 = new Uint8Array(32).fill(2), h1 = new Uint8Array(32).fill(0xa1), h2 = new Uint8Array(32).fill(0xa2);
  const want = taggedHash(AUDIT_TICK_TAG, Uint8Array.from([0, 0, 0x05, 0x1c, ...e1, ...h1, ...e2, ...new Uint8Array(32)]));
  assert.equal(toHex(auditTickHash({ t: 1308, entries: [{ entryId: e2, stateHash: null }, { entryId: e1, stateHash: h1 }] })), toHex(want), 'order by entry id, zeros for no run, t as u32');
  assert.notEqual(toHex(auditTickHash({ t: 1308, entries: [{ entryId: e1, stateHash: h1 }, { entryId: e2, stateHash: h2 }] })), toHex(want));
  assert.notEqual(toHex(auditTickHash({ t: 1309, entries: [{ entryId: e1, stateHash: h1 }, { entryId: e2, stateHash: null }] })), toHex(want));
  assert.throws(() => auditTickHash({ t: -1, entries: [] }), /u32/);
});
