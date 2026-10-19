// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ENTRY_VOID (§16) ON A REAL FEDERATION, AND THE REFUND AT ONCE (§23.2).
// Run by outage-regtest.sh after the federation is up.
//
// The Daily's own 2-of-2 round naming the federation, the signer nodes making the
// round's claim key themselves (nothing injected); the round names no start
// deadline (900 ticks). One player locks as the page does and both signer nodes commit
// the lock. Then signer node B goes down, and the player plays at A: a first mark at
// tick 60 - on time - and a mark at tick 960, past the line. Then:
//   A records ENTRY_VOID                         (its offer to B unanswered)
//   B comes back; the forfeit is asked           A shows B the evidence, B records
//                                                the same Void, both signer nodes sign
//   the forfeit verifies under the claim key     over the lock's contract id
//   the player redeems from a later session with only the seed, BEFORE the
//   lock's expiry - the refund at once - and withdraws it
//
// HARNESS WORK, SAID SO: the world secret is searched with the core's own replay
// against the round's actual randomness for a drive still running at tick 961,
// so a mark at 960 is a mark of a run in progress.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import WebSocket from 'ws';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, fetchRandomness } from '../../arena-client/src/join.js';
import { lockStake, fundPlayerWallet, handLock, redeemStake, forfeitOf } from '../../arena-client/src/page-lock.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash, O_SCORE, S_STATE } from '../../nextblock/src/state.js';
import { RUN_LIVE } from '../../nextblock/src/rules/gate.js';

// THE STAKE FROM THE PLAYER WALLET (§24A.1, RULED 2026-09-25): the top-up into the player wallet is its own act,
// then the stake is spent from it - the same arguments, the same tab, the same onDeposit.
const fundedLockStake = async (a) => { await fundPlayerWallet(a); return lockStake(a); };

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../arena-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'outage-glue-'));
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = glue;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));

const lncli = (...a) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', ...a],
  { timeout: 120000 }, (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out) })));
const pay = async (invoice) => ((await lncli('payinvoice', '--force', invoice)).out.match(/Payment status: [A-Z_]+/) || ['?'])[0];
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const ws = (base, message) => new Promise((resolve, reject) => {
  const s = new WebSocket(`${base.replace(/^http/, 'ws')}/play`);
  s.on('open', () => s.send(message));
  s.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); s.close(); });
  s.on('error', reject);
});
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const FIRST = 60;
const PAST = 960;
const hex32 = (st) => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
const entryVoidAt = async (base, eid) => { const r = await fetch(`${base}/entry-void?entry=${toHex(eid)}`); return r.ok ? await r.json() : { status: r.status }; };

