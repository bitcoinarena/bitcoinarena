// kanban #1489 round 3 (gossip), kanban #1561: ONE PEER'S GET /evidence-blocks ANSWER WROTE UNBOUNDED evidence_blocks ROWS FOR
// MADE-UP MARK IDS. Verifier#pullEvidenceBlocks kept every { mark, block } a peer listed, with no count limit, no check that the id
// is a mark this seat holds for the entry, and no timeout of its own. The safe behaviour: a pulled record is kept only for a mark
// this seat already holds a record of, bounded per mark; a known mark's peer record is still kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Verifier } from '../src/verify.js';

const b = (n) => new Uint8Array(32).fill(n);
const hex = (u) => Buffer.from(u).toString('hex');

function withPeer(answer, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/evidence-blocks')) return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('no', { status: 404 });
  };
  return run().finally(() => { globalThis.fetch = real; });
}

test('one peer\'s /evidence-blocks list of made-up mark ids is bounded', async () => {
  const round = new Round(openStore(':memory:'), () => 1000);
  const v = new Verifier(round, { peers: ['http://evil.peer'], pool: {} });
  const eid = b(2);
  const marks = [];
  for (let i = 0; i < 20000; i++) { const m = Buffer.alloc(32); m.writeUInt32BE(i + 1); marks.push({ mark: m.toString('hex'), block: hex(b(9)), seenMs: 1 }); }
  await withPeer({ marks }, () => v.pullEvidence(b(1), eid));
  const kept = round.evidenceBlocks(eid).length;
  assert.ok(kept < 20000, `one peer's answer wrote ${kept} evidence rows for one entry, none of them a mark this seat knows`);
  assert.equal(kept, 0, 'no listed mark is one this seat holds');
});

test('a peer\'s record of a mark this seat holds is kept, at most a bounded number of blocks a mark', async () => {
  const round = new Round(openStore(':memory:'), () => 1000);
  const v = new Verifier(round, { peers: ['http://peer'], pool: {} });
  const rid = b(1), eid = b(2), mark = b(3);
  round.noteEvidenceBlock(rid, eid, mark);            // this seat's own record (no chain here: the zero block)
  const marks = [{ mark: hex(mark), block: hex(b(9)) }];
  for (let i = 0; i < 5000; i++) { const blk = Buffer.alloc(32, 0x11); blk.writeUInt32BE(i + 1); marks.push({ mark: hex(mark), block: blk.toString('hex') }); }
  await withPeer({ marks }, () => v.pullEvidence(rid, eid));
  const rows = round.evidenceBlocks(eid);
  assert.ok(rows.some((r) => hex(r.block) === hex(b(9))), 'the peer\'s record of a held mark is kept');
  assert.ok(rows.length <= 64, `one held mark carries ${rows.length} block records from one peer`);
});

// kanban #1803: a mark this seat holds no record of but CHECKED ITSELF - a peer's refused first mark the close's gather verified
// under the entry's session key (carried.refusedMarks) - takes the peers' records too (one-signer-node-refused (8) stayed HOLDING
// at the seat the mark never reached), still bounded per mark; the made-up ids listed beside it still write nothing.
test('a peer\'s record of a mark this seat checked itself is kept, bounded; made-up ids beside it are not', async () => {
  const round = new Round(openStore(':memory:'), () => 1000);
  const v = new Verifier(round, { peers: ['http://peer'], pool: {} });
  const rid = b(1), eid = b(2), mark = b(4);
  v.carried.set(`${hex(rid)}:${hex(eid)}`, { refusedMarks: [{ peer: 'http://peer', why: 'refused', markId: mark }] });
  const marks = [{ mark: hex(mark), block: hex(b(9)), seenMs: 5 }];
  for (let i = 0; i < 5000; i++) { const blk = Buffer.alloc(32, 0x11); blk.writeUInt32BE(i + 1); marks.push({ mark: hex(mark), block: blk.toString('hex') }); }
  for (let i = 0; i < 20000; i++) { const m = Buffer.alloc(32, 0x22); m.writeUInt32BE(i + 1); marks.push({ mark: m.toString('hex'), block: hex(b(9)) }); }
  await withPeer({ marks }, () => v.pullEvidence(rid, eid));
  const rows = round.evidenceBlocks(eid);
  assert.ok(rows.some((r) => hex(r.markId) === hex(mark) && hex(r.block) === hex(b(9))), 'the peer\'s record of the checked mark is kept');
  assert.ok(rows.every((r) => hex(r.markId) === hex(mark)), 'a made-up id beside it wrote a row');
  assert.ok(rows.length <= 64, `one checked mark carries ${rows.length} block records from one peer`);
});
