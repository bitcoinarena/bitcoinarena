// TWO FIRST MARKS AFTER AN OUTAGE-VOID, ON A REAL FEDERATION (§13B, §13C, §16;
// M3.3-34, ruled 2026-09-12). Run by outage-regtest.sh with
// OUTAGE_SCRIPT=void-then-late.mjs.
//
// The Daily's own 2-of-2 round naming the federation, the signer nodes making the
// round's claim key; a short objection window so the no-quorum rule decides
// inside the run. Signer node B goes down; the player plays at A - an on-time first
// mark at 60 and a mark at 960, past the 900 line - so A records ENTRY_VOID on
// a real outage. B comes back, and ONLY THEN the player sends B a late first
// mark (960, the same session key): two first marks, one parent. Ruled: FORFEIT
// at both signer nodes, never a refund - A's Void stays as history, A refuses the
// refund signature once it holds the proof, and the lock is held as a forfeit
// (until its expiry / W4), not handed back 2 of 2.
//
// Measured here: what each signer node records, what each will sign (its own forfeit
// door), whether the forfeit the player would redeem with exists, whether a
// redeem or a refund goes through before the expiry, and the lock.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import WebSocket from 'ws';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { resultFinality } from '../src/finality.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, fetchRandomness } from '../../blwp-client/src/join.js';
import { lockStake, fundPlayerWallet, handLock, redeemStake, forfeitOf, refundStake } from '../../blwp-client/src/page-lock.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash, O_SCORE, S_STATE } from '../../core/src/state.js';
import { RUN_LIVE } from '../../core/src/rules/gate.js';

// THE STAKE FROM THE PLAYER WALLET (§24A.1, RULED 2026-09-25): the top-up into the player wallet is its own act,
// then the stake is spent from it - the same arguments, the same tab, the same onDeposit.
const fundedLockStake = async (a) => { await fundPlayerWallet(a); return lockStake(a); };

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../blwp-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'void-late-glue-'));
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = glue;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));

const lncli = (...a) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', ...a],
  { timeout: 120000 }, (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out) })));
const pay = async (invoice) => ((await lncli('payinvoice', '--force', invoice)).out.match(/Payment status: [A-Z_]+/) || ['?'])[0];
const bcn = (...a) => new Promise((done) => execFile(`${env.BITCOIN_BIN}/bitcoin-cli`,
  ['-regtest', '-rpcport=30101', '-rpcuser=blwp', '-rpcpassword=blwp', ...a],
  { timeout: 120000 }, (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out || '') })));
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const ws = (base, message) => new Promise((resolve, reject) => {
  const s = new WebSocket(`${base.replace(/^http/, 'ws')}/play`);
  const t = setTimeout(() => { try { s.close(); } catch {} resolve('no answer'); }, 15000);
  s.on('open', () => s.send(message));
  s.on('message', (d, bin) => { clearTimeout(t); resolve(bin ? new Uint8Array(d) : d.toString()); s.close(); });
  s.on('error', (e) => { clearTimeout(t); reject(e); });
});
const answer = (r) => (typeof r === 'string' ? r.slice(0, 90) : `${r.length} bytes`);
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const FIRST = 60;
const PAST = 960;
const hex32 = (st) => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
const lockView = async (lock) => {
  const s = await port.status(lock.outpoint);
  return { federationBlockCount: s.blockCount, lock: s.stored ? 'held' : 'none', blocksLeft: s.stored ? s.stored.blocksLeft : null };
};

