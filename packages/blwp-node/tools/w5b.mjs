// W5b ON A REAL FEDERATION: THE SIGNER NODES' FORFEIT AND THE PLAYER'S REDEEM
// (v4.6.2 §23.2 row 1). Run by w5b-regtest.sh after the federation is up.
//
// The Daily's own 2-of-2 round naming the federation, the signer nodes making the
// round's claim key themselves (nothing injected), a 20 s objection window set
// through the round's own objectionWindowMs. Two players lock their stakes the
// way the page does and are committed by both signer nodes; one drives a run the
// core delivers, one a run it fails; the round is closed. Then:
//   the winner's forfeit, once final           - both signer nodes sign; it verifies
//   the loser's                                - 409, and its lock stays held
//   a redeem with ONE signer node's signature         - refused by the guardians
//   the redeem, from a later session with only the seed - accepted, lock gone
//   the withdraw over the listed gateway to the player's lnd
//
// HARNESS WORK, SAID SO: each entry's world secret is SEARCHED with the core's
// own replay against the round's actual randomness until the fixed drive
// delivers (the winner) or fails (the loser). A player does not search; this
// only picks two runs whose outcomes are known before the signer nodes replay them.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import WebSocket from 'ws';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { runId as runIdOf } from '../src/verdict.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, fetchRandomness } from '../../blwp-client/src/join.js';
import { lockStake, fundPlayerWallet, handLock, redeemStake, findLock, forfeitOf } from '../../blwp-client/src/page-lock.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { init, step, runScore } from '../../core/src/sim.js';
import { hash as stateHash, O_SCORE, S_STATE } from '../../core/src/state.js';
import { RUN_LIVE, RUN_DELIVERED } from '../../core/src/rules/gate.js';

// THE STAKE FROM THE PLAYER WALLET (§24A.1, RULED 2026-09-25): the top-up into the player wallet is its own act,
// then the stake is spent from it - the same arguments, the same tab, the same onDeposit.
const fundedLockStake = async (a) => { await fundPlayerWallet(a); return lockStake(a); };

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../blwp-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'w5b-glue-'));
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
// The fixture's drive: throttle held, a weave, a short brake pulse.
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
/** HARNESS: replay the fixed drive in the world a secret makes, until the run ends. */
function runOf(entry, randomness, cap = 3000) {
  const st = init(seedWordForEntry(entry, randomness));
  for (let t = 0; t < cap; t++) {
    step(st, ...wordsAt(t));
    const s = st.i32[O_SCORE + S_STATE];
    if (s !== RUN_LIVE) return { ended: s, ticks: t + 1, st };
  }
  return { ended: RUN_LIVE, ticks: cap, st };
}

