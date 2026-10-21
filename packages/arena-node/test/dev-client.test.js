// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEV CLIENT BESIDE A NODE, ON ITS DASHBOARD (2026-10-14: "make sure node 1 and node 2 show it in their dashboard,
// each node can set up a dev client and it would show there"): read from the client's own files, never its key. Its card on the
// dashboard is the React dashboard's (kanban #564: no fall backs) - packages/arena-web's dashboard test draws it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { devClientSnapshot } from '../src/dev-client.js';

const A = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', B = 'b18947f085d40df3ce4bc8ac64df9c45256223e88fe7fdbdebf3eae13fb10b73';

function devDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-client-'));
  writeFileSync(join(dir, 'donor.json'), JSON.stringify({ label: 'dev a', recipientPkHex: '02' + 'ab'.repeat(32), seats: Array(14).fill('http://x') }));
  writeFileSync(join(dir, 'key.json'), JSON.stringify({ secretHex: 'cd'.repeat(32) }));
  writeFileSync(join(dir, 'donations.jsonl'), [
    { outpoint: 'o1', federationId: A, amountMsat: '1113', roundId: 'r1'.repeat(32), entryId: 'e1', verifiedMs: 1791949266060, usdPerBtc: '83730.5' },
    { outpoint: 'o2', federationId: A, amountMsat: '1113', roundId: 'r2'.repeat(32), entryId: 'e2', verifiedMs: 1791951976043 },
    { outpoint: 'o3', federationId: B, amountMsat: '554', roundId: 'r3'.repeat(32), entryId: 'e3', verifiedMs: 1791960000000 },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ done: ['o1', 'o2', 'o3'], balances: { [A]: { msat: '38563', at: '2026-10-14T14:50:00Z' } },
    withdrawals: [{ at: '2026-10-14T04:27:05Z', federation: A, msat: '38563', state: 'Refunded', preimage: null }, { at: '2026-10-14T15:00:00Z', federation: A, msat: '38563', state: 'Success', preimage: 'aa' }],
    lastPass: { at: '2026-10-14T15:00:00Z', donations: 0, unanswered: 0, seats: 14 } }));
  return dir;
}

test('the snapshot: what the dev received, holds per federation and withdrew - and never its key', () => {
  const s = devClientSnapshot(devDir());
  assert.deepEqual([s.label, s.donations, s.receivedMsat, s.seats, s.withdrawnMsat], ['dev a', 3, '2780', 14, '38563']);
  assert.deepEqual(s.byFederation.map((f) => [f.federation.slice(0, 8), f.donations, f.msat, f.balanceMsat]), [['337ae01a', 2, '2226', '38563'], ['b18947f0', 1, '554', null]]);
  assert.equal(s.recent[0].round.slice(0, 4), 'r3r3', 'newest first');
  assert.equal(s.withdrawals[0].state, 'Success');
  assert.ok(!JSON.stringify(s).includes('cd'.repeat(32)), 'the secret never leaves key.json');
  assert.equal(devClientSnapshot(null), null, 'no directory named: no card');
  assert.match(devClientSnapshot(mkdtempSync(join(tmpdir(), 'none-'))).error, /no donor.json/);
});