const round = await standUpRound({ host: '127.0.0.1', portA: 18595, portB: 18596, stakeMsat: 1000000n,
  objectionWindowMs: 5000n, federationId, invite: env.INVITE, signerNode: { stakeLocks: port } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
const [A, B] = round.nodes;
const signerNode = () => [['A', round.a], ['B', round.b]];
let code = 0;
try {
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed, objectionWindowMs: 5000 });
  if (!claimKey.ok) throw new Error(claimKey.why);
  const { randomness } = await fetchRandomness(round.id, round.nodes);

  const seed = random(32);
  const player = playerFor(withId, { seed, curve: pageCurve });
  const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed: 2 });
  const put = await postHandout(stake, round.nodes, { needed: 2 });
  let paying = Promise.resolve(null);
  const lock = await fundedLockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
    playerPubkey: player.pubkey, LockClient, storage: tab(), onDeposit: (d) => { paying = pay(d.invoice); } });
  const paid = await paying;
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
  say({ step: 'locked', deposit: paid, outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, amountMsat: lock.fields.amountMsat,
    expiration: lock.fields.expiration, handouts: put.accepted, entries: joined, locks: handed.said.map((s) => s.status),
    lockWhy: handed.said.filter((s) => s.status !== 201).map((s) => String(s.why).slice(0, 200)),
    committed: handed.committed, harnessSearch: { tries }, ...(await lockView(lock)) });
  if (!handed.ok) throw new Error(`the signer nodes did not commit the lock (${handed.committed} of ${handed.needed}): not the case this run measures`);

  const recorded = (d) => {
    const sf = d.round.startForfeit(eid);
    const nq = d.round.noQuorum(eid);
    return { entryVoid: !!d.round.entryVoid(eid), lateStart: !!sf, proof: d.round.equivocation(rid, eid).length,
      noQuorum: nq ? nq.outcome : null, finality: resultFinality(d.round, rid, eid).state,
      results: d.round.results(rid, eid).length, forfeitKept: !!d.round.forfeit(eid) };
  };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));

  // SIGNER NODE B GOES DOWN; THE PLAYER PLAYS AT A: first mark 60 (on time), a mark at 960 (past the line).
  await round.b.close();
  const st = init(seedWordForEntry(entry, randomness));
  for (let t = 0; t < FIRST; t++) step(st, ...wordsAt(t));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: FIRST }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: rid, entryId: eid, tick: FIRST, stateHash: hex32(st), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  for (let t = FIRST; t < PAST; t++) step(st, ...wordsAt(t));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: FIRST, ticks: Array.from({ length: PAST - FIRST }, (_, t) => wordsAt(FIRST + t)), liquidations: [] };
  const m2 = { roundId: rid, entryId: eid, tick: PAST, stateHash: hex32(st), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: ed25519.getPublicKey(session) };
  const saidA = [];
  for (const m of [encodeInputBatch(b1), sign(m1), encodeInputBatch(b2), sign(m2)]) saidA.push(answer(await ws(A, m)));
  for (let t = Date.now(); Date.now() - t < 20000 && !round.a.round.entryVoid(eid); await wait(500));
  say({ step: 'B down, the player plays at A: on time, then past the line', saidA, A: recorded(round.a) });

  // B COMES BACK - AND ONLY THEN THE PLAYER SENDS B A SECOND FIRST MARK, from
  // nothing: late (960, the default) or, MODE=ontime, a different ON-TIME one (30).
  await round.restartB();
  const SECOND = env.MODE === 'ontime' ? 30 : PAST;
  const lst = init(seedWordForEntry(entry, randomness));
  for (let t = 0; t < SECOND; t++) step(lst, ...wordsAt(t));
  const lb = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: SECOND }, (_, t) => wordsAt(t)), liquidations: [] };
  const lm = { roundId: rid, entryId: eid, tick: SECOND, stateHash: hex32(lst), inputChainHash: batchId(lb), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  // MODE=lostforward (path 2): signer node A is down while the player sends B the late
  // mark, so B's forward of it to A is lost; A comes back after.
  if (env.MODE === 'lostforward') await round.a.close();
  const saidB = [];
  for (const m of [encodeInputBatch(lb), sign(lm)]) saidB.push(answer(await ws(B, m)));
  if (env.MODE === 'lostforward') { await wait(1000); await round.restartA(); }
  await wait(2000);
  say({ step: `B back; the player sends B a second first mark at ${SECOND} (${SECOND > 900 ? 'late' : 'on time'})`, saidB, A: recorded(round.a), B: recorded(round.b) });

  // BOTH SIGNER NODES CLOSE; THE NO-QUORUM RULE DECIDES AFTER THE RESULT WINDOW.
  const closed = [];
  for (const b of round.nodes) closed.push(answer(await ws(b, `close ${round.id}`)));
  const t0 = Date.now();
  for (; Date.now() - t0 < 90000; await wait(1000)) if (signerNode().every(([, d]) => d.round.noQuorum(eid) || d.round.results(rid, eid).length)) break;
  await wait(2000);
  say({ step: 'both signer nodes closed, the window passed', closed, msToDecided: Date.now() - t0, A: recorded(round.a), B: recorded(round.b) });

  // WHAT EACH SIGNER NODE WILL SIGN: its own forfeit door - A first, then B, then A again
  // (a signer node's door may show the other its evidence).
  const door = async (b) => { const r = await fetch(`${b}/forfeit?round=${round.id}&entry=${toHex(eid)}`); return `${r.status} ${(await r.text()).trim().slice(0, 200)}`; };
  const doors = { A: await door(A), B: await door(B), Aagain: await door(A) };
  const f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes: round.nodes });
  say({ step: 'what each signer node will sign (the refund of the Void lock)', doors, forfeitOf: f.ok ? 'SIGNED' : String(f.why).slice(0, 320),
    A: recorded(round.a), B: recorded(round.b), ...(await lockView(lock)) });

  // THE PLAYER TRIES TO GET THE LOCK BACK BEFORE ITS EXPIRY: redeem, then refund.
  let viaSignerNodes;
  try {
    const r = await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes });
    const one = r.redeems[0];
    viaSignerNodes = { accepted: one.accepted, error: one.error ? String(one.error).slice(0, 160) : null, creditedMsat: one.balance_after - one.balance_before };
  } catch (e) { viaSignerNodes = `refused: ${e.message.slice(0, 200)}`; }
  const rf = (await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes })).refunds[0];
  say({ step: 'the player tries to get the lock back before its expiry', viaSignerNodes,
    refundBeforeExpiry: { accepted: rf.accepted, error: rf.error ? String(rf.error).slice(0, 160) : null,
      federationBlockCount: rf.block_count, expiration: rf.expiration },
    ...(await lockView(lock)) });

  // PATH 5 (EXPIRY=1): PAST THE LOCK'S EXPIRY. Held until then, the lock comes
  // back only through the refund at expiry - the accepted W4 gap, never a
  // committee refund. Measured after the expiry as before it: both signer nodes'
  // records, their forfeit doors, the redeem through the signer nodes, the refund.
  if (env.EXPIRY) {
    const view0 = await lockView(lock);
    const need = Math.max(1, (view0.blocksLeft || 0) + 2);
    // bitcoind here has no wallet: the address is the regtest lnd's own.
    const addr = (JSON.parse((await lncli('newaddress', 'p2wkh')).out || '{}')).address || '';
    const mined = await bcn('-named', 'generatetoaddress', `nblocks=${need}`, `address=${addr}`);
    let view = await lockView(lock);
    for (let t = Date.now(); Date.now() - t < 120000 && view.blocksLeft !== null && view.blocksLeft > 0; await wait(2000)) view = await lockView(lock);
    const doorsAfter = { A: await door(A), B: await door(B) };
    let viaSignerNodesAfter;
    try {
      const r = await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes });
      const one = r.redeems[0];
      viaSignerNodesAfter = { accepted: one.accepted, error: one.error ? String(one.error).slice(0, 160) : null };
    } catch (e) { viaSignerNodesAfter = `refused: ${e.message.slice(0, 200)}`; }
    const rf2 = (await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes })).refunds[0];
    say({ step: 'past the expiry: both signer nodes, their doors, the redeem through the signer nodes, the refund', mined: need, mineError: mined.err,
      viewAtExpiry: view, A: recorded(round.a), B: recorded(round.b), doors: doorsAfter, viaSignerNodes: viaSignerNodesAfter,
      refundAfterExpiry: { accepted: rf2.accepted, error: rf2.error ? String(rf2.error).slice(0, 160) : null,
        federationBlockCount: rf2.block_count, expiration: rf2.expiration,
        creditedMsat: rf2.balance_after !== undefined && rf2.balance_before !== undefined ? rf2.balance_after - rf2.balance_before : null },
      ...(await lockView(lock)) });
  }
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