// ON THE CHAIN, AND WITH THREE OPERATORS (NODES=3 with RPCPORT): §23.6's gate only
// runs when the round is stood up against a real chain, and it wants the
// federation's threshold in DISTINCT bonded census nodes - three, for the 3-of-4
// fedimintd will build. Without these the run is the 2-of-2 fixture round as before.
const howMany = Number(env.NODES || 2);
const onChain = !!env.RPCPORT;
let chain = {};
let guardianOf = [];
if (onChain) {
  const RT = join(P, 'btc');
  const BIN = env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
  const base = ['-regtest', `-datadir=${RT}`, `-rpcport=${env.RPCPORT}`, '-rpcuser=blwp', '-rpcpassword=blwp'];
  const cliRaw = (...a) => execFileSync(BIN, [...base, ...a], { encoding: 'utf8' }).trim();
  const cli = (...a) => execFileSync(BIN, [...base, '-rpcwallet=blwp', ...a], { encoding: 'utf8' }).trim();
  try { cliRaw('createwallet', 'blwp'); } catch { try { cliRaw('loadwallet', 'blwp'); } catch { /* loaded */ } }
  cli('generatetoaddress', '101', cli('getnewaddress'));
  chain = { cli, rpc: bitcoindRpc({ url: `http://127.0.0.1:${env.RPCPORT}/wallet/blwp`, readCookie: () => 'blwp:blwp' }) };
  const fed = await port.guardians();
  // THREE OPERATORS ADVERTISE A GUARDIAN, WHATEVER THE COMMITTEE'S SIZE. §23.6
  // counts distinct bonded census nodes against the FEDERATION's threshold (3 of
  // 4 here), which is a different number from the committee's (5 of 7). The rest
  // of the seven are bonded census nodes that guard nothing, which is what most
  // operators are.
  const guards = Math.min(fed.threshold, howMany);
  guardianOf = [...new Array(howMany).keys()].map((i) =>
    (i < guards ? [{ federationId, guardianKey: fed.keys[i] }] : []));
  say({ step: 'federation', id: toHex(fed.federationId).slice(0, 16), guardians: fed.guardians,
    federationThreshold: fed.threshold, signerNodes: howMany,
    guardianPerNode: guardianOf.map((g, i) => `${String.fromCharCode(65 + i)} -> ${g.length ? toHex(g[0].guardianKey).slice(0, 16) : 'guards nothing'}`) });
}
// AND NO LIGHTNING PORT AT ALL, which is the shipping default (NO_LIGHTNING =
// null) and is the proof that no hold invoice is on this path. `createHeld` sits
// behind custody's `reaches`, so a daemon with no port cannot call it: "this node
// reaches no Lightning, so it holds no stakes". A round that opens, locks its
// stake in the federation and settles with every daemon in that state has shown
// the hold-invoice stack unused, not been asserted to.
//
// Measured the other way first and worth keeping: installing a REFUSING port
// instead made it worse - a port that exists means the node holds stakes, and it
// then demanded the preflight it could not have ("this node holds stakes and has
// no preflight"). The absence is the measurement; a stub is a second Lightning.
const round = await standUpRound({ host: '127.0.0.1', portA: 18571, portB: 18572,
  // 18571..18577. The live Daily holds 18080, 18081 and 18777 and is not touched.
  ...(howMany > 2 ? { portC: 18573, extraPorts: [...new Array(howMany - 3).keys()].map((i) => 18574 + i) } : {}),
  stakeMsat: 1000000n, ...chain,
  ...(guardianOf.length ? { guardianOf } : {}),
  // THE LIVE DAILY OWNS 18777 on this machine; this harness binds its own.
  ...(onChain ? { donationRecipients: { port: 18787 } } : {}),
  federationId, invite: env.INVITE, signerNode: { stakeLocks: port }, objectionWindowMs: 20000n });
const rid = fromHex(round.id);
// EVERY DAEMON THIS ROUND HAS, and how many must agree - the committee's size, not a 2.
const daemons = round.daemons;
// WHAT THE COMMITTEE OWES, from the protocol's own rule - 2 of 2, 5 of 7 - not
// the number of daemons. A handout needs the threshold, not everybody.
const needed = receiptsNeeded(daemons.length);
say({ step: 'committee', signerNodes: daemons.length, receiptsNeeded: needed });
say({ step: 'no hold invoices', reachesLightning: daemons.map((d) => d.reachesLightning),
  note: 'createHeld sits behind custody.reaches; with no port it cannot be called' });