const round = await standUpRound({ host: '127.0.0.1', portA: 18591, portB: 18592, stakeMsat: 1000000n,
  federationId, invite: env.INVITE, signerNode: { stakeLocks: port } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
let code = 0;
try {
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed,
    startDeadlineTicks: contract.startDeadlineTicks === undefined ? 'omitted (900)' : contract.startDeadlineTicks });
  if (!claimKey.ok) throw new Error(claimKey.why);
  const { randomness } = await fetchRandomness(round.id, round.nodes);

  const seed = random(32);
  const player = playerFor(withId, { seed, curve: pageCurve });
  const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed: 2 });
  const put = await postHandout(stake, round.nodes, { needed: 2 });
  let paying = Promise.resolve(null);
  const lock = await fundedLockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
    playerPubkey: player.pubkey, LockClient, storage: tab(), onDeposit: (d) => { paying = pay(d.invoice); } });
  await paying;
  const session = ed25519.utils.randomSecretKey();
  const base = { roundId: rid, sessionPubkey: ed25519.getPublicKey(session),
    ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
  // HARNESS: a world in which the fixed drive is still running at tick PAST + 1.
  let entry;
  let tries = 0;
  for (;;) {
    tries++;
    entry = { ...base, worldSecret: random(32) };
    const st = init(seedWordForEntry(entry, randomness));
    let live = true;
    for (let t = 0; t <= PAST && live; t++) { step(st, ...wordsAt(t)); live = st.i32[O_SCORE + S_STATE] === RUN_LIVE; }
    if (live) break;
    if (tries > 20000) throw new Error('no world secret kept the drive running past tick 960');
  }
  const eid = entryId(entry);
  const joined = [];
  for (const b of round.nodes) joined.push((await fetch(`${b}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
  const handed = await handLock({ entryId: eid, fields: lock.fields, nodes: round.nodes, needed: 2 });
  say({ step: 'locked', outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, amountMsat: lock.fields.amountMsat,
    expiration: lock.fields.expiration, handouts: put.accepted, entries: joined, locks: handed.said.map((s) => s.status),
    committed: handed.committed, harnessSearch: { tries } });

  // SIGNER NODE B GOES DOWN, then the player plays at A: first mark 60 (on time), a mark at 960 (past the 900 line).
  await round.b.close();
  const st = init(seedWordForEntry(entry, randomness));
  for (let t = 0; t < FIRST; t++) step(st, ...wordsAt(t));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: FIRST }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: rid, entryId: eid, tick: FIRST, stateHash: hex32(st), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  for (let t = FIRST; t < PAST; t++) step(st, ...wordsAt(t));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: FIRST, ticks: Array.from({ length: PAST - FIRST }, (_, t) => wordsAt(FIRST + t)), liquidations: [] };
  const m2 = { roundId: rid, entryId: eid, tick: PAST, stateHash: hex32(st), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: ed25519.getPublicKey(session) };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const A = round.nodes[0];
  const saidA = [await ws(A, encodeInputBatch(b1)), (await ws(A, sign(m1))).length, await ws(A, encodeInputBatch(b2)), (await ws(A, sign(m2))).length];
  let atA = { status: 404 };
  for (let t = Date.now(); Date.now() - t < 20000 && atA.outcome !== 'ENTRY_VOID'; await wait(500)) atA = await entryVoidAt(A, eid);
  say({ step: 'B down, the player plays at A', saidA, atA: { outcome: atA.outcome || atA.status, evidenceKind: atA.evidenceKind,
    offers: atA.offers, why: atA.why ? atA.why.slice(0, 160) : null } });

  // B COMES BACK; THE FORFEIT OF THE VOID LOCK IS ASKED, AT ONCE.
  await round.restartB();
  const Bnode = round.nodes[1];
  const bBefore = await entryVoidAt(Bnode, eid);
  const asked = Date.now();
  let forfeit = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes: round.nodes });
  for (let t = Date.now(); !forfeit.ok && Date.now() - t < 30000; await wait(1000))
    forfeit = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes: round.nodes });
  const bAfter = await entryVoidAt(Bnode, eid);
  say({ step: 'the Void lock forfeited', ok: forfeit.ok, msAfterAsked: Date.now() - asked, why: forfeit.ok ? null : forfeit.why.slice(0, 300),
    verifies: forfeit.ok && schnorr.verify(fromHex(forfeit.signature), fromHex(forfeit.contractId), claimKey.claimPk.subarray(1)),
    claimPkIsTheRounds: forfeit.ok && forfeit.claimPk === toHex(claimKey.claimPk),
    bBefore: bBefore.outcome || bBefore.status, bAfter: bAfter.outcome || bAfter.status,
    keptBySignerNodes: [round.a, round.b].map((d) => !!d.round.forfeit(eid)),
    resultsAnywhere: [round.a, round.b].map((d) => d.round.results(rid, eid).length) });

  // THE PLAYER'S REDEEM, FROM A LATER SESSION WITH ONLY THE SEED - before the lock's expiry.
  const r = await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes });
  const one = r.redeems[0];
  say({ step: 'redeem from the seed', forfeitVerifies: one.forfeit_verifies, accepted: one.accepted, txid: one.txid,
    error: one.error ? String(one.error).slice(0, 160) : null, federationBlockCount: one.block_count, expiration: one.expiration,
    beforeExpiry: one.block_count < one.expiration, lockBefore: one.stored_before ? 'held' : 'none', lockAfter: one.stored_after ? 'held' : 'none',
    creditedMsat: one.balance_after - one.balance_before, federationFeeMsat: Number(lock.fields.amountMsat) - (one.balance_after - one.balance_before) });
  const withdrawable = BigInt(await r.client.withdrawableMsat());
  const inv = JSON.parse((await lncli('addinvoice', `--amt_msat=${withdrawable}`, '--memo=outage')).out || '{}');
  const wd = JSON.parse(await r.client.withdraw(inv.payment_request));
  const looked = JSON.parse((await lncli('lookupinvoice', inv.r_hash)).out || '{}');
  say({ step: 'withdraw', gateway: wd.gateway, state: wd.state, amountOutMsat: wd.invoice_msat, remainingBalanceMsat: wd.balance_after,
    lndState: looked.state, lndReceivedMsat: looked.amt_paid_msat });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
