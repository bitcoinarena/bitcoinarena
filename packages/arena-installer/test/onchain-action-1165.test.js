// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ON-CHAIN ACTION'S STATE MACHINE (onchain-action.js, kanban #1165): one action of the wallet open at a time, BUILT written before the
// first broadcast, every move compare-and-set, DONE and VOID terminal, the record applied to the state as it is when the action is through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeState } from '../src/state.js';
import { ACTION, onchainAction, settleOpen, transition, openActionOf, lastActionOf, applyOps } from '../src/onchain-action.js';
import { walletOf, addressScript } from '../src/wallet.js';
import { buildSend } from '../src/bond.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const home = () => mkdtempSync(join(tmpdir(), 'onchain-action-'));
const w = walletOf(fromHex('11'.repeat(32)));
const coin = (n = 1) => ({ txid: String(n).padStart(2, '5').repeat(32).slice(0, 64), vout: 1, sats: 100000, height: 157000 });
const send = (sats, c = coin()) => buildSend({ wallet: w, coins: [c], script: addressScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), sats });
const kitOf = ({ refuse = null, seen = undefined } = {}) => {
  const sent = [];
  return { sent, broadcast: async (_c, hex) => { sent.push(hex); if (refuse) throw new Error(refuse); return 'ok'; }, ...(seen === undefined ? {} : { seen: async () => seen }) };
};
const buildOf = (tx, extra = {}) => async () => ({ ok: true, tip: 157070, txs: [{ name: 'send', hex: tx.hex }], ops: [{ op: 'merge', key: 'custody', value: { pegIn: { txid: tx.txid } } }], result: { txid: tx.txid }, ...extra });

test('a state.json from before #1165 (no onchain) reads as no action open; an action then runs BUILT -> SENT -> DONE and records once', async () => {
  const h = home();
  writeFileSync(join(h, 'state.json'), JSON.stringify({ network: 'testnet4', chain: { kind: 'core' }, bond: { txid: 'aa'.repeat(32) }, custody: { pegInSats: 50000 } }));
  const st = nodeState(h);
  assert.equal(openActionOf(st.read()), null);
  const tx = send(50000);
  const seenPhases = [];
  const kit = kitOf();
  const orig = kit.broadcast;
  kit.broadcast = async (c, hex) => { seenPhases.push(openActionOf(st.read()).phase); return orig(c, hex); };   // written BEFORE it is sent
  const r = await onchainAction({ state: st, kind: 'peg-in x', once: true, chainKit: kit, build: buildOf(tx) });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(seenPhases, [ACTION.BUILT], 'the bytes were on disk before the broadcast');
  const s = st.read();
  assert.equal(openActionOf(s), null);
  assert.deepEqual([lastActionOf(s, 'peg-in x').phase, s.custody.pegIn.txid, s.custody.pegInSats], [ACTION.DONE, tx.txid, 50000], 'recorded, the rest of custody kept');
  assert.ok(!JSON.stringify(lastActionOf(s, 'peg-in x')).includes(tx.hex), 'a closed action keeps no bytes');
  // once: asked again, the one done answers - nothing built, nothing sent
  let built = 0;
  const again = await onchainAction({ state: st, kind: 'peg-in x', once: true, chainKit: kit, build: async () => { built++; return buildOf(tx)(); } });
  assert.deepEqual([again.ok, again.already, built, kit.sent.length], [true, true, 0, 1]);
});

test('while an action is open, nothing else is built from the wallet; it is sent again (the same bytes) at every ask', async () => {
  const st = nodeState(home());
  st.save({ chain: { kind: 'core' } });
  const tx = send(50000);
  const down = kitOf({ refuse: 'fetch failed (ECONNREFUSED)' });
  const r = await onchainAction({ state: st, kind: 'peg-in x', chainKit: down, build: buildOf(tx) });
  assert.equal(r.pending, true);
  assert.equal(openActionOf(st.read()).phase, ACTION.BUILT);
  let built = 0;
  const other = await onchainAction({ state: st, kind: 'add-bond', chainKit: down, build: async () => { built++; return buildOf(send(1000))(); } });
  assert.deepEqual([other.ok, other.pending, built], [false, true, 0], 'another kind waits: no second transaction from the same coins');
  assert.match(other.why, /signed and kept but not through yet/);
  assert.deepEqual(down.sent, [tx.hex, tx.hex], 'the same bytes, twice');
  assert.equal(openActionOf(st.read()).tries, 2);
  const up = kitOf();
  const back = await settleOpen(st, { chainKit: up });
  assert.equal(back.done.phase, ACTION.DONE);
  assert.deepEqual(up.sent, [tx.hex]);
  assert.equal(st.read().custody.pegIn.txid, tx.txid);
});