const contract = round.contract;
const withId = { ...contract, id: rid };
let code = 0;
try {
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed,
    key: claimKey.ok ? toHex(claimKey.claimPk).slice(0, 16) : claimKey.why, objectionWindowMs: contract.objectionWindowMs, minScore: contract.minScore });
  if (!claimKey.ok) throw new Error(claimKey.why);
  const { randomness } = await fetchRandomness(round.id, round.nodes);

  const players = {};
  for (const role of ['winner', 'loser']) {
    const seed = random(32);
    const player = playerFor(withId, { seed, curve: pageCurve });
    const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed });
    const put = await postHandout(stake, round.nodes, { needed });
    let paying = Promise.resolve(null);
    const lock = await fundedLockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
      playerPubkey: player.pubkey, LockClient, storage: tab(), onDeposit: (d) => { paying = pay(d.invoice); } });
    await paying;
    const session = ed25519.utils.randomSecretKey();
    const base = { roundId: rid, sessionPubkey: ed25519.getPublicKey(session),
      ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
    // HARNESS: the world secret searched for this role's outcome.
    let entry;
    let run;
    let tries = 0;
    for (;;) {
      tries++;
      entry = { ...base, worldSecret: random(32) };
      run = runOf(entry, randomness);
      run.score = runScore(run.st);
      if (role === 'winner' ? run.ended === RUN_DELIVERED && run.score >= contract.minScore
        : run.ended !== RUN_LIVE && run.ended !== RUN_DELIVERED) break;
      if (tries > 20000) throw new Error(`no world secret gave the ${role} its outcome in 20000 tries`);
    }
    const eid = entryId(entry);
    const joined = [];
    for (const b of round.nodes) joined.push((await fetch(`${b}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
    const handed = await handLock({ entryId: eid, fields: lock.fields, nodes: round.nodes, needed });
    // AND THE FEE LOCK, WHICH THE STAKE IS NOT COUNTED WITHOUT (§23.1 step 5, pick a).
    // Measured without it: every node verified the stake lock and answered "counted once
    // its fee lock is verified (this round mints fee locks)", so `stakeSeen` was never
    // recorded, `custody.seenPaid` refused, and the play socket answered "stake not seen"
    // to EVERY input batch - no transcript, no signed result, 0 of 5 agreeing, and both
    // entries VOID. The stake was locked the whole time; the round just never saw it.
    const handedFee = lock.feeLock
      ? await handLock({ entryId: eid, fields: lock.feeLock.fields, nodes: round.nodes, needed, door: 'fee-lock' })
      : null;
    // THE FIRST MARK WHERE THE PAGE PUTS IT (§16): at tick 60, inside the start
    // deadline the round omits (900) - then the rest of the run and its end mark,
    // chained. A single first mark at the run's end (this harness's 1197 before)
    // is after the line: ENTRY_VOID, and the run would never settle.
    const FIRST = 60;
    const hex32 = (st) => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
    const early = init(seedWordForEntry(entry, randomness));
    for (let t = 0; t < FIRST; t++) step(early, ...wordsAt(t));
    const first = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: FIRST }, (_, t) => wordsAt(t)), liquidations: [] };
    const firstMark = { roundId: rid, entryId: eid, tick: FIRST, stateHash: hex32(early),
      inputChainHash: batchId(first), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
    const input = { roundId: rid, entryId: eid, previousHash: batchId(first), firstTick: FIRST,
      ticks: Array.from({ length: run.ticks - FIRST }, (_, t) => wordsAt(FIRST + t)), liquidations: [] };
    const mark = { roundId: rid, entryId: eid, tick: run.ticks, stateHash: hex32(run.st),
      inputChainHash: batchId(input), previousHash: checkpointId(firstMark), sessionPubkey: ed25519.getPublicKey(session) };
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    const played = [];
    for (const b of round.nodes) {
      played.push([await ws(b, encodeInputBatch(first)), (await ws(b, sign(firstMark))).length,
        await ws(b, encodeInputBatch(input)), (await ws(b, sign(mark))).length]);
    }
    players[role] = { seed, player, lock, eid, entry };
    say({ step: 'locked and played', role, outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`,
      amountMsat: lock.fields.amountMsat, expiration: lock.fields.expiration, handouts: put.accepted, entries: joined,
      locks: handed.said.map((s) => `${s.status}${s.why ? ' ' + String(s.why).slice(0, 120) : ''}`), committed: handed.committed,
      feeLocks: handedFee ? handedFee.said.map((s) => `${s.status}${s.why ? ' ' + String(s.why).slice(0, 90) : ''}`) : 'the round minted none',
      feeCommitted: handedFee ? handedFee.committed : 0,
      harnessSearch: { tries, coreEnded: run.ended === RUN_DELIVERED ? 'DELIVERED' : 'FAILED', ticks: run.ticks }, played });
  }

  // THE CLOSE, and the window.
  const closedAt = Date.now();
  say({ step: 'close', said: await Promise.all(round.nodes.map((b) => ws(b, `close ${round.id}`))) });
  const w = players.winner;

  // WHAT EACH OF THE SEVEN ACTUALLY HOLDS, before anything is tallied. The tally
  // said "0 of 5 agree on any one run", which is not a split vote - it is no
  // signed result at all - so the question is whether a result object exists on
  // any node, and if not, what each one says instead.
  // GROUPED BY runId, NOT resultId. `resultId` hashes the signing node in too, so
  // seven nodes agreeing on one run still carry seven different resultIds - counting
  // those says "all disagree" when they agree. `runId` is the same hash with the
  // node zeroed, which is what the tally itself compares.
  const look = (who, eid) => {
    const per = daemons.map((d, i) => {
      const rs = d.round.results(rid, eid);
      const t = d.round.transcript(rid, eid);
      const byRun = new Map();
      for (const r of rs) {
        try {
          const run = toHex(runIdOf(decodePlayerResult(splitSignedResult(r.bytes).body))).slice(0, 8);
          byRun.set(run, (byRun.get(run) || 0) + 1);
        } catch { byRun.set('undecodable', (byRun.get('undecodable') || 0) + 1); }
      }
      return { n: String.fromCharCode(65 + i), results: rs.length,
        signed: [...byRun.entries()].map(([run, n]) => `${run} x${n}`),
        void: !!d.round.entryVoid(eid), ticks: t && t.ticks ? t.ticks.length : 0 };
    });
    // AND THE BEST-SUPPORTED RUN AS THE TALLY WOULD SEE IT, off the node that holds most.
    const widest = per.reduce((best, p) => (p.results > best.results ? p : best), per[0]);
    return { per, widest: widest.signed, needed };
  };
  say({ step: 'what the seven hold after close', winner: look('winner', w.eid), loser: look('loser', players.loser.eid) });

  let forfeit = await forfeitOf({ roundId: rid, entryId: toHex(w.eid), nodes: round.nodes });
  const early = forfeit.ok ? 'granted' : forfeit.why.slice(0, 200);
  for (const stop = Date.now() + 180000; !forfeit.ok && Date.now() < stop; await wait(1000))
    forfeit = await forfeitOf({ roundId: rid, entryId: toHex(w.eid), nodes: round.nodes });
  const kept = daemons.map((d) => { const f = d.round.forfeit(w.eid); return f ? toHex(f.signature) === forfeit.signature : false; });
  say({ step: 'what the seven hold after the window', winner: look('winner', w.eid) });
  say({ step: 'winner forfeit', firstAsk: early, ok: forfeit.ok, msAfterClose: Date.now() - closedAt,
    contractId: forfeit.contractId, claimPkIsTheRounds: forfeit.claimPk === toHex(claimKey.claimPk),
    verifies: forfeit.ok && schnorr.verify(fromHex(forfeit.signature), fromHex(forfeit.contractId), claimKey.claimPk.subarray(1)),
    keptBySignerNodes: kept, why: forfeit.ok ? null : forfeit.why });

  // THE LOSER'S: refused, and its lock still held.
  const l = players.loser;
  const lost = await forfeitOf({ roundId: rid, entryId: toHex(l.eid), nodes: round.nodes });
  const lstat = await port.status(l.lock.outpoint);
  say({ step: 'loser forfeit', ok: lost.ok, refused: lost.refused, keptBySignerNodes: daemons.map((d) => !!d.round.forfeit(l.eid)),
    lockHeld: !!(lstat && lstat.stored) });

  // ONE SIGNER NODE'S SIGNATURE (harness: signer node A's share read from its own store): the guardians must refuse it.
  const heldA = round.a.dkg.signerNodeFor(contract.nodes);
  if (!forfeit.ok) throw new Error(`the winner's lock was never forfeited, so nothing can settle: ${String(forfeit.why).slice(0, 300)}`);
  const message = fromHex(forfeit.contractId);
  const hiding = nonceGenerate340(random(32), heldA.signerNode.share);
  const binding = nonceGenerate340(random(32), heldA.signerNode.share);
  const commitments = [{ id: heldA.signerNode.id, hiding: curve.pointFromScalar(hiding), binding: curve.pointFromScalar(binding) }];
  const share = signShare340({ id: heldA.signerNode.id, share: heldA.signerNode.share, groupPublicKey: claimKey.claimPk, nonces: { hiding, binding }, message, commitments, curve });
  const alone = aggregate340({ commitments, message, groupPublicKey: claimKey.claimPk, shares: [share], curve }).signature;
  const [wl] = await findLock({ roundId: rid, playerPubkey: w.player.pubkey, nodes: round.nodes });
  const probe = await LockClient.join(env.INVITE, toHex(contract.federationId), toHex(new Uint8Array(randomBytes(32))), { entries: () => '[]', put() {}, remove() {} });
  const lone = JSON.parse(await probe.redeem(toHex(wl.outpoint.txid), Number(wl.outpoint.outIdx), JSON.stringify(lockFieldsToJson(wl.fields)),
    toHex(alone), toHex(w.player.secret)));
  say({ step: 'redeem with one signer node\'s signature', forfeitVerifies: lone.forfeit_verifies, accepted: lone.accepted,
    error: lone.error ? String(lone.error).slice(0, 160) : null, lockAfter: lone.stored_after ? 'held' : 'none' });

  // THE REDEEM, FROM A LATER SESSION WITH ONLY THE SEED; then the withdraw.
  const r = await redeemStake({ round: contract, roundId: rid, invite: env.INVITE, seed: w.seed, curve: pageCurve,
    LockClient, storage: tab(), nodes: round.nodes });
  const one = r.redeems[0];
  say({ step: 'redeem from the seed', forfeitVerifies: one.forfeit_verifies, accepted: one.accepted, txid: one.txid,
    error: one.error ? String(one.error).slice(0, 160) : null, federationBlockCount: one.block_count, expiration: one.expiration,
    lockBefore: one.stored_before ? 'held' : 'none', lockAfter: one.stored_after ? 'held' : 'none',
    creditedMsat: one.balance_after - one.balance_before, federationFeeMsat: Number(w.lock.fields.amountMsat) - (one.balance_after - one.balance_before) });
  // AND WHAT EACH LOCK HELD, BEFORE AND AFTER. The winner's is redeemed above; the
  // loser's is refused and stays held to its expiry, which is §23.2's own answer.
  say({ step: 'the locks, before and after',
    winner: { outpoint: `${toHex(w.lock.outpoint.txid).slice(0, 12)}:${w.lock.outpoint.outIdx}`,
      lockedMsat: String(w.lock.fields.amountMsat), before: one.stored_before ? 'held' : 'none',
      after: one.stored_after ? 'held' : 'none', creditedMsat: one.balance_after - one.balance_before },
    loser: { outpoint: `${toHex(l.lock.outpoint.txid).slice(0, 12)}:${l.lock.outpoint.outIdx}`,
      lockedMsat: String(l.lock.fields.amountMsat), after: (await port.status(l.lock.outpoint))?.stored ? 'held' : 'none' } });
  const withdrawable = BigInt(await r.client.withdrawableMsat());
  const inv = JSON.parse((await lncli('addinvoice', `--amt_msat=${withdrawable}`, '--memo=w5b')).out || '{}');
  const wd = JSON.parse(await r.client.withdraw(inv.payment_request));
  const looked = JSON.parse((await lncli('lookupinvoice', inv.r_hash)).out || '{}');
  say({ step: 'withdraw', gateway: wd.gateway, state: wd.state, amountOutMsat: wd.invoice_msat, remainingBalanceMsat: wd.balance_after,
    sendFeesMsat: wd.balance_before - wd.balance_after - Number(withdrawable), lndState: looked.state, lndReceivedMsat: looked.amt_paid_msat });
  const lafter = await port.status(l.lock.outpoint);
  say({ step: 'the loser\'s lock at the end', held: !!(lafter && lafter.stored) });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
