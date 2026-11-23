// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 3), THE ORIGINAL CASE UNDER ITS OWN CAUSE: feedback #365's collect record was refused for a full
// storage while its pending note was kept (the line showed "collect pending" for 7 h). #3086 puts the rebuild's material (round contract
// ~1300 hex, invite, seed) INTO that note - written with a raw setItem, no putRoomy, no smaller fallback - so the note is now about as big
// as the refused record. In the storage that took the old note and refused the record, the new note is refused too: no note, no pending
// line, and nothing for the rebuild to take once room frees again. The join's own committedTo and lookThePending are lifted from the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pageFunction } from './page-script.js';
import { writeNote as _w, page, payout, recordsOf, round, NODES, SEED } from './wf1489-r1120-refute-3-s1-harness.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('          const committedTo = (eid) => {');
const b = html.indexOf('          // THE ENTRY THE LOCK IS NAMED IN', a);
assert.ok(a > 0 && b > a, 'committedTo is in the page');
const liftCommitted = pageFunction(PAGE, ['ARENACLIENT', 'vault', 'named', 'seed', 'player', 'whose', 'window'], html.slice(a, b), '; return committedTo;');

// a browser storage with a quota: key + value characters, as a browser counts them
function quotaStore(cap) {
  const m = new Map();
  const used = () => [...m].reduce((t, [k, v]) => t + k.length + v.length, 0);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { v = String(v); const was = m.has(k) ? k.length + m.get(k).length : 0;
      if (used() - was + k.length + v.length > cap) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, v); },
    removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; }, _m: m, used, cap: () => cap, grow: (n) => { cap += n; } };
}

test('#3086 under #365\'s cause: the storage that kept the old note and refused the record keeps a note the rebuild can take', async () => {
  const rid = '36'.repeat(32), eid = 'e5'.repeat(32);
  const invite = 'fed1' + 'q'.repeat(240);   // a federation invite is a few hundred characters
  // what a pre-#3086 note took (round, entry, nodes) - #365's line showed, so at least that much room was there
  const oldNote = 'arena.pending.' + rid + '.' + eid + JSON.stringify({ roundIdHex: rid, entryIdHex: eid, nodes: NODES });
  // what the join's record takes (its lock left out: smaller than the real one)
  const probe = quotaStore(1e9); PL.saveCollect(probe, { roundIdHex: rid, round, invite, nodes: NODES, seed: SEED });
  const recordChars = probe.used();
  const filler = 'x'.repeat(50000);
  const room = oldNote.length + 200;
  assert.ok(room < recordChars, 'the record does not fit (' + recordChars + ' > ' + room + ')');
  const V = quotaStore(50000 + 'filler'.length + room); V.setItem('filler', filler);
  const S = quotaStore(1e9);
  // the join: the record refused (#365)
  assert.equal(PL.saveCollect(V, { roundIdHex: rid, round, invite, nodes: NODES, seed: SEED }), false, 'the record is refused');
  // then the seats commit the entry: the page's committedTo writes its note
  const AC = { toHex, fromHex, encodeRoundContract, markLockCommitted: () => true };
  const win = { sessionStorage: S };
  const committedTo = liftCommitted(AC, () => V, { roundIdHex: rid, federation: invite, nodes: NODES, round }, SEED, { order: 0, pubkey: new Uint8Array(33) }, {}, win);
  committedTo(fromHex(eid));
  const noteKept = V._m.has('arena.pending.' + rid + '.' + eid);
  // later the browser frees room (the tidy at the next load, another tab closed) and the tab looks again
  V.removeItem('filler');
  const p = page(V, S, { [eid]: payout(180000) });
  await p.look();
  assert.ok(noteKept, 'the note of the committed entry is kept (the pre-#3086 note fitted here; #365\'s line showed)');
  assert.equal(recordsOf(V, rid).length, 1, 'the owed payout\'s record is rebuilt once room is back: ' + p.said.join(' / '));
});
