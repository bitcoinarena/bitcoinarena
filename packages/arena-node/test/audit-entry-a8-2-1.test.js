// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit 2026-11-25 entry r2-1: the M3.3-34 guard (forfeit.js message: "a Void this signer node learned only from a forfeit ask signs
// a lock refund only if its proof pull reached every other signer node") reads HOW the Void was learned from the caller's own word:
// POST /first-mark records learned = got.ask === 'forfeit' ? 'forfeit-ask' : 'forward' (server.js ~10506). The forfeit ask's push
// (pushVoid) is the same unauthenticated body with ask:'forfeit'; anyone who posts it without that field gets 'forward', which the
// guard never checks. Path 2 of five-of-seven (the ruled limit): 0-3 record ENTRY_VOID on a real outage, signer node 4 alone holds
// the player's late first mark (the §13B proof) and is down. The ruled outcome is no committee refund. A stranger (or the player)
// hands 5 and 6 the voided entry's public first mark and evidence without `ask` first - they record the Void as 'forward',
// skip the reach rule, and sign: the refund forms with the proof still on the down seat.
// Safe: with signer node 4 (the proof) down, no refund door answers 2xx and no signer node keeps a refund of the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sevenSignerNodes, joinWithTwoFirstMarks, pathTwoSignerNodeFourDown, refundNow, toHex } from './five-of-seven-fixture.js';
import { splitSignedBatch } from '../../arena-protocol/src/batch.js';

test('audit-entry-r2-1: a Void handed on without ask=forfeit skips the M3.3-34 reach rule - the refund forms while the proof seat is down', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await pathTwoSignerNodeFourDown(w, run);
    // the stranger's hand-over: public bytes only (the first mark and the mark past the line, as GET /entry-void serves them), no `ask`
    const body = JSON.stringify({ mark: toHex(run.first[1]), batches: [toHex(splitSignedBatch(run.first[0]).body)],
      entryVoid: { kind: 'mark', evidence: toHex(run.past[1]) } });
    const handed = [];
    for (const i of [5, 6]) {
      const r = await fetch(`http://127.0.0.1:${w.signerNodes[i].port}/first-mark`, { method: 'POST', body });
      handed.push({ i, status: r.status, said: (await r.text()).slice(0, 120), learned: (w.signerNodes[i].round.entryVoid(run.eid) || {}).learned || null });
    }
    const now = await refundNow(w, run);
    const facts = { voidedFirst: setup.voidedFirst, lateAt4: setup.lateAt4, handed, doors: now.doors, commits: now.commits, kept: now.kept, lockHeld: now.lockHeld };
    console.log('  FACTS audit-entry-r2-1:', JSON.stringify(facts));
    assert.equal(setup.voidedFirst, 4, 'setup: signer nodes 0-3 did not all record ENTRY_VOID');
    assert.equal(setup.lateAt4, true, 'setup: signer node 4 kept no late first mark (the proof)');
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx while the proof seat was down: ${JSON.stringify(now.doors)} (5/6 learned ${handed.map((h) => h.learned).join(',')})`);
    assert.equal(now.kept, 0, `${now.kept} signer nodes keep a committee refund of the lock`);
  } finally { await w.close(); }
});
