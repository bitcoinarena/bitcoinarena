// THE CLOSED-CLAIM TRUST BOUNDARY (§16, §13C, §23.2) ON A REAL FEDERATION.
// Run by outage-regtest.sh with OUTAGE_SCRIPT=closed-claim.mjs.
//
// The Daily's own 2-of-2 round naming the federation, the signer nodes making the
// round's claim key themselves; the round names no start deadline (900). Two
// players lock as the page does and both signer nodes commit both locks. Both signer nodes
// stay up and open throughout. Signer node A lies; B is honest.
//
//   (1) FORGED: player X sends nothing. A invents a first mark for X's entry -
//       signed by a key that is not X's session key - signs its own receipt
//       over it, plants its own ENTRY_VOID and hands B the mark with "closed".
//       B must refuse it and record nothing; no forfeit; X's lock stays held,
//       and X cannot redeem before the lock's expiry - not without a forfeit,
//       not with one A signed alone, not by refund.
//   (2) REAL: player Y's own on-time first mark reaches A only; A keeps it from
//       B, plants its own ENTRY_VOID ("closed") and hands B the same claim with
//       Y's real mark. B records ENTRY_VOID; the signer nodes forfeit; the forfeit
//       pays only Y's refund key - a stranger's key and a signer node's key are
//       refused by the guardians - and Y redeems from the seed before expiry,
//       withdraws, and the lock is gone.
//
// HARNESS WORK, SAID SO: the lying signer node is written into A's own store (its
// Round), not through its server - a lying signer node controls its own store and
// its own forwards. B is reached only over HTTP, as any peer reaches it.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort, contractArgs } from '../src/stake-lock-port.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, fetchRandomness } from '../../blwp-client/src/join.js';
import { lockStake, handLock, redeemStake, forfeitOf, refundStake, lockSecretFor, lockStoreFor } from '../../blwp-client/src/page-lock.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../protocol/src/receipt.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../blwp-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'closed-claim-glue-'));
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
// THE GUARDIANS ASKED DIRECTLY, with any signer: the stock client's own redeem,
// which - unlike the page's lock client - does not stop a key that is not the
// refund key before it reaches the guardians.
const guardianRedeem = (lock, signerSecret, forfeitSig) => new Promise((done) => execFile(env.LOCK_BIN,
  ['--mode', 'redeem', '--data-dir', `${P}/client`, '--outpoint', `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`,
    '--signer-secret', toHex(signerSecret), '--witness', 'cancel', '--forfeit-sig', forfeitSig, ...contractArgs(lock.fields)],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 20 }, (err, out, errOut) => {
    const line = String(out || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (!line) return done({ error: String(errOut || (err && err.message) || '').trim().split('\n').pop().slice(0, 200) });
    const j = JSON.parse(line);
    done({ accepted: j.accepted, forfeitVerifies: j.forfeit_verifies_under_claim_pk, signerIsRefundPk: j.signer_is_refund_pk,
      error: j.error ? String(j.error).slice(0, 200) : null, blockCount: j.block_count_at_redeem, expiration: j.expiration,
      lockAfter: j.stored_after ? 'held' : 'none' });
  }));
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const FIRST = 60;
const hex32 = (st) => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
const entryVoidAt = async (base, eid) => { const r = await fetch(`${base}/entry-void?entry=${toHex(eid)}`); return r.ok ? await r.json() : { status: r.status }; };
const postFirstMark = async (base, body) => {
  const r = await fetch(`${base}/first-mark`, { method: 'POST', body: JSON.stringify(body) });
  let j;
  try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, entryVoid: !!j.entryVoid, receipt: !!j.receipt, why: j.why ? String(j.why).slice(0, 120) : undefined };
};
const lockView = async (lock) => {
  const s = await port.status(lock.outpoint);
  return { federationBlockCount: s.blockCount, lock: s.stored ? 'held' : 'none', blocksLeft: s.stored ? s.stored.blocksLeft : null };
};

