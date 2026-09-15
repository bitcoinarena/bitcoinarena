// THE PAID WALK-AWAY ON A REAL FEDERATION (§15, §23.2; M3.3-34 walk-away step 6).
// Run by outage-regtest.sh with OUTAGE_SCRIPT=walk-away.mjs.
//
// The Daily's own 2-of-2 round naming the federation, the signer nodes making the
// round's claim key themselves; a short objection window so FINAL comes inside
// the run. Player W locks as the page locks, both signer nodes commit the lock - and W
// sends nothing at all. Both signer nodes close. Ruled (2026-09-12): no first mark is
// FORFEIT, score 0, signed by both signer nodes, final 2 of 2 - never ENTRY_VOID, never
// a refund. So: the forfeit door refuses (FORFEIT 0 is not a qualifier), and W
// cannot redeem the lock before its expiry - not through the signer nodes, not by
// refund. And past the expiry the refund goes through: the money hole every
// loser has until W4 claims a forfeited lock (listed, parked), measured here.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { resultFinality } from '../src/finality.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor } from '../../blwp-client/src/join.js';
import { lockStake, handLock, redeemStake, forfeitOf, refundStake } from '../../blwp-client/src/page-lock.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../blwp-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'walk-away-glue-'));
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = glue;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));

const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 120000, maxBuffer: 1 << 20 },
  (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out || '').trim() })));
