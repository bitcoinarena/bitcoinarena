// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1232 (audit 3 #1210 CRASH-1): the arbiter broadcast path B before it recorded it; a lost answer left nothing kept, and once the slash
// confirmed the next pass read the spent bond as "nothing to do" - its escrow never paid out. Now the slash is recorded (its txid) before the
// broadcast, a pass that finds that txid on the chain or in the mempool takes it as posted, post() takes "already in the mempool" as sent,
// and the state is written whole or not at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intentLanded, writeJsonAtomic, post, resumeIntent, resumeSlashIntent, payOutSlash } from '../src/arbiter.js';

test('#1232 a recorded slash is found in the mempool, in a block without txindex (its escrow output), or not at all', async () => {
  const TX = 'ab'.repeat(32);
  const chain = (mempool, utxo) => async (m, p) => {
    if (m === 'getrawtransaction') { if (mempool && p[0] === TX) return '0200'; throw new Error('No such mempool or blockchain transaction'); }
    if (m === 'gettxout') return utxo && p[0] === TX && p[1] === 1 ? { value: 0.001 } : null;
    throw new Error(`no ${m}`);
  };
  assert.equal(await intentLanded(chain(true, false), TX), true, 'in the mempool');
  assert.equal(await intentLanded(chain(false, true), TX), true, 'confirmed, its escrow output unspent');
  assert.equal(await intentLanded(chain(false, false), TX), false, 'nowhere: the slash was never sent');
});

test('#1232 post: the same bytes already in the mempool are the transaction posted, its answer lost; another refusal is still a refusal', async () => {
  let sent = 0;
  const rpc = (reason) => async (m) => {
    if (m === 'testmempoolaccept') return [{ txid: 'cd'.repeat(32), allowed: !reason, 'reject-reason': reason }];
    if (m === 'sendrawtransaction') { sent++; return 'cd'.repeat(32); }
    throw new Error(m);
  };
  const again = await post(rpc('txn-already-in-mempool'), '00');
  assert.deepEqual([again.ok, again.txid, again.again, sent], [true, 'cd'.repeat(32), true, 0]);
  const conflict = await post(rpc('txn-mempool-conflict'), '00');
  assert.equal(conflict.ok, false);
  const fresh = await post(rpc(null), '00');
  assert.deepEqual([fresh.ok, sent], [true, 1]);
});

test('#1232 the state is written whole or not at all: a write that dies before the rename leaves the last good state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arbiter-1232-'));
  const path = join(dir, 'state.json');
  writeJsonAtomic(path, { handled: { a: 1 } });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { handled: { a: 1 } });
  // a stop between the temp write and the rename (the rename never happens)
  const dying = { writeFileSync, openSync: () => { throw new Error('no fd'); }, fsyncSync() {}, closeSync() {}, renameSync: () => { throw new Error('the process stopped here'); } };
  assert.throws(() => writeJsonAtomic(path, { handled: { a: 1, b: 2 } }, { fs: dying }));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { handled: { a: 1 } }, 'the state is the last good one, not a truncated file');
  assert.ok(existsSync(`${path}.tmp`), 'the unfinished write is beside it, never over it');
});

// the escrow spend after path B (payOutSlash) had the same order: broadcast, then the record
const ESC = 'cd'.repeat(32), PATHB = 'ef'.repeat(32);
const escrowChain = ({ landed = false, inputSpent = false, refuse = null } = {}) => {
  const sent = [];
  const rpc = async (m, p) => {
    if (m === 'getrawtransaction') { if (landed && p[0] === ESC) return '0200'; throw new Error('No such mempool or blockchain transaction'); }
    if (m === 'gettxout') return p[0] === PATHB && !inputSpent ? { value: 0.001 } : null;
    if (m === 'testmempoolaccept') return [refuse ? { txid: ESC, allowed: false, 'reject-reason': refuse } : { txid: ESC, allowed: true }];
    if (m === 'sendrawtransaction') { sent.push(p[0]); return ESC; }
    throw new Error(`no ${m}`);
  };
  return { rpc, sent };
};

test('#1232 resumeIntent: found, its input spent (only the set signs it), sent again, or refused and dropped', async () => {
  const intent = { txid: ESC, hex: '02abcd' }, input = { txid: PATHB, vout: 1 };
  assert.deepEqual(await resumeIntent(escrowChain({ landed: true }).rpc, intent, input), { ok: true, landed: true });
  assert.deepEqual(await resumeIntent(escrowChain({ inputSpent: true }).rpc, intent, input), { ok: true, inferred: true });
  const again = escrowChain();
  assert.deepEqual(await resumeIntent(again.rpc, intent, input), { ok: true, again: true });
  assert.deepEqual(again.sent, ['02abcd'], 'the same bytes, not a new transaction');
  const refused = await resumeIntent(escrowChain({ refuse: 'min relay fee not met' }).rpc, intent, input);
  assert.equal(refused.ok, false); assert.equal(refused.drop, true);
});

