// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE 10% ON A REAL FEDERATION (2026-10-07): one paid round of each game on a regtest federation of the
// patched fork, settled by its two signer nodes, and the game dev's own key collecting its 2.5% through the donor client.
//   - nextblock: its game set is the network's protocol devs (one output per key, both halves merged);
//   - tally-205: a game whose dev holds a key of its own, made here by `arena-donor init` - its set is that one key.
// Each player stakes STAKE: the 5% fee in its fee lock, the 5% donation in payout contracts to the two sets in the same
// transaction as the stake (the page's `lockWithDonations`), the rest the net stake. The signer nodes' settlement pays the
// seats from the fee locks; the donation outputs are held by the federation for their keys. Then `arena-donor once` asks the
// signer nodes' /donations?key= for the tally dev's key, records, redeems into its wallet, and withdraws to alice's lnd.
// The round is the test fixture's (lock-round-fixture: the bonded chain view, the round's open, close and settlement); its
// stake-lock port is the real one (blwp-stake-lock over a joined client), one call at a time.
// Driven by fee-split-regtest.sh (the federation, two gateways, the deposit's lnd).
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockRound, openLockRound, closeRound, standing, nameAddress } from '../test/lock-round-fixture.js';
import { drivenTape, b32, rand, GENESIS_HASH, playFor, warmPlay, say, secretScalar, wait, WINNER, LOSER, RANDOMNESS, loaded, bedFrom } from '../test/window-fixture.js';
import { testGame, attestorSign } from '../test/plugins/sign.js';
// A MARKET (slice 2): the regtest market the client pins - three outcomes, three test attestors, two to sign
import { MARKET } from '../test/plugins/market/index.js';
// THE TEST UP/DOWN MARKET (node 0.5% + donation 0.5%, two outcomes, a 15-minute grid): FRONTEND_BOOK's order book (comment 2295)
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } from '../test/plugins/updown/index.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { YES as BOOK_YES, NO as BOOK_NO } from '../../arena-protocol/src/order-book.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { playerFor } from '../../arena-client/src/join.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { redeemPayout, returnStake } from '../../arena-client/src/page-lock.js';
import { TALLY, TALLY_CORE, TALLY_CORE_HASH, TALLY_CONFIG_HASH } from '../test/plugins/tally/index.js';
import { TALLY_RUN_TICKS } from '../test/plugins/tally/core.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId, splitDonation } from '../../arena-protocol/src/donation.js';
import { nodeFeeTable, entryFeeMsat, GAME_VERIFY, SETTLEMENT, GUARDIAN } from '../../arena-protocol/src/fee.js';
import { netStakeMsat, DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { FRONTEND_FEE_VERSION } from '../../arena-protocol/src/constants.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from '../src/curve.js';
import { testNow, skipTo } from '../test/test-clock.js';

const env = process.env;
const P = env.PROBE;
const HERE = dirname(fileURLToPath(import.meta.url));
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args, extra = {}) => new Promise((done) => execFile(bin, args, { timeout: 300000, ...extra }, (err, so, se) => done({ err, so: String(so), se: String(se) })));
const lncli = (who, rpc, ...a) => run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/${who}`, `--rpcserver=127.0.0.1:${rpc}`, '--network=regtest', ...a]);
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
const STAKE = BigInt(env.STAKE_MSAT || 2_000_000);
const DONATION = STAKE * 500n / 10000n;                            // the default 5%
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;         // the protocol devs (dev a 6667, dev b 3333)
const WASM = env.WASM_WEB;                                         // the page's own (web target) lock client

// THE PAGE'S LOCK CLIENT, loaded in Node as the donor client loads it
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const esm = join(tmpdir(), `fee-split-lock-client-${process.pid}.mjs`);
copyFileSync(join(WASM, 'blwp_lock_client.js'), esm);
const wasm = await import(esm);
await wasm.default({ module_or_path: readFileSync(join(WASM, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = wasm;
const fid = LockClient.federationIdOf(env.INVITE);

// THE REAL PORT, ONE CALL AT A TIME: both signer nodes share one joined client directory, whose database admits one process
const real = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
let chain = Promise.resolve();
const port = { preimages: new Map() };
for (const [k, f] of Object.entries(real)) {
  if (typeof f !== 'function') { port[k] = f; continue; }
  port[k] = (...a) => { const p = chain.then(() => f.apply(real, a)); chain = p.catch(() => {}); return p; };
}

// THE GAME DEV WITH A KEY OF ITS OWN: the donor client's own init makes it
const DONOR = join(P, 'donor-tally');
const donorBin = join(HERE, '../../arena-donor/bin/arena-donor.mjs');
const made = await run(process.execPath, [donorBin, 'init', DONOR, '--label', 'tally-205 dev', '--wasm', WASM]);
const donorKey = JSON.parse(readFileSync(join(DONOR, 'key.json'), 'utf8'));
out({ step: 'the tally dev\'s key, made by arena-donor init', ok: !made.err, recipientPk: donorKey.recipientPkHex });
const TALLY_DEV_SET = [{ recipientPk: fromHex(donorKey.recipientPkHex), label: 'tally-205 dev', shareBps: 10000 }];
const TALLY205 = testGame({ name: 'tally', dev: 'tally-205 regtest', cores: TALLY.cores, runTicksMax: TALLY_RUN_TICKS, donationSet: TALLY_DEV_SET });

// THE PLAYERS' WALLET (the page's), funded once through gateway A
const held = new Map();
const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
const lc = await LockClient.join(env.INVITE, fid, toHex(rand(32)), memStore);
// 4 game entries and 8 market picks; FRONTEND_BOOK: four 10,000 sat orders (two book rounds of two) and room for the guardians' fees
const DEPOSIT = env.FRONTEND_BOOK ? 45_000_000n : 12n * (STAKE + 200_000n);
const rcv = JSON.parse(await lc.receive(String(DEPOSIT), env.GATEWAY));
const paid = (await lncli('alice', 30107, 'payinvoice', '--force', rcv.invoice)).so.match(/Payment status: [A-Z_]+/)?.[0] || '?';
out({ step: 'deposit', msat: DEPOSIT, alice: paid, final: await lc.awaitReceive(rcv.operation), balanceMsat: await lc.balanceMsat() });
const rule = JSON.parse(await lc.feeRule());
const fees = { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) };
out({ step: 'the federation\'s fee rule', rule });

// THE GUARDIANS' BLOCK COUNT REACHES THE CHAIN BEFORE ANY LOCK (settle-live-regtest's measured lag)
const nowhere = { txid: new Uint8Array(32), outIdx: 0n };
const chainHeight = async () => Number((await run(`${env.BITCOIN_BIN}/bitcoin-cli`, [`-datadir=${P}/btc`, '-regtest', '-rpcport=30101', '-rpcuser=blwp', '-rpcpassword=blwp', 'getblockcount'])).so.trim());
for (const t = Date.now(); Date.now() - t < 300000; await wait(5000)) {
  const [count, tip] = [(await port.status(nowhere)).blockCount, await chainHeight()];
  if (count >= tip) { out({ step: 'the guardians\' block count reaches the chain', count, tip, afterMs: Date.now() - t }); break; }
}

/**
 * ONE PLAYER, AS THE PAGE LOCKS: the stake, the fee lock and the donation's payout contracts in ONE transaction
 * (`lockWithDonations`, the donation image the player's own key), then the run played and marked at both signer nodes.
 */
async function lockAndPlayReal(w, who, { game = null, target, pick = undefined, frontendPk = null, order = null, feeBps = undefined, donationMsat = DONATION }) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  if (!dealt.ok) throw new Error(dealt.why);
  await warmPlay(who, w.randomness);
  const play = playFor(who, w.randomness);
  // a market's fee lock is its own rate, its donation inside it (FRONTEND_BOOK: 1%, no separate donation outputs)
  const feeMsat = entryFeeMsat(w.c.stakeMsat, feeBps);
  const gate = feeLockPays({ contract: w.c, fees });
  if (!gate.pays) throw new Error(`the gate mints no fee lock at this stake: ${gate.why}`);
  const shares = donationMsat > 0n ? splitDonation({ donationMsat, recipients: target }).shares.filter((s) => s.amountMsat > 0n) : [];
  const feeSecret = rand(32);
  const refundPk = refundKeyOf(who.key);
  const net = netStakeMsat({ stakeMsat: w.c.stakeMsat, feeMsat, donationMsat });
  const stakePoint = dealt.handout.commitments[0];
  const all = JSON.parse(await lc.lockWithDonations(toHex(stakePoint), String(net), toHex(sha256(feeSecret)), String(feeMsat),
    // the round's own lock span when it is longer (a market's: lock-expiry.js), else 150 as before
    toHex(w.claimPk), toHex(refundPk), w.c.stakeExpiryBlocks > 144 ? w.c.stakeExpiryBlocks : 150, JSON.stringify(shares.map((s) => ({ pk: toHex(s.recipientPk), msat: String(s.amountMsat), image: toHex(who.key) })))));
  const stake = lockFromClient(all.stake, { point: stakePoint, claimPk: w.claimPk, refundPk });
  const fee = lockFromClient(all.fee, { hash: sha256(feeSecret), claimPk: w.claimPk, refundPk });
  const donated = all.donations.map((d, i) => {
    if (d.ids_match !== true) throw new Error(`donation output ${i}: the guardians hold another contract than the one built`);
    return { outpoint: { txid: fromHex(d.txid), outIdx: BigInt(d.out_idx) }, recipientPk: shares[i].recipientPk, amountMsat: BigInt(d.amount_msat) };
  });
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat,
    feeMsat, donationMsat, joinTick: 0, worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint,
    feePreimage: feeSecret, stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee.outpoint, claimKeyAttestationRef: b32(0x9a),
    donationOutpoints: donated.map((d) => d.outpoint),
    // AN ATTESTED ROUND'S ENTRY BACKS AN OUTCOME (slice 2) and plays no run
    ...(pick !== undefined ? { pick } : {}),
    // THE WEBSITE THAT BROUGHT THIS ENTRY: its payout key, in the entry's signed bytes
    ...(frontendPk ? { frontendPk } : {}),
    // A MARKET ORDER: its limit price, standing until it fills or the market closes
    ...(order ? { limitPrice: Number(order.price), orderExpiryMs: 0n } : {}),
  };
  const eid = entryId(entry);
  const hashOf = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  let msgs;
  if (pick !== undefined) msgs = [];
  else if (game) {
    const gs = game.adapter.start(seedWordForEntry(entry, w.randomness), game.config, { runTicks: w.c.blockTicks });
    const first = 60;
    for (let t = 0; t < first; t++) game.adapter.step(gs, play.words(t));
    const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: first }, (_, t) => play.words(t)), liquidations: [], loads: [] };
    const m1 = { roundId: w.rid, entryId: eid, tick: first, stateHash: hashOf(game.adapter.stateHash(gs)), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
    for (let t = first; t < who.ticks; t++) game.adapter.step(gs, play.words(t));
    const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: first, ticks: Array.from({ length: who.ticks - first }, (_, t) => play.words(first + t)), liquidations: [], loads: [] };
    const m2 = { roundId: w.rid, entryId: eid, tick: who.ticks, stateHash: hashOf(game.adapter.stateHash(gs)), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: ed25519.getPublicKey(session) };
    msgs = [[encodeInputBatch(b1), 'batch'], [sign(m1), 'mark'], [encodeInputBatch(b2), 'batch'], [sign(m2), 'mark']];
  } else {
    const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < who.ticks; t++) step(st, ...play.words(t));
    const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: who.ticks }, (_, t) => play.words(t)), liquidations: [], loads: bedFrom(0) };
    const mark = { roundId: w.rid, entryId: eid, tick: who.ticks, stateHash: hashOf(stateHash(st)), inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
    msgs = [[encodeInputBatch(input), 'batch'], [sign(mark), 'mark']];
  }
  const answers = [];
  for (const d of w.nodes) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    if (en.status !== 201) throw new Error(`entry at ${d.port}: ${en.status} ${await en.text()}`);
    const lk = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(stake.fields)) });
    if (lk.status !== 201) throw new Error(`stake lock at ${d.port}: ${lk.status} ${await lk.text()}`);
    const fl = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fee.fields)) });
    if (fl.status !== 201) throw new Error(`fee lock at ${d.port}: ${fl.status} ${await fl.text()}`);
    for (const [m, kind] of msgs) {
      const got = await say(d.port, m);
      if (kind === 'mark' && got.length !== SIGNED_RECEIPT_BYTES) throw new Error(`mark refused at ${d.port}: ${String(got).slice(0, 160)}`);
    }
    answers.push(`${d.port}: entry 201, lock 201, fee-lock 201, seen ${!!d.round.stakeSeen(eid)}`);
  }
  out({ player: who.name, stake: `${toHex(stake.outpoint.txid).slice(0, 12)}:${stake.outpoint.outIdx} ${stake.fields.amountMsat}`,
    fee: `${toHex(fee.outpoint.txid).slice(0, 12)}:${fee.outpoint.outIdx} ${fee.fields.amountMsat}`, sameTx: toHex(stake.outpoint.txid) === toHex(fee.outpoint.txid) && donated.every((d) => toHex(d.outpoint.txid) === toHex(stake.outpoint.txid)),
    donations: donated.map((d) => [toHex(d.recipientPk).slice(0, 8), String(d.amountMsat), `:${d.outpoint.outIdx}`]), signerNodes: answers });
  const played = { eid, entry, outpoint: stake.outpoint, feeOutpoint: fee.outpoint, session, donated };
  if (who.address) await nameAddress(w.nodes, played);
  return played;
}

/** The settlement: its payouts to anybody but the players are the node fee; and §22A's table for the seats. */
async function settled(w, players) {
  let got = null;
  for (const stop = Date.now() + 300000; Date.now() < stop; await wait(1000)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED' || got.state === 'REFUSED') break;
  }
  const playerKeys = new Set(players.map((p) => toHex(refundKeyOf(p.entry.playerPubkey))));
  const payouts = (got && got.moved && got.moved.payouts) || [];
  const keyOf = (p) => String(p.payoutPk || p.key || p.pk || '').toLowerCase();
  const nodes = payouts.filter((p) => !playerKeys.has(keyOf(p))).map((p) => ({ kind: p.kind, key: keyOf(p), msat: BigInt(p.msat ?? p.amountMsat), guardianFeeMsat: p.feeMsat }));
  const toPlayers = payouts.filter((p) => playerKeys.has(keyOf(p))).map((p) => ({ kind: p.kind, key: keyOf(p), msat: BigInt(p.msat ?? p.amountMsat), guardianFeeMsat: p.feeMsat }));
  const t = nodeFeeTable({ contract: w.c, entries: players.map((p) => ({ stakeMsat: p.entry.stakeMsat, outcome: DELIVERED })),
    pools: { [GAME_VERIFY]: w.c.nodes, [SETTLEMENT]: w.c.nodes, [GUARDIAN]: [] }, eligible: new Set(w.c.nodes.map(toHex)) });
  // WHAT THE FEDERATION HOLDS: every payout output of the settlement transaction, and the claimed locks gone
  const stored = [];
  if (got && got.txid) for (let i = 0; i < payouts.length; i++) stored.push(!!(await port.status({ txid: fromHex(got.txid), outIdx: BigInt(i) })).stored);
  const locksLeft = [];
  for (const p of players) locksLeft.push(!!(await port.status(p.outpoint)).stored, !!(await port.status(p.feeOutpoint)).stored);
  return { state: got && got.state, why: got && got.why, txid: got && got.txid, nodes, toPlayers, owed: t, stored, locksLeft, raw: got && got.moved };
}

/** The donation outputs as the federation holds them now: still stored for their key (not spent). */
async function heldNow(played) {
  const r = [];
  for (const d of played.donated) r.push({ key: toHex(d.recipientPk), msat: d.amountMsat, stored: !!(await port.status(d.outpoint)).stored });
  return r;
}


// A PLAYER KEY THE FEDERATION TAKES: the fixture's keys (b32(0x0a), ...) are not points, and a real lock's refund key is
// 02 || the player key - so each player here has a real x-only key.
const playerKey = () => schnorr.getPublicKey(schnorr.utils.randomSecretKey());
/** A winner under this key and beacon: the fixture's scripted drive, in the first world where it delivers. */
function winnerUnder(key, randomness) {
  for (let n = 0; n < 256; n++) {
    const worldSecret = Uint8Array.from(WINNER.worldSecret);
    worldSecret[31] = (WINNER.worldSecret[31] + n) & 255;
    const run = drivenTape(seedWordForEntry({ playerPubkey: key, worldSecret, joinTick: 0 }, randomness), WINNER.ticks);
    if (run.outcome === 'DELIVERED' && run.score > 0) return { name: 'winner', key, worldSecret, ticks: WINNER.ticks, words: (t) => run.tape[t], address: true };
  }
  throw new Error('no world where the scripted winner delivers under this key');
}

const facts = { stakeMsat: STAKE, feePerEntry: entryFeeMsat(STAKE), donationPerEntry: DONATION, netPerEntry: netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: DONATION }) };
const NETWORK_ROUND = { donationSetId: donationSetId(NETWORK), federationId: fromHex(fid) };
const w = await lockRound({ stakeMsat: STAKE, port, serveOpts: { plugins: [NEXTBLOCK, TALLY205, MARKET.registration, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST],
  // FRONTEND_BOOK leads the book's batches itself, as order-locks.test.js does
  ...(env.FRONTEND_BOOK ? { orderBatchTimer: false } : {}) }, round: NETWORK_ROUND, endMs: testNow() + 900000 });
// THE ENTRY DOOR OPENS AT THE COMMITTEE TIME: the fixtures' clock goes there, the round's end ~230 s on - room for real locks
skipTo(Number(w.c.committeeTimeMs) + 100);
try {
  // ===== FRONTEND=1 (roadmap item 7, RULED path (a)): THE WEBSITE'S SHARE ON THE REAL FEDERATION =====
  // The same tally round twice on the same two seats and federation: once with no website, once at 2026.0.9 with both entries
  // naming a website's payout key. Every line of each settlement transaction, to the msat, and what the federation holds after.
  if (env.FRONTEND_BOOK) {
    // ===== FRONTEND_BOOK=1 (comment 2295): THE WEBSITE'S SHARE ON AN ORDER BOOK, ON THE REAL FEDERATION =====
    // The test Up/Down market, two 10,000 sat orders (YES and NO at 0.50, both filled), Up wins - once with no website, once at
    // 2026.0.9 with both orders naming one. Every line of each settlement transaction, to the msat.
    const B = 500;
    const P = Number(UPDOWN_PERIOD_MS);
    const STAKE_B = 10_000_000n;
    const siteSk = schnorr.utils.randomSecretKey();
    const SITE = new Uint8Array([2, ...schnorr.getPublicKey(siteSk)]);
    const [UA, UB] = UPDOWN.attestors;
    const bookRound = async (version, frontendPk) => {
      const r = await openLockRound(w, { stakeMsat: STAKE_B, endMs: testNow() + 1800000, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks,
        round: { ...NETWORK_ROUND, gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), entryCloseMs: 900000n, ...(version > 1 ? { protocolVersion: version } : {}) } });
      for (const d of r.nodes) d.orderBook.intervalMs = B;
      skipTo(Math.max(Number(r.c.committeeTimeMs), Number(r.c.entryCloseMs) - P) + 100);
      const one = (name, pick) => lockAndPlayReal(r, { name: `${name}-v${version}`, key: playerKey(), worldSecret: b32(0), ticks: 1, words: () => [0, 0, 0, 0, 0] },
        { pick, order: { price: 50000n }, feeBps: 100, donationMsat: 0n, target: [], frontendPk });
      const yes = await one('yes', BOOK_YES);
      const no = await one('no', BOOK_NO);
      const k = Math.floor(testNow() / B);
      while (testNow() < (k + 1) * B + 20) await wait(5);
      const batch = await r.nodes.find((d) => d.orderBook.leads(r.rid, k)).orderBook.lead(r.rid, k);
      skipTo(Number(r.c.entryCloseMs) + 2 * B + 10);
      await closeRound(r, { window: false });
      const body = { roundId: r.rid, outcome: BOOK_YES, observedAtMs: r.c.entryCloseMs + 1n };
      await Promise.all(r.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(r.rid)}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: [UA, UB].map((a) => attestorSign(a, body)) }) })));
      const o = await (await fetch(`http://127.0.0.1:${r.nodes[0].port}/outcome?round=${toHex(r.rid)}`)).json();
      skipTo(Number(o.finalAtMs) + 100);
      let s;
      for (const stop = Date.now() + 300000; Date.now() < stop; await wait(2000)) {
        s = await standing(r.a, r);
        if (s.state === 'ACCEPTED' || s.state === 'REFUSED') break;
        await Promise.all(r.nodes.map((d) => d.settlements.settle(r.rid).catch(() => null)));
      }
      const raw = (s && s.moved && s.moved.payouts) || [];
      const msatOf = (p) => BigInt(p.msat ?? p.amountMsat);
      const of = (kind) => raw.filter((p) => p.kind === kind).map(msatOf);
      const stored = [];
      if (s && s.txid) for (let i = 0; i < raw.length; i++) stored.push(!!(await port.status({ txid: fromHex(s.txid), outIdx: BigInt(i) })).stored);
      return { version, state: s && s.state, why: s && s.why, txid: s && s.txid, batch: { certified: batch.certified, orders: (batch.orderIds || []).length },
        claims: ((s && s.moved && s.moved.claims) || []).map((c) => [c.kind, String(c.msat ?? c.amountMsat)]),
        nodes: of('signer node'), website: of('frontend'), donation: of('donation key'), winners: of('qualifier'),
        lines: raw.map((p) => ({ kind: p.kind, key: String(p.payoutPk || p.key || '').slice(0, 12), msat: msatOf(p), guardianFeeMsat: BigInt(p.feeMsat || 0) })),
        orders: [yes, no].map((p) => ({ stakeMsat: p.entry.stakeMsat, feeLockMsat: p.entry.feeMsat, donationMsat: p.entry.donationMsat, website: p.entry.frontendPk ? toHex(p.entry.frontendPk).slice(0, 12) : null })),
        stored };
    };
    const plain = await bookRound(1, null);
    out({ book: 'control: no website', ...plain });
    const viaSite = await bookRound(FRONTEND_FEE_VERSION, SITE);
    out({ book: 'both orders name the website (2026.0.9)', ...viaSite });
    facts.frontendBook = { website: toHex(SITE), plain, viaSite };
  } else if (env.FRONTEND) {
    const siteSk = schnorr.utils.randomSecretKey();
    const SITE = new Uint8Array([2, ...schnorr.getPublicKey(siteSk)]);
    const play = { adapter: TALLY_CORE.adapter, config: {} };
    const tTarget = { network: NETWORK, game: TALLY_DEV_SET };
    const tallyRound = async (version, frontendPk) => {
      const r = await openLockRound(w, { stakeMsat: STAKE, endMs: testNow() + 900000, round: { ...NETWORK_ROUND, gameId: TALLY205.gameId, simCoreHash: TALLY_CORE_HASH,
        configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300, ...(version > 1 ? { protocolVersion: version } : {}) } });
      skipTo(Number(r.c.committeeTimeMs) + 100);
      const high = await lockAndPlayReal(r, { name: `high-v${version}`, key: playerKey(), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0], address: true }, { game: play, target: tTarget, frontendPk });
      const low = await lockAndPlayReal(r, { name: `low-v${version}`, key: playerKey(), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] }, { game: play, target: tTarget, frontendPk });
      await closeRound(r);
      const s = await settled(r, [high, low]);
      const site = toHex(SITE);
      const raw = (s.raw && s.raw.payouts) || [];
      const keyOf = (p) => String(p.payoutPk || p.key || p.pk || '').toLowerCase();
      const lines = raw.map((p) => ({ kind: p.kind, key: keyOf(p).slice(0, 12), msat: BigInt(p.msat ?? p.amountMsat), guardianFeeMsat: BigInt(p.feeMsat || 0), owedMsat: p.owedMsat !== undefined ? BigInt(p.owedMsat) : null }));
      const playerKeys = new Set([high, low].map((p) => toHex(refundKeyOf(p.entry.playerPubkey))));
      const sumOf = (f) => sum(raw.filter(f).map((p) => BigInt(p.msat ?? p.amountMsat)));
      return { version, state: s.state, why: s.why, txid: s.txid, lines, stored: s.stored,
        nodesMsat: sumOf((p) => !playerKeys.has(keyOf(p)) && keyOf(p) !== site), websiteMsat: sumOf((p) => keyOf(p) === site), playersMsat: sumOf((p) => playerKeys.has(keyOf(p))),
        claims: ((s.raw && s.raw.claims) || []).map((c) => [c.kind, String(c.msat ?? c.amountMsat)]),
        entries: [high, low].map((p) => ({ stakeMsat: p.entry.stakeMsat, feeLockMsat: p.entry.feeMsat, donationMsat: p.entry.donationMsat, website: p.entry.frontendPk ? toHex(p.entry.frontendPk).slice(0, 12) : null })),
        websiteOutputs: s.txid ? await Promise.all(raw.map(async (p, i) => (keyOf(p) === site ? !!(await port.status({ txid: fromHex(s.txid), outIdx: BigInt(i) })).stored : null))).then((x) => x.filter((v) => v !== null)) : [] };
    };
    const plain = await tallyRound(1, null);
    out({ frontend: 'control: no website', ...plain });
    const viaSite = await tallyRound(FRONTEND_FEE_VERSION, SITE);
    out({ frontend: 'both entries name the website (2026.0.9)', ...viaSite });
    facts.frontend = { website: toHex(SITE), plain, viaSite, feePerEntry: entryFeeMsat(STAKE), nodesFeeOfGross: (2n * STAKE * 500n) / 10000n };
  } else {   // every other round of this harness, as before
  // NEXTBLOCK: protocol devs = game dev, merged
  const nbTarget = { network: NETWORK, game: NEXTBLOCK.donationSet };
  const won = await lockAndPlayReal(w, winnerUnder(playerKey(), w.randomness), { target: nbTarget });
  const lost = await lockAndPlayReal(w, { ...LOSER, key: playerKey() }, { target: nbTarget });
  await closeRound(w);
  const nb = await settled(w, [won, lost]);
  facts.nextblock = { state: nb.state, why: nb.why, txid: nb.txid, nodes: nb.nodes, toPlayers: nb.toPlayers, owedSeats: [...nb.owed.signerNodes.values()], pools: nb.owed.pools,
    payoutsStored: nb.stored, locksStillHeld: nb.locksLeft, devPerEntry: [await heldNow(won), await heldNow(lost)] };
  out({ round: 'nextblock', ...facts.nextblock });

  // TALLY-205 ON THE SAME NODES: its game dev a key of its own
  const t = await openLockRound(w, { stakeMsat: STAKE, endMs: testNow() + 900000, round: { ...NETWORK_ROUND, gameId: TALLY205.gameId, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 } });
  skipTo(Number(t.c.committeeTimeMs) + 100);
  const tTarget = { network: NETWORK, game: TALLY_DEV_SET };
  const play = { adapter: TALLY_CORE.adapter, config: {} };
  const high = await lockAndPlayReal(t, { name: 'high', key: playerKey(), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0], address: true }, { game: play, target: tTarget });
  const low = await lockAndPlayReal(t, { name: 'low', key: playerKey(), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] }, { game: play, target: tTarget });
  await closeRound(t);
  const ty = await settled(t, [high, low]);
  facts.tally = { state: ty.state, why: ty.why, txid: ty.txid, nodes: ty.nodes, toPlayers: ty.toPlayers, owedSeats: [...ty.owed.signerNodes.values()], pools: ty.owed.pools,
    payoutsStored: ty.stored, locksStillHeld: ty.locksLeft, devPerEntry: [await heldNow(high), await heldNow(low)] };
  out({ round: 'tally-205', ...facts.tally });

  // THE TALLY DEV COLLECTS: /donations?key= at both signer nodes, then the donor client's own pass
  const seats = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
  const listed = await Promise.all(seats.map(async (s) => (await (await fetch(`${s}/donations?key=${donorKey.recipientPkHex}`)).json()).donations));
  out({ step: '/donations?key=<tally dev>', perSeat: listed.map((l) => l.map((d) => [d.outpoint.slice(0, 12) + d.outpoint.slice(64), String(d.amountMsat), d.senderOnContract])) });
  const cfgPath = join(DONOR, 'donor.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  Object.assign(cfg, { seats, invites: { [fid]: env.INVITE }, invitesFrom: [],
    lnd: { lncli: `${env.LND_BIN}/lncli`, lnddir: `${P}/alice`, rpcserver: '127.0.0.1:30107', network: 'regtest' } });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  const once = await run(process.execPath, [donorBin, 'once', DONOR], { cwd: join(HERE, '../../arena-donor') });
  const lines = once.so.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { line: l }; } });
  for (const l of lines) out({ donor: l });
  if (once.err) out({ donor: 'exit', why: once.se.trim().split('\n').slice(-3).join(' | ') });
  const status = await run(process.execPath, [donorBin, 'status', DONOR]);
  out({ donorStatus: status.so.trim() });
  const after = [];
  for (const d of [...high.donated, ...low.donated].filter((x) => toHex(x.recipientPk) === donorKey.recipientPkHex))
    after.push({ outpoint: `${toHex(d.outpoint.txid).slice(0, 12)}:${d.outpoint.outIdx}`, msat: d.amountMsat, storedAfterCollect: !!(await port.status(d.outpoint)).stored });
  const listedAfter = await Promise.all(seats.map(async (s) => (await (await fetch(`${s}/donations?key=${donorKey.recipientPkHex}`)).json()).donations.length));
  facts.collect = { listedBefore: listed.map((l) => l.length), donor: lines, gameDevOutputsAfter: after, listedAfter };
  out({ step: 'the tally dev\'s outputs after the donor pass', after, listedAfter });

  // ===== SLICE 2: MARKETS ON THE SAME NODES AND FEDERATION =====
  const [A0, A1, A2] = MARKET.attestors;
  const MARKET_ROUND = { ...NETWORK_ROUND, gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), entryCloseMs: 60000n };
  const mTarget = { network: NETWORK, game: MARKET.registration.donationSet };
  const attest = async (r, outcomeIx, by, dt = 1n) => Promise.all(r.nodes.map(async (d) => {
    const body = { roundId: r.rid, outcome: outcomeIx, observedAtMs: r.c.entryCloseMs + dt };
    const res = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(r.rid)}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: by.map((a) => attestorSign(a, body)) }) });
    return `${res.status} ${(await res.text()).slice(0, 90)}`;
  }));
  const outcomeAt = async (r) => (await fetch(`http://127.0.0.1:${r.a.port}/outcome?round=${toHex(r.rid)}`)).json();
  const lsAt = async (r) => (await fetch(`http://127.0.0.1:${r.a.port}/lock-settlement?round=${toHex(r.rid)}`)).json();
  const untilAccepted = async (r, ms = 300000) => { let g; for (const stop = Date.now() + ms; Date.now() < stop; await wait(2000)) { g = await lsAt(r); if (g.state === 'ACCEPTED') break; } return g; };
  /** A market round on the same two nodes: entries open (end 15 min out, the clock at its committee), the picks locked. */
  async function marketRound(picks) {
    const r = await openLockRound(w, { stakeMsat: STAKE, endMs: testNow() + 900000, round: MARKET_ROUND });
    skipTo(Number(r.c.committeeTimeMs) + 100);
    const players = [];
    for (const [i, pick] of picks.entries()) {
      const seed = rand(32);
      const key = playerFor({ ...r.c, id: r.rid }, { seed, curve: pageCurve }).pubkey;
      const played = await lockAndPlayReal(r, { name: `pick${i}:${pick}`, key, worldSecret: b32(0), ticks: 1, words: () => [0, 0, 0, 0, 0] }, { target: mTarget, pick });
      players.push({ ...played, seed, pick });
    }
    return { r, players };
  }
  const pageAsk = (r, p) => ({ round: { ...r.c }, roundId: r.rid, invite: env.INVITE, seed: p.seed, curve: pageCurve, LockClient,
    nodes: r.nodes.map((d) => `http://127.0.0.1:${d.port}`), client: lc });

  // M1: picks 0, 0, 1, 2 - outcome 0, two winners
  const m1 = await marketRound([0, 0, 1, 2]);
  await closeRound(m1.r);
  const m1Attest = await attest(m1.r, 0, [A0, A2]);
  const o1 = await outcomeAt(m1.r);
  skipTo(Number(o1.finalAtMs) + 100);
  const s1 = await untilAccepted(m1.r);
  const t1 = (await outcomeAt(m1.r)).table;
  const collect = [];
  for (const p of m1.players.filter((x) => x.pick === 0)) {
    const row = t1.rows.find((x) => x.entryId === toHex(p.eid));
    const before = BigInt(await lc.balanceMsat());
    const pay = await redeemPayout(pageAsk(m1.r, p));
    const mid = BigInt(await lc.balanceMsat());
    const back = await returnStake(pageAsk(m1.r, p));
    const after = BigInt(await lc.balanceMsat());
    collect.push({ entry: toHex(p.eid).slice(0, 8), tableShare: String(BigInt(row.payoutMsat) - BigInt(row.netMsat)), payout: { ok: pay.ok, msat: String(pay.amountMsat), why: pay.why },
      walletGainPayout: String(mid - before), stakeBack: { ok: back.ok, msat: String(back.amountMsat), why: back.why }, walletGainStake: String(after - mid), net: row.netMsat });
  }
  const loserLocks = [];
  for (const p of m1.players.filter((x) => x.pick !== 0)) loserLocks.push(!!(await port.status(p.outpoint)).stored);
  facts.marketWinners = { attest: m1Attest, settlement: s1.state, why: s1.why, txid: s1.txid, table: t1,
    moved: s1.moved && { claims: s1.moved.claims.map((c) => [c.kind, String(c.msat ?? c.amountMsat)]), payouts: s1.moved.payouts.map((x) => [x.kind, String(x.pk).slice(0, 10), String(x.msat)]) },
    collect, losersLocksStillHeld: loserLocks };
  out({ market: 'M1 winners', ...facts.marketWinners, table: t1.rows.map((x) => [x.entryId.slice(0, 8), x.pick, x.netMsat, x.payoutMsat]) });

  // M2: picks 0, 1 - outcome 2, nobody right
  const m2 = await marketRound([0, 1]);
  await closeRound(m2.r);
  await attest(m2.r, 2, [A0, A1]);
  skipTo(Number((await outcomeAt(m2.r)).finalAtMs) + 100);
  const s2 = await untilAccepted(m2.r);
  const back2 = [];
  for (const p of m2.players) { const b = await returnStake(pageAsk(m2.r, p)); back2.push({ ok: b.ok, msat: String(b.amountMsat), why: b.why }); }
  facts.marketNobody = { settlement: s2.state, why: s2.why, claims: s2.moved && s2.moved.claims.map((c) => c.kind), payouts: s2.moved && s2.moved.payouts.map((x) => x.kind), stakesBack: back2 };
  out({ market: 'M2 nobody right', ...facts.marketNobody });

  // M3: picks 0, 1 - outcome 0, then 1 inside the window: DISPUTED
  const m3 = await marketRound([0, 1]);
  await closeRound(m3.r);
  await attest(m3.r, 0, [A0, A2]);
  const contra = await attest(m3.r, 1, [A1, A2], 2n);
  skipTo(Number(m3.r.c.entryCloseMs) + 2 * 600000);
  await wait(15000);
  const o3 = await outcomeAt(m3.r);
  const s3 = await lsAt(m3.r);
  const locks3 = [];
  for (const p of m3.players) locks3.push(!!(await port.status(p.outpoint)).stored, !!(await port.status(p.feeOutpoint)).stored);
  facts.marketDisputed = { contradiction: contra, state: o3.state, proof: (o3.proof || []).length, settlement: s3.state || 'none', why: s3.why, locksStillHeld: locks3 };
  out({ market: 'M3 disputed', ...facts.marketDisputed });
  }
} catch (e) {
  out({ failed: e.message, stack: String(e.stack).split('\n').slice(0, 4) });
  process.exitCode = 1;
} finally {
  writeFileSync(join(P, 'fee-split-facts.json'), JSON.stringify(facts, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  await w.close();
  // the wasm client's sockets keep Node alive: the run is over, so the process is
  process.exit(process.exitCode || 0);
}