const lncli = (...a) => run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', ...a]);
const bcn = (...a) => run(`${env.BITCOIN_BIN}/bitcoin-cli`, ['-regtest', '-rpcport=30101', '-rpcuser=blwp', '-rpcpassword=blwp', ...a]);
const pay = async (invoice) => ((await lncli('payinvoice', '--force', invoice)).out.match(/Payment status: [A-Z_]+/) || ['?'])[0];
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const lockView = async (lock) => {
  const s = await port.status(lock.outpoint);
  return { federationBlockCount: s.blockCount, lock: s.stored ? 'held' : 'none', blocksLeft: s.stored ? s.stored.blocksLeft : null };
};
const closeSignerNode = (base, rid) => new Promise((resolve) => {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/play`);
  const t = setTimeout(() => { try { ws.close(); } catch {} resolve('no answer'); }, 15000);
  ws.on('open', () => ws.send(`close ${rid}`));
  ws.on('message', (d) => { clearTimeout(t); resolve(String(d).slice(0, 60)); ws.close(); });
  ws.on('error', (e) => { clearTimeout(t); resolve(`error ${e.message}`); });
});

const WINDOW_MS = 5000n;
const round = await standUpRound({ host: '127.0.0.1', portA: 18597, portB: 18598, stakeMsat: 1000000n,
  objectionWindowMs: WINDOW_MS, federationId, invite: env.INVITE, signerNode: { stakeLocks: port } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
const signerNodes = [['A', round.a], ['B', round.b]];
let code = 0;
try {
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed, objectionWindowMs: WINDOW_MS });
  if (!claimKey.ok) throw new Error(claimKey.why);

  // W: LOCKED AS THE PAGE LOCKS, COMMITTED AT BOTH SIGNER NODES - AND THEN NOTHING.
  const seed = random(32);
  const player = playerFor(withId, { seed, curve: pageCurve });
  const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed: 2 });
  const put = await postHandout(stake, round.nodes, { needed: 2 });
  let paying = Promise.resolve(null);
  const lock = await lockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
    playerPubkey: player.pubkey, LockClient, storage: tab(), onDeposit: (d) => { paying = pay(d.invoice); } });
  const paid = await paying;
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, sessionPubkey: ed25519.getPublicKey(session),
    ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
  const eid = entryId(entry);
  const joined = [];
  for (const b of round.nodes) joined.push((await fetch(`${b}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
  const handed = await handLock({ entryId: eid, fields: lock.fields, nodes: round.nodes, needed: 2 });
  say({ step: 'W locked, joined, committed - and sends nothing', deposit: paid, outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`,
    amountMsat: lock.fields.amountMsat, expiration: lock.fields.expiration, handouts: put.accepted, entries: joined,
    locks: handed.said.map((s) => s.status), committed: handed.committed, ...(await lockView(lock)) });

  // BOTH SIGNER NODES CLOSE THE ROUND, THEN FINAL 2 OF 2 (the window is short here).
  const closed = [];
  for (const b of round.nodes) closed.push(await closeSignerNode(b, round.id));
  const at = (d) => {
    const rs = d.round.results(rid, eid).map((r) => ({ p: decodePlayerResult(splitSignedResult(r.bytes).body), by: toHex(r.nodePubkey) }));
    return { results: [...new Set(rs.map((r) => `${r.p.outcome}/${r.p.score}`))], transcripts: [...new Set(rs.map((r) => toHex(r.p.transcriptHash).slice(0, 8)))],
      signers: new Set(rs.map((r) => r.by)).size, finality: resultFinality(d.round, rid, eid).state, entryVoid: !!d.round.entryVoid(eid),
      startForfeit: !!d.round.startForfeit(eid), noQuorum: d.round.noQuorum(eid) ? d.round.noQuorum(eid).outcome : null };
  };
  const t0 = Date.now();
  for (; Date.now() - t0 < 90000; await wait(1000)) if (signerNodes.every(([, d]) => at(d).finality === 'FINAL')) break;
  say({ step: 'both signer nodes closed', closed, msToFinal: Date.now() - t0, A: at(round.a), B: at(round.b) });

  // THE FORFEIT DOOR: FORFEIT 0 IS NOT A QUALIFIER.
  const f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes: round.nodes });
  say({ step: 'the forfeit of W\'s lock asked', ok: f.ok, why: f.ok ? null : String(f.why).slice(0, 320),
    keptBySignerNodes: signerNodes.map(([, d]) => !!d.round.forfeit(eid)), ...(await lockView(lock)) });

  // W TRIES TO GET THE LOCK BACK BEFORE ITS EXPIRY.
  let viaSignerNodes;
  try { await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes }); viaSignerNodes = 'REDEEMED'; }
  catch (e) { viaSignerNodes = `refused: ${e.message.slice(0, 200)}`; }
  const rf = (await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes })).refunds[0];
  say({ step: 'W tries to redeem before the expiry', viaSignerNodes,
    refundBeforeExpiry: { accepted: rf.accepted, error: rf.error ? String(rf.error).slice(0, 160) : null,
      federationBlockCount: rf.block_count, expiration: rf.expiration, lockAfter: rf.stored_after ? 'held' : 'none' },
    ...(await lockView(lock)) });

  // AND PAST THE EXPIRY: THE MONEY HOLE UNTIL W4 (a loser's lock refunds at expiry).
  const view0 = await lockView(lock);
  const need = Math.max(1, (view0.blocksLeft || 0) + 2);
  // bitcoind here has no wallet: the address is the regtest lnd's own.
  const addr = (JSON.parse((await lncli('newaddress', 'p2wkh')).out || '{}')).address || '';
  const mined = await bcn('-named', 'generatetoaddress', `nblocks=${need}`, `address=${addr}`);
  let view = await lockView(lock);
  for (let t = Date.now(); Date.now() - t < 120000 && view.blocksLeft !== null && view.blocksLeft > 0; await wait(2000)) view = await lockView(lock);
  const rf2 = (await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes })).refunds[0];
  say({ step: 'past the expiry: W refunds', mined: need, mineError: mined.err, viewBefore: view,
    refundAfterExpiry: { accepted: rf2.accepted, error: rf2.error ? String(rf2.error).slice(0, 160) : null,
      federationBlockCount: rf2.block_count, expiration: rf2.expiration, lockAfter: rf2.stored_after ? 'held' : 'none',
      creditedMsat: rf2.balance_after !== undefined && rf2.balance_before !== undefined ? rf2.balance_after - rf2.balance_before : null },
    ...(await lockView(lock)) });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