test('"already in the mempool / chain" is a success; a conflict seen nowhere since it was built is VOID, and then the wallet builds again', async () => {
  const st = nodeState(home());
  st.save({ chain: { kind: 'core' } });
  const tx = send(50000);
  await onchainAction({ state: st, kind: 'k', chainKit: kitOf({ refuse: 'down' }), build: buildOf(tx) });
  const already = await settleOpen(st, { chainKit: kitOf({ refuse: 'bitcoind: Transaction already in block chain' }) });
  assert.equal(already.done.phase, ACTION.DONE);

  const tx2 = send(40000, coin(2));
  await onchainAction({ state: st, kind: 'k2', chainKit: kitOf({ refuse: 'down' }), build: buildOf(tx2) });
  // a conflict, but no way to ask the chain: it stays open (unknown is never "not there")
  assert.ok((await settleOpen(st, { chainKit: kitOf({ refuse: 'bitcoind: bad-txns-inputs-missingorspent' }) })).open);
  // a conflict the chain has in a block (the funding is "missing inputs" once its bond spent it): DONE, not VOID
  assert.equal((await settleOpen(st, { chainKit: kitOf({ refuse: 'bitcoind: bad-txns-inputs-missingorspent', seen: true }) })).done.phase, ACTION.DONE);

  const tx3 = send(40000, coin(3));
  await onchainAction({ state: st, kind: 'k3', chainKit: kitOf({ refuse: 'down' }), build: buildOf(tx3) });
  const v = await settleOpen(st, { chainKit: kitOf({ refuse: 'bitcoind: txn-mempool-conflict', seen: false }) });
  assert.equal(v.void.phase, ACTION.VOID);
  assert.equal(openActionOf(st.read()), null, 'the wallet is free again');
  assert.equal(st.read().custody.pegIn.txid, tx2.txid, 'a void action records nothing');
  const next = await onchainAction({ state: st, kind: 'k3', chainKit: kitOf(), build: buildOf(send(30000, coin(4))) });
  assert.equal(next.ok, true, 'built anew after a void');
});

test('every move is compare-and-set: the wrong action, the wrong phase, a move that is not one, a terminal state', () => {
  const st = nodeState(home());
  st.save({ onchain: { seq: 3, open: { id: 'a1', kind: 'k', phase: ACTION.BUILT, txs: [], ops: [{ op: 'set', key: 'x', value: 1 }] } } });
  assert.equal(transition(st, 'other', ACTION.BUILT, ACTION.SENT), null, 'not the open action');
  assert.equal(transition(st, 'a1', ACTION.SENT, ACTION.DONE), null, 'not in that phase');
  assert.equal(transition(st, 'a1', ACTION.BUILT, ACTION.DONE), null, 'BUILT -> DONE is no move: it is sent first');
  assert.ok(transition(st, 'a1', ACTION.BUILT, ACTION.SENT));
  assert.equal(st.read().x, undefined, 'nothing recorded before DONE');
  assert.ok(transition(st, 'a1', ACTION.SENT, ACTION.DONE));
  assert.deepEqual([st.read().x, st.read().onchain.seq], [1, 4]);
  assert.equal(transition(st, 'a1', ACTION.SENT, ACTION.DONE), null, 'DONE once');
  assert.equal(transition(st, 'a1', ACTION.DONE, ACTION.VOID), null, 'DONE is terminal');
});

test('the record is applied to the state as it is when the action is through, not to the copy it was built on', async () => {
  const st = nodeState(home());
  st.save({ chain: { kind: 'core' }, bond: { txid: 'b1', sats: '50000' }, custody: { pegInSats: 1 } });
  const tx = send(50000);
  const kit = kitOf();
  const orig = kit.broadcast;
  // another process saves while this one sends (the owner page, the custody agent): its fields stay
  kit.broadcast = async (c, hex) => { st.merge('custody', { claimAtMs: 42 }); st.save({ bonds: [{ txid: 'b1', sats: '50000' }, { txid: 'b2', sats: '1000' }] }); return orig(c, hex); };
  await onchainAction({ state: st, kind: 'k', chainKit: kit, build: async () => ({ ok: true, tip: 1, txs: [{ hex: tx.hex }],
    ops: [{ op: 'merge', key: 'custody', value: { pegIn: { txid: tx.txid } } }, { op: 'push', key: 'bonds', values: [{ txid: 'b3' }] }, { op: 'done', step: 'bond' }] }) });
  const s = st.read();
  assert.deepEqual([s.custody.claimAtMs, s.custody.pegIn.txid, s.custody.pegInSats], [42, tx.txid, 1]);
  assert.deepEqual(s.bonds.map((b) => b.txid), ['b1', 'b2', 'b3']);
  assert.ok(s.done.bond);
  assert.deepEqual(applyOps({ bond: { txid: 'b1' } }, [{ op: 'push', key: 'bonds', values: [{ txid: 'b9' }] }]).bonds.map((b) => b.txid), ['b1', 'b9'], 'a state with only `bond` reads as [bond] (bondsOf)');
  assert.deepEqual(applyOps({ bond: { txid: 'b1' }, bonds: [{ txid: 'b1' }, { txid: 'b2' }] }, [{ op: 'replace-first', value: { txid: 'n1' } }]).bonds.map((b) => b.txid), ['n1', 'b2']);
  assert.ok(readFileSync(join(st.home, 'state.json'), 'utf8').includes('"onchain"'));
});
