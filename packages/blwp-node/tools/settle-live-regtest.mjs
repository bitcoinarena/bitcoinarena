// THE WHOLE SETTLEMENT ON A REAL FEDERATION (W4): two seats of a lock round, each
// with its own port on the stock fedimint 0.12.0 client (blwp-stake-lock) and its
// own joined client; a winner and a loser whose stake locks - and fee locks, only
// where the gate says they pay a seat - are made by the page's wasm lock client;
// both play to FINAL; the seats' one settlement claims the loser's lock (and the fee
// locks), pays the winner and the sitting seats, under one committee signature
// after the window. Run twice: a 100 sat round and a 1000 sat round.
// Driven by settle-live-regtest.sh (the federation, the gateway, the deposit).
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { replay } from '../src/replay.js';
import { assumeSeated } from '../test/seating.js';
import { rand, b32, RANDOMNESS, WINDOW_MS, GENESIS_HASH, wordsAt, contractFor, say as tell, secretScalar, opts, wait } from '../test/window-fixture.js';
import { lockFromClient } from '../../blwp-client/src/lock-result.js';
import { feeLockPays } from '../../protocol/src/lock-settlement.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const curve = { ...feldmanGroup, tweakPoint };
const run = (bin, args, extra = {}) => new Promise((done) => execFile(bin, args, { timeout: 180000, ...extra }, (err, so, se) => done({ err, so: String(so), se: String(se) })));
const lncliPay = async (invoice) => (await run(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', 'payinvoice', '--force', invoice])).so.match(/Payment status: [A-Z_]+/)?.[0] || '?';
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };
const transcriptOf = (n) => ({ ticks: Array.from({ length: n }, (_, t) => ({ tick: t, words: wordsAt(t) })), liquidations: [] });
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const { LockClient } = require(`${env.WASM_PKG}/blwp_lock_client.js`);

// SEAT B'S OWN CLIENT OF THE FEDERATION: two seats settling at once cannot share one database.
const joinedB = await run(`${env.FEDIMINT_BIN}/fedimint-cli`, ['--data-dir', `${P}/client2`, 'join', env.INVITE], { env: { ...env, HOME: env.FEDIMINT_HOME } });
out({ step: 'seat B joins the federation', ok: !joinedB.err, why: joinedB.err ? joinedB.se.trim().split('\n').pop() : 'joined' });
const ports = [stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` }), stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client2` })];

// THE PLAYERS' LOCK CLIENT (the page's wasm), funded once.
const held = new Map();
const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(rand(32)), memStore);
const rcv = JSON.parse(await lc.receive('3000000', env.GATEWAY));
const paid = await lncliPay(rcv.invoice);
out({ step: 'deposit', msat: 3000000, alice: paid, final: await lc.awaitReceive(rcv.operation), balanceMsat: await lc.balanceMsat() });
const rule = JSON.parse(await lc.feeRule());
const fees = { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) };
out({ step: 'the federation\'s fee rule', rule });

/** A world secret under which the seats' own replay says `want` for this entry, and the tick it is reached by. */
function worldFor(base, want) {
  for (let i = 0; i < 600; i++) {
    const worldSecret = new Uint8Array(32); worldSecret[0] = i & 255; worldSecret[1] = i >> 8; worldSecret[31] = want === 'DELIVERED' ? 0xd1 : 0xf1;
    const entry = { ...base, worldSecret };
    const r = replay(transcriptOf(3000), entry, { roundRandomness: RANDOMNESS });
    if (!r.ok || r.outcome !== want || (want === 'DELIVERED' && r.score < 1)) continue;
    for (let n = 60; n <= 3000; n += 60) {
      const s = replay(transcriptOf(n), entry, { roundRandomness: RANDOMNESS });
      if (s.ok && s.outcome === want) return { worldSecret, ticks: n, score: r.score };
    }
  }
  throw new Error(`no world in 600 where the drive is ${want}`);
}