const round = await standUpRound({ host: '127.0.0.1', portA: 18597, portB: 18598, stakeMsat: 1000000n,
  federationId, invite: env.INVITE, signerNode: { stakeLocks: port } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
const A = round.nodes[0];
const B = round.nodes[1];
const signerNodeA = round.a.round;
// SIGNER NODE A'S OWN SIGNED RECEIPT OVER ANY CHECKPOINT ID - what a lying signer node can always make.
const receiptByA = (id) => {
  const r = { checkpointId: id, receivedAtMs: BigInt(Date.now()), nodePubkey: signerNodeA.pubkey };
  return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), signerNodeA.identity.secret));
};
let code = 0;
try {
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed,
    startDeadlineTicks: contract.startDeadlineTicks === undefined ? 'omitted (900)' : contract.startDeadlineTicks });
  if (!claimKey.ok) throw new Error(claimKey.why);
  const { randomness } = await fetchRandomness(round.id, round.nodes);

  // TWO PLAYERS, EACH LOCKED AS THE PAGE LOCKS AND COMMITTED AT BOTH SIGNER NODES.
  async function joinPlayer(name) {
    const seed = random(32);
    const player = playerFor(withId, { seed, curve: pageCurve });
    const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed: 2 });
    const put = await postHandout(stake, round.nodes, { needed: 2 });
    let paying = Promise.resolve(null);
    const lock = await lockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
      playerPubkey: player.pubkey, LockClient, storage: tab(), onDeposit: (d) => { paying = pay(d.invoice); } });
    await paying;
    const session = ed25519.utils.randomSecretKey();
    const entry = { roundId: rid, sessionPubkey: ed25519.getPublicKey(session),
      ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
    const eid = entryId(entry);
    const joined = [];
    for (const b of round.nodes) joined.push((await fetch(`${b}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
    const handed = await handLock({ entryId: eid, fields: lock.fields, nodes: round.nodes, needed: 2 });
    say({ step: `locked ${name}`, outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, amountMsat: lock.fields.amountMsat,
      expiration: lock.fields.expiration, handouts: put.accepted, entries: joined, locks: handed.said.map((s) => s.status), committed: handed.committed });
    return { seed, player, lock, session, entry, eid };
  }
  const X = await joinPlayer('X (path 1, forged)');
  const Y = await joinPlayer('Y (path 2, real)');
  const askForfeit = async (eid) => {
    const asked = Date.now();
    let f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes: round.nodes });
    for (let t = Date.now(); !f.ok && Date.now() - t < 20000; await wait(1000)) f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes: round.nodes });
    return { f, ms: Date.now() - asked };
  };

  // ---- (1) FORGED: X SENT NOTHING; A INVENTS X'S FIRST MARK AND CLAIMS "CLOSED".
  {
    const fakeKey = ed25519.utils.randomSecretKey();
    const fake = { roundId: rid, entryId: X.eid, tick: FIRST, stateHash: random(32), inputChainHash: GENESIS,
      previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(fakeKey) };
    const fakeBytes = joinSigned(encodeCheckpoint(fake), ed25519.sign(checkpointId(fake), fakeKey));
    signerNodeA.putEntryVoid({ entryId: X.eid, roundId: rid, firstMark: fakeBytes, evidenceKind: 'closed', evidence: null, why: 'planted by a lying signer node' });
    const bAnswer = await postFirstMark(B, { mark: toHex(fakeBytes), batches: [], receipt: toHex(receiptByA(checkpointId(fake))),
      entryVoid: { kind: 'closed', evidence: null } });
    await wait(1000);
    const atB = await entryVoidAt(B, X.eid);
    const atA = await entryVoidAt(A, X.eid);
    say({ step: '(1) A hands B an invented first mark of X, its own receipt over it, and "closed"', bAnswer,
      atB: atB.outcome || atB.status, atA: atA.outcome || atA.status, bHoldsTheMark: round.b.round.holdsMark(checkpointId(fake)),
      bRoundState: round.b.round.get(rid).state === 1 ? 'closed' : 'open' });

    const { f, ms } = await askForfeit(X.eid);
    say({ step: '(1) the forfeit of X\'s lock asked', ok: f.ok, msAfterAsked: ms, why: f.ok ? null : f.why.slice(0, 320),
      keptBySignerNodes: [round.a, round.b].map((d) => !!d.round.forfeit(X.eid)), ...(await lockView(X.lock)) });

    // X TRIES EVERY WAY OUT BEFORE THE EXPIRY.
    let viaSignerNodes;
    try { await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed: X.seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes }); viaSignerNodes = 'REDEEMED'; }
    catch (e) { viaSignerNodes = `refused: ${e.message.slice(0, 200)}`; }
    // A "forfeit" A signed alone over the lock's contract id, with its node key.
    const cid = await port.contractId(X.lock.fields);
    const aloneSig = toHex(schnorr.sign(fromHex(cid), signerNodeA.identity.secret));
    const xSecret = lockSecretFor(X.seed, rid);
    const xClient = await LockClient.join(env.INVITE, toHex(contract.federationId), toHex(xSecret), lockStoreFor(tab(), rid, xSecret));
    let alone;
    try {
      alone = JSON.parse(await xClient.redeem(toHex(X.lock.outpoint.txid), Number(X.lock.outpoint.outIdx),
        JSON.stringify(lockFieldsToJson(X.lock.fields)), aloneSig, toHex(X.player.secret)));
      alone = { forfeitVerifies: alone.forfeit_verifies, accepted: alone.accepted, error: alone.error ? String(alone.error).slice(0, 160) : null,
        federationBlockCount: alone.block_count, expiration: alone.expiration, lockAfter: alone.stored_after ? 'held' : 'none' };
    } catch (e) { alone = { thrown: String(e.message || e).slice(0, 160) }; }
    const rf = (await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed: X.seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes })).refunds[0];
    say({ step: '(1) X tries to redeem before the expiry', viaSignerNodes, withAForfeitAAloneSigned: alone,
      refundBeforeExpiry: { accepted: rf.accepted, error: rf.error ? String(rf.error).slice(0, 160) : null,
        federationBlockCount: rf.block_count, expiration: rf.expiration, lockAfter: rf.stored_after ? 'held' : 'none' },
      ...(await lockView(X.lock)) });
  }

  // ---- (2) REAL: Y'S OWN ON-TIME FIRST MARK REACHES A ONLY; A CLOSES IT EARLY ON B.
  {
    const st = init(seedWordForEntry(Y.entry, randomness));
    for (let t = 0; t < FIRST; t++) step(st, ...wordsAt(t));
    const b1 = { roundId: rid, entryId: Y.eid, previousHash: GENESIS, firstTick: 0, ticks: Array.from({ length: FIRST }, (_, t) => wordsAt(t)), liquidations: [] };
    const m1 = { roundId: rid, entryId: Y.eid, tick: FIRST, stateHash: hex32(st), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS,
      sessionPubkey: ed25519.getPublicKey(Y.session) };
    const signedM1 = joinSigned(encodeCheckpoint(m1), ed25519.sign(checkpointId(m1), Y.session));
    signerNodeA.batch(encodeInputBatch(b1));
    const receiptA = signerNodeA.checkpoint(signedM1);        // A takes Y's mark - and keeps it from B
    signerNodeA.putEntryVoid({ entryId: Y.eid, roundId: rid, firstMark: signedM1, evidenceKind: 'closed', evidence: null, why: 'A closed early, by its own word' });
    const bAnswer = await postFirstMark(B, { mark: toHex(signedM1), batches: [toHex(encodeInputBatch(b1))], receipt: toHex(receiptA),
      entryVoid: { kind: 'closed', evidence: null } });
    await wait(1000);
    const atB = await entryVoidAt(B, Y.eid);
    say({ step: '(2) A holds Y\'s real first mark, keeps it from B, and hands B "closed" with it', bAnswer,
      atB: { outcome: atB.outcome || atB.status, evidenceKind: atB.evidenceKind }, bHoldsTheMark: round.b.round.holdsMark(checkpointId(m1)),
      bRoundState: round.b.round.get(rid).state === 1 ? 'closed' : 'open' });

    const { f, ms } = await askForfeit(Y.eid);
    say({ step: '(2) the forfeit of Y\'s lock asked', ok: f.ok, msAfterAsked: ms, why: f.ok ? null : f.why.slice(0, 320),
      verifies: f.ok && schnorr.verify(fromHex(f.signature), fromHex(f.contractId), claimKey.claimPk.subarray(1)),
      keptBySignerNodes: [round.a, round.b].map((d) => !!d.round.forfeit(Y.eid)), ...(await lockView(Y.lock)) });
    if (!f.ok) throw new Error('no forfeit in path 2');

    // NOBODY ELSE TAKES IT: the real forfeit in hand, a stranger's key and signer node A's key, at the guardians.
    const stranger = await guardianRedeem(Y.lock, random(32), f.signature);
    const bySignerNodeA = await guardianRedeem(Y.lock, signerNodeA.identity.secret, f.signature);
    say({ step: '(2) the real forfeit with a key that is not Y\'s refund key', stranger, bySignerNodeA, ...(await lockView(Y.lock)) });

    // Y REDEEMS FROM A LATER SESSION WITH ONLY THE SEED, BEFORE THE EXPIRY.
    const r = await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed: Y.seed, curve: pageCurve, LockClient, storage: tab(), nodes: round.nodes });
    const one = r.redeems[0];
    say({ step: '(2) Y redeems from the seed', forfeitVerifies: one.forfeit_verifies, accepted: one.accepted, txid: one.txid,
      error: one.error ? String(one.error).slice(0, 160) : null, federationBlockCount: one.block_count, expiration: one.expiration,
      beforeExpiry: one.block_count < one.expiration, lockBefore: one.stored_before ? 'held' : 'none', lockAfter: one.stored_after ? 'held' : 'none',
      creditedMsat: one.balance_after - one.balance_before, federationFeeMsat: Number(Y.lock.fields.amountMsat) - (one.balance_after - one.balance_before) });
    const withdrawable = BigInt(await r.client.withdrawableMsat());
    const inv = JSON.parse((await lncli('addinvoice', `--amt_msat=${withdrawable}`, '--memo=closed-claim')).out || '{}');
    const wd = JSON.parse(await r.client.withdraw(inv.payment_request));
    const looked = JSON.parse((await lncli('lookupinvoice', inv.r_hash)).out || '{}');
    say({ step: '(2) withdraw', gateway: wd.gateway, state: wd.state, amountOutMsat: wd.invoice_msat, lndState: looked.state, lndReceivedMsat: looked.amt_paid_msat });
    const again = await guardianRedeem(Y.lock, random(32), f.signature);
    say({ step: '(2) after Y\'s redeem: the same forfeit once more', again, ...(await lockView(Y.lock)) });
  }
  // AND X'S LOCK, AT THE END: still held, still waiting on its expiry.
  say({ step: 'end: X\'s lock', ...(await lockView(X.lock)), expiration: X.lock.fields.expiration });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
