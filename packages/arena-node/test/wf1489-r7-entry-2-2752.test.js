// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2752, wf1489 r7 entry-2: POST /lock?entry=<any public entry id> with junk contract fields asks the federation (port.status of the entry's
// outpoint and port.contractId of the handed fields - on a live seat two questions to the ONE arena-stake-lock server that answers one
// question at a time, 0.4-0.6 s per status read; a 10 s backlog ends the server and every question then spawns a process of its own) BEFORE
// any local check of the fields against the entry, and again for an entry whose lock this seat already verified. A stranger who only
// knows an entry id (the explorer shows them) fills the seat's one federation lane with junk: honest players' /lock waits until it times
// out, their stakes are never SEEN, and the round's paid runs do not start. lockMatchesEntry's field checks (amount = net stake, claim key,
// refund key, image = the entry's stake point) need no federation, only the height does.
// SAFE: fields that cannot be the entry's lock, or a re-hand of an already verified lock with other fields, cost no federation question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { LOSER } from './window-fixture.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('wf1489 r7 entry-2: junk /lock hand-overs for a public entry id cost the seat no federation questions', { timeout: 120000 }, async () => {
  const w = await lockRound();
  try {
    const played = await lockAndPlay(w, LOSER, { noMarks: true });
    const d = w.a;
    const counts = { status: 0, contractId: 0 };
    const st = w.port.status.bind(w.port), cid = w.port.contractId.bind(w.port);
    w.port.status = async (...a) => { counts.status++; return st(...a); };
    w.port.contractId = async (...a) => { counts.contractId++; return cid(...a); };
    const N = 40;
    const said = new Set();
    for (let i = 0; i < N; i++) {
      // the entry's real fields with another amount: never the entry's lock (lockMatchesEntry needs amount = net stake)
      const junk = lockFieldsToJson({ ...played.fields, amountMsat: 1000n + BigInt(i) });
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify(junk) });
      said.add(`${r.status} ${(await r.text()).trim().slice(0, 90)}`);
    }
    console.log('  MEASURED r7-entry-2:', JSON.stringify({ posts: N, federationQuestions: counts, answers: [...said] }));
    assert.ok([...said].every((x) => !x.startsWith('201')), 'a junk lock was taken');
    assert.ok(counts.status + counts.contractId <= 2,
      `${N} junk /lock posts for one public entry id asked the federation ${counts.status} status + ${counts.contractId} contract-id questions`);
  } finally { await w.close(); }
});