async function round(stakeMsat) {
  const mk = (i) => serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: ports[i], poolCurve: curve, finality: { everyMs: 250 } });
  const a = await mk(0); const b = await mk(1);
  try {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
    const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
      federationId: b32(0xfe), minScore: 1, stakeMsat };
    const rid = roundId(c);
    for (const d of [a, b]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
      assumeSeated(d.round, rid, c.nodes);
    }
    for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
    const claimPk = a.dkg.seatFor(c.nodes).pool.groupPublicKey;
    const gate = feeLockPays({ contract: c, fees });
    out({ round: `${stakeMsat / 1000n} sat`, gate: { mints: gate.pays, lock: gate.lockMsat, why: gate.why.slice(0, 110) } });

    const players = [];
    for (const want of ['DELIVERED', 'FAILED']) {
      const playerPubkey = evenPlayer();
      const session = ed25519.utils.randomSecretKey();
      const preimage = secretScalar();
      const e = rand(32);
      const dealt = await dealHandout({ preimage, seats: c.nodes, roundId: rid, playerPubkey, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
        coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
      const base = { roundId: rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage), stakeMsat,
        feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n, joinTick: 0, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
        claimKeyAttestationRef: b32(0x9a) };
      const world = worldFor({ ...base, feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: b32(1), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n } }, want);
      const refundPk = refundKeyOf(playerPubkey);
      const net = netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
      const stake = lockFromClient(await lc.lock(toHex(base.stakePoint), String(net), toHex(claimPk), toHex(refundPk), 150),
        { point: base.stakePoint, claimPk, refundPk });
      let fee = null; let F = new Uint8Array(32);
      if (gate.pays) {
        F = rand(32);
        fee = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(stakeMsat)), toHex(claimPk), toHex(refundPk), 150),
          { hash: sha256(F), claimPk, refundPk });
      }
      const entry = { ...base, worldSecret: world.worldSecret, feePreimage: F, stakeLockOutpoint: stake.outpoint,
        feeLockOutpoint: fee ? fee.outpoint : { txid: new Uint8Array(32), outIdx: 0n } };
      const eid = entryId(entry);
      const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: world.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
      const st = init(seedWordForEntry(entry, RANDOMNESS));
      for (let t = 0; t < world.ticks; t++) step(st, ...wordsAt(t));
      const mark = { roundId: rid, entryId: eid, tick: world.ticks, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
        inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
      const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
      const handed = [];
      for (const d of [a, b]) {
        const base2 = `http://127.0.0.1:${d.port}`;
        await fetch(`${base2}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
        const en = await fetch(`${base2}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
        if (en.status !== 201) throw new Error(`entry: ${en.status} ${await en.text()}`);
        const lk = await fetch(`${base2}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(stake.fields)) });
        const fl = fee ? await fetch(`${base2}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fee.fields)) }) : null;
        handed.push(`lock ${lk.status}${fl ? `, fee-lock ${fl.status}` : ''}`);
        if (lk.status !== 201) throw new Error(`seat ${d.port} answered the stake lock ${lk.status}: ${await lk.text()}`);
        if (fl && fl.status !== 201) throw new Error(`seat ${d.port} answered the fee lock ${fl.status}: ${await fl.text()}`);
        const took = await tell(d.port, encodeInputBatch(input));
        if (took !== String(world.ticks)) throw new Error(`the batch was not taken by seat ${d.port}: ${took}`);
        const receipt = await tell(d.port, signedMark);
        if (receipt.length !== SIGNED_RECEIPT_BYTES) throw new Error(`the mark at tick ${world.ticks} was not receipted by seat ${d.port}: ${typeof receipt === 'string' ? receipt : `${receipt.length} bytes`}`);
      }
      out({ player: want, stakeLock: `${key(stake.outpoint)} ${stake.fields.amountMsat} msat`, feeLock: fee ? `${key(fee.outpoint)} ${fee.fields.amountMsat} msat` : 'none (the gate)',
        world: `ticks ${world.ticks}`, seats: handed });
      players.push({ want, playerPubkey, stake, fee, eid });
    }

    const closedAt = Date.now();
    await Promise.all([tell(a.port, `close ${toHex(rid)}`), tell(b.port, `close ${toHex(rid)}`)]);
    let got = null;
    for (const stop = Date.now() + 240000; Date.now() < stop; await wait(1000)) {
      got = await (await fetch(`http://127.0.0.1:${a.port}/lock-settlement?round=${toHex(rid)}`)).json();
      if (got.state === 'ACCEPTED' || got.state === 'REFUSED') break;
    }
    const atB = await (await fetch(`http://127.0.0.1:${b.port}/lock-settlement?round=${toHex(rid)}`)).json();
    const [winner, loser] = players;
    const held = async (o) => !!(await ports[0].status(o)).stored;
    const payoutsStored = [];
    if (got && got.moved) for (let i = 0; i < got.moved.payouts.length; i++) payoutsStored.push(await held({ txid: fromHex(got.moved.txid), outIdx: BigInt(i) }));
    const verifies = !!(got && got.signature) && schnorr.verify(fromHex(got.signature), fromHex(got.message), claimPk.subarray(1));
    out({
      round: `${stakeMsat / 1000n} sat`, settlement: got && got.state, why: got && got.why, seatBHolds: atB.state, txid: got && got.txid,
      oneSignatureVerifiesUnderClaimKey: verifies, madeAfterCloseMs: got && got.madeMs ? got.madeMs - closedAt : null, windowMs: WINDOW_MS,
      moved: got && got.moved,
      federation: {
        loserStakeLockHeld: await held(loser.stake.outpoint), winnerStakeLockHeld: await held(winner.stake.outpoint),
        feeLocksHeld: await Promise.all(players.filter((p) => p.fee).map((p) => held(p.fee.outpoint))), payoutsStored,
      },
      winnerKey: toHex(refundKeyOf(winner.playerPubkey)).slice(0, 12), seatKeys: c.nodes.map((k) => toHex(refundKeyOf(k)).slice(0, 12)),
    });

  } finally { await a.close(); await b.close(); }
}

try {
  await round(100000n);
  await round(1000000n);
} catch (e) { out({ error: e.stack.split('\n').slice(0, 3).join(' | ') }); process.exitCode = 1; }
// THE WASM CLIENT'S GUARDIAN WEBSOCKETS KEEP NODE UP after the last step (W1a, measured).
process.exit(process.exitCode || 0);
