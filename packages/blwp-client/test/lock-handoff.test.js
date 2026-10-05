// THE STAKE LOCK HANDED TO EVERY SIGNER NODE AFTER A JOIN - client.js #handLocksUntilTaken (kanban #147, surface 4 part 2,
// plan comment 210, Go 2026-10-05), driven through the public join() only. Seven fake signer nodes on one local HTTP server
// (bases /n0 .. /n6): /entry takes the entry, /lock and /fee-lock answer 201 or a refusal as each test scripts them.
// LOCK_HAND_MS (120 s) is a module constant and cannot be shortened without a production change, so that bound stays
// untested (plan 210); every hand-off here ends because every node took the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '../src/client.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const ENTRY = { roundId: b32(0x31), playerPubkey: b32(0x32), sessionPubkey: b32(0x33), stakeCommitment: b32(0x34), stakeMsat: 100000n, feeMsat: 0n,
  donationMsat: 0n, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33).fill(2),
  feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  claimKeyAttestationRef: new Uint8Array(32) };
const EID = entryId(ENTRY);
const FIELDS = { paymentImage: { kind: 'point', bytes: new Uint8Array(33).fill(2) }, amountMsat: 100000n, claimPk: new Uint8Array(33).fill(3), refundPk: new Uint8Array(33).fill(2), expiration: 900144 };

// `takes(door, node, attempt)` -> true to answer 201; every ask is recorded
async function nodesServer(takes) {
  const asks = [];
  const srv = createServer((req, res) => {
    const m = /^\/n(\d+)\/(entry|lock|fee-lock)/.exec(req.url);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!m) { res.writeHead(404); return res.end('no such door'); }
      const node = Number(m[1]), door = m[2];
      if (door === 'entry') { res.writeHead(201); return res.end(Buffer.from(EID)); }
      const attempt = asks.filter((a) => a.node === node && a.door === door).length + 1;
      asks.push({ node, door, attempt, at: Date.now(), body: Buffer.concat(chunks).toString() });
      if (takes(door, node, attempt)) { res.writeHead(201); return res.end('taken'); }
      res.writeHead(409); return res.end(`node ${node} cannot verify that lock yet`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = (i) => `http://127.0.0.1:${srv.address().port}/n${i}`;
  return { asks, base, close: () => new Promise((r) => srv.close(r)) };
}
function clientOn(srv, stakeLock) {
  const c = new Client({ base: srv.base(0), core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  c.peers = [1, 2, 3, 4, 5, 6].map((i) => srv.base(i));
  c.stakeLock = stakeLock;
  return c;
}

test('5 of 7 nodes take the lock: committed, and the page hook is called once with the entry id', async () => {
  const srv = await nodesServer((door, node, attempt) => node < 5 || attempt >= 2);
  const seen = [];
  const c = clientOn(srv, { fields: FIELDS, needed: 5, onCommitted: (eid) => seen.push(hex(eid)) });
  try {
    await c.join(ENTRY);
    const got = await c.lockHanding;
    assert.deepEqual({ ok: got.lock.ok, committed: got.lock.committed, needed: got.lock.needed }, { ok: true, committed: 7, needed: 5 });
    assert.deepEqual(seen, [hex(EID)], 'the page hook was not called exactly once');
    assert.equal(got.feeLock, undefined);
    // the first pass: nodes 0-4 took it, 5 and 6 refused, and the lock body is the lock's own fields
    const first = srv.asks.filter((a) => a.attempt === 1);
    assert.equal(first.length, 7);
    assert.deepEqual(JSON.parse(first[0].body).claimPk, '03'.repeat(33));
  } finally { await srv.close(); }
});

test('nodes that refuse are asked again, the pause doubling from 300 ms, until every node has it', async () => {
  const srv = await nodesServer((door, node, attempt) => node !== 6 || attempt >= 4);
  const c = clientOn(srv, { fields: FIELDS, needed: 5 });
  try {
    await c.join(ENTRY);
    const got = await c.lockHanding;
    assert.equal(got.lock.committed, 7);
    const six = srv.asks.filter((a) => a.node === 6).map((a) => a.at);
    assert.equal(six.length, 4, 'node 6 was not asked four times');
    assert.equal(srv.asks.filter((a) => a.node === 0).length, 1, 'a node that took it was asked again');
    const gaps = six.slice(1).map((t, i) => t - six[i]);
    assert.ok(gaps[0] >= 280 && gaps[1] >= 560 && gaps[2] >= 1150, `pauses ${gaps.join(', ')} ms do not double from 300`);
    assert.deepEqual(got.lock.said.map((s) => s.status), [201], 'the last pass asked more than the one node left');
  } finally { await srv.close(); }
});

test('a fee lock is handed beside it, each door counted on its own', async () => {
  const srv = await nodesServer((door, node, attempt) => door === 'lock' || node !== 2 || attempt >= 2);
  const c = clientOn(srv, { fields: FIELDS, needed: 5, feeLock: { fields: { ...FIELDS, amountMsat: 2000n } } });
  try {
    await c.join(ENTRY);
    const got = await c.lockHanding;
    assert.deepEqual({ lock: got.lock.committed, fee: got.feeLock.committed, feeOk: got.feeLock.ok }, { lock: 7, fee: 7, feeOk: true });
    assert.equal(srv.asks.filter((a) => a.door === 'fee-lock' && a.node === 2).length, 2);
    assert.equal(srv.asks.filter((a) => a.door === 'lock').length, 7, 'the stake lock was asked again for the fee lock\'s refusal');
    assert.equal(JSON.parse(srv.asks.find((a) => a.door === 'fee-lock').body).amountMsat, '2000');
    assert.equal(c.feeLockHanded.committed, 7);
  } finally { await srv.close(); }
});

test('a stake lock that was not accepted hands nothing, and no node is asked', async () => {
  const srv = await nodesServer(() => true);
  const accepted = Promise.reject(new Error('the federation refused the lock'));
  accepted.catch(() => {});
  const c = clientOn(srv, { fields: FIELDS, needed: 5, accepted });
  try {
    await c.join(ENTRY);
    assert.deepEqual(await c.lockHanding, { lock: null, feeLock: null });
    assert.equal(srv.asks.length, 0);
    assert.equal(c.lockHanded, undefined);
  } finally { await srv.close(); }
});

test('a page hook that throws does not stop the hand-off; an accepted promise is waited for first', async () => {
  const srv = await nodesServer((door, node, attempt) => node < 5 || attempt >= 2);
  let calls = 0;
  let accept;
  const accepted = new Promise((r) => { accept = r; });
  const c = clientOn(srv, { fields: FIELDS, needed: 5, accepted, onCommitted: () => { calls++; throw new Error('the page broke'); } });
  try {
    await c.join(ENTRY);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.asks.length, 0, 'a node was asked before the lock was accepted');
    accept();
    const got = await c.lockHanding;
    assert.equal(got.lock.committed, 7, 'the hand-off stopped at the throwing hook');
    assert.equal(calls, 1);
  } finally { await srv.close(); }
});