test('#1232 payOutSlash resumes a pending stage: a lost answer no longer strands the peg-ins', async () => {
  const { arbitrationMembers } = await import('../src/arbiter.js');
  const set = arbitrationMembers('regtest');
  const stage = () => ({ txid: ESC, feeSats: '1000', players: true, pegIns: [{ federation: 'aa'.repeat(32), address: 'tb1qpegin', sats: '99000', playersMsat: '0', vout: 0 }], kept: null,
    pending: { txid: ESC, hex: '02abcd', input: { txid: PATHB, vout: 1 } } });
  const v = { posted: PATHB, escrowSats: '100000', players: [], stages: [stage()] };
  const r = await payOutSlash({ proof: 'aa'.repeat(32), v, set, rpc: escrowChain({ inputSpent: true }).rpc, bin: '/bin/false', dirOf: () => null });
  console.log('  MEASURED #1232 stage resume:', JSON.stringify({ stages: v.stages.length, pending: !!v.stages[0].pending, next: r.why.slice(0, 40) }));
  assert.equal(v.stages.length, 1); assert.equal(v.stages[0].pending, undefined);
  assert.match(r.why, /no client of federation/, 'on to the peg-ins, not "no unspent escrow"');
  const w = { posted: PATHB, escrowSats: '100000', players: [], stages: [stage()] };
  const refused = await payOutSlash({ proof: 'aa'.repeat(32), v: w, set, rpc: escrowChain({ refuse: 'min relay fee not met' }).rpc, bin: '/bin/false', dirOf: () => null });
  assert.match(refused.why, /refused/); assert.equal(w.stages.length, 0, 'dropped: the next pass builds it anew');
});

// KANBAN #1357 (audit 4 fixesA-3): the slash intent kept only a txid. A node that lost the relayed slash A answered "not landed", the pass built
// the slash again at a later tip (another locktime, txid B) and recorded B, while the peers mined A - payOutSlash looked for B's escrow forever.
// Now the intent keeps A's bytes and its bond, and a pass sends A again; it is built anew only when refused with the bond unspent, blocks later.
test('#1257 a lost intent is resent, not rebuilt', async () => {
  const A = 'aa'.repeat(32), BOND = { txid: 'bb'.repeat(32), vout: 0 };
  const intent = { txid: A, hex: '02aa', bond: BOND, slashHeight: 100 };
  const node = ({ tip, accept, bondUnspent = true }) => { const sent = []; return { sent, rpc: async (m, p) => {
    if (m === 'getrawtransaction') throw new Error('No such mempool or blockchain transaction');   // this node lost A
    if (m === 'gettxout') return p[0] === BOND.txid && bondUnspent ? { value: 0.5 } : null;
    if (m === 'testmempoolaccept') return [{ txid: A, allowed: accept, 'reject-reason': accept ? undefined : 'bad-txns-inputs-missingorspent' }];
    if (m === 'sendrawtransaction') { sent.push(p[0]); return A; }
    if (m === 'getblockcount') return tip;
    throw new Error(m);
  } }; };
  const lost = node({ tip: 101, accept: true });
  const r1 = await resumeSlashIntent(lost.rpc, intent);
  const spent = await resumeSlashIntent(node({ tip: 101, accept: false, bondUnspent: false }).rpc, intent);
  const refusedEarly = await resumeSlashIntent(node({ tip: 103, accept: false }).rpc, intent);
  const refusedLate = await resumeSlashIntent(node({ tip: 106, accept: false }).rpc, intent);
  console.log('  MEASURED #1357 resume:', JSON.stringify({ lostIntent: r1.step, resentBytes: lost.sent, bondSpent: spent.step, refusedAt103: refusedEarly.step, refusedAt106: refusedLate.step }));
  assert.equal(r1.step, 'posted'); assert.deepEqual(lost.sent, ['02aa'], 'A\'s own bytes are sent again, nothing is built');
  assert.equal(spent.step, 'posted', 'the bond spent: only this set signs a spend of it - the recorded slash');
  assert.equal(refusedEarly.step, 'wait', 'refused 3 blocks on: no new build while A may still confirm');
  assert.equal(refusedLate.step, 'rebuild');
});
