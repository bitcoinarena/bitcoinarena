#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * WINNINGS ALWAYS SENT, ON A REAL FEDERATION (2026-09-21; ruled for FEDERATION 2026-09-23).
 *
 *   PROBE=<federation-hold-probe dir, SECOND_GATEWAY=1> LOCK_BIN=<blwp-stake-lock with gateways/send> WASM_PKG=<dir>
 *   INVITE=<invite> ALICE_RPC=<host:port> BOB_RPC=<host:port> CAROL_RPC=<host:port> LND_BIN=<dir> [PHASE=pass|fail|expiry|poolA|poolB|poolC]
 *   [PLAYERS_FILE=<find-players.mjs lines: 5 delivered, distinct scores, then 1 wrecked>]   (poolA/poolC; else searched here)
 *   [BTC_RPCPORT=<the probe chain's rpc port> BTC_WALLET=<its wallet>]   (expiry only: blocks are mined past the contract)
 *     node packages/arena-node/tools/winnings-probe.mjs
 *
 * PASS (the ruled order): a paying FEDERATION round on two signer nodes over the federation's own lock port, their
 * claim key their own DKG's. W and L deposit and lock through the page's own lock client; W names a Lightning address
 * once, signed with W's session key - an https LNURL address backed by the payer's lnd (alice) - and nothing of the
 * player's runs after that. W delivers, L does not. Close, the objection window, FINAL, and the settlement. Printed:
 * the owed msat; the invoice's hash and amount and its SETTLED time on alice; the gateway that paid (the channel
 * alice was paid over); the preimage's sha256 against the hash; the contract id; L's lock claimed; one payment row
 * on each signer node. Then both signer nodes are restarted on their stores and given time to re-gather: still one
 * SETTLED invoice, no new settlement, one row each.
 * FAIL: the same round with both runs under min_score and W's address named anyway - no payout contract, no invoice
 * asked of the address, and both stake locks still in the federation, to expire back.
 * EXPIRY (step 5): the lowest-key gateway is LIVE - it answers routing_info - but its node cannot carry the winning
 * (its outbound to the winner drained beforehand, by an ordinary payment), so it does not pay. Blocks are mined past the
 * contract's expiration; the signer nodes refund it to the committee and re-send it through the next live gateway to a
 * fresh invoice. Printed: both attempts, the first invoice never settled, the second SETTLED, one row each.
 * THE POOL (ruled 2026-09-23: (ii), with (iii); never (i)). Only a qualifier who named an address is paid.
 * POOL A: five qualifiers (two paying ranks) and a loser; every qualifier names the address but the TOP scorer. Its
 * share is split over the addressed rows by the table's weights; printed: each qualifier's score, whether it named
 * an address, what the settlement paid it, the pot claimed against the payouts, their fees and the input fees (no
 * remainder), each addressed payout's invoice SETTLED once on alice, one PAID row per signer node; then a restart.
 * POOL B: one qualifier and a loser, nobody names an address - no stake lock claimed, no invoice asked, both stake
 * locks still in the federation, the fee locks settled.
 * POOL C: as A with every qualifier addressed - the table's own split, one send per paying qualifier through the
 * lowest-key live gateway, each SETTLED once.
 * WALKAWAY (RULED 2026-09-30, destination 1; regtest only): nobody qualifies. A walker locks through the page's
 * own lock client, commits at both signer nodes and sends nothing; a player beside it plays and is WRECKED (FAILED). The
 * door (§15) signs the walker FORFEIT 0 at both; its first mark sent after the line is the same door. At the close the
 * walker's stake lock is claimed - 75% to the round's two sitting signer nodes, each one pre-expired contract to its
 * own key and redeemed here by that node's own key, 25% to the donation set by share_bps through the Lightning-address
 * send (the regtest set's two recipients, answering with alice's invoices on a free port: the set names 127.0.0.1:18777,
 * which this probe never binds - its LNURL fetch is pointed at the recipients' own port). Printed: the door, the late
 * mark, the settlement's claims and payouts, each node's redeem, each donation invoice on alice, the walker's lock gone,
 * the FAILED player's lock still held to expire back, GET /forfeit for both.
 * NODES=7 runs the round on seven signer nodes (5 of 7). DONATION_DOWN=1 (RULED 2026-09-30, hole 1 (a)): nothing answers
 * for the donation set at the close - the settlement completes with the 25% held under the committee key - and the
 * recipients start only after that; printed: the held contracts, then the retry paying the set. RESTART=1 restarts every
 * signer node on its own store while the share is held, before the recipients answer.
 * It prints what it measured and decides nothing.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { assumeAssigned } from '../test/assignment.js';
import { contractFor, opts, WINNER, LOSER, GENESIS_HASH, wordsAt, drivenTape, say, secretScalar } from '../test/window-fixture.js';
import { bondedChainSlot, bondedChainFor } from '../test/lock-fixture.js';
import { CLOCK } from '../test/block-clock.js';
import { splitCertificate, checkPlanTaken } from '../src/plan-taken.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash, O_SCORE, S_STATE } from '../../nextblock/src/state.js';
import { RUN_LIVE, RUN_DELIVERED, RUN_WRECKED } from '../../nextblock/src/rules/gate.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { lowestLiveGateway } from '../../arena-protocol/src/winnings-send.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { askerOrder } from '../src/payout.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_ENDPOINTS } from '../../arena-protocol/src/test-donation-sets.js';
import { serveDonationRecipients } from '../src/lnurl-recipients.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const P = env.PROBE;
for (const k of ['PROBE', 'LOCK_BIN', 'WASM_PKG', 'INVITE', 'ALICE_RPC', 'BOB_RPC', 'CAROL_RPC', 'LND_BIN'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const PHASE = env.PHASE || 'pass';
const say_ = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };
const bytesToNumber = (b) => BigInt(`0x${toHex(b)}`);
const numberToBytes32 = (n) => fromHex(n.toString(16).padStart(64, '0'));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 120000 }, (err, out, e) => done({ ok: !err, out: String(out), err: String(e || (err && err.message) || '') })));
const lncli = async (who, ...a) => {
  const rpc = { alice: env.ALICE_RPC, bob: env.BOB_RPC, carol: env.CAROL_RPC }[who];
  const r = await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/${who}`, `--rpcserver=${rpc}`, '--network=regtest', ...a]);
  if (!r.ok) throw new Error(`lncli ${who} ${a[0]}: ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out);
};

// THE WINNER'S LIGHTNING ADDRESS: https on this machine, answering LUD-16/LUD-06 with alice's own invoices, each
// carrying the description hash of this metadata. The signer nodes fetch it trusting only this certificate.
const dir = mkdtempSync(join(tmpdir(), 'blwp-winnings-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
const cert = readFileSync(join(dir, 'cert.pem'));
const METADATA = JSON.stringify([['text/plain', 'a BLWP winning, sent']]);
const asked = [];
const lnurlServer = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, async (req, res) => {
  const u = new URL(req.url, 'https://127.0.0.1');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/lnurlp/winner')
    return json({ tag: 'payRequest', callback: `https://127.0.0.1:${lnurlServer.address().port}/cb`, metadata: METADATA,
      minSendable: 1000, maxSendable: 1000000000 });
  if (u.pathname === '/cb') {
    const amount = u.searchParams.get('amount');
    const inv = await lncli('alice', 'addinvoice', '--amt_msat', amount, '--description_hash', toHex(sha256(new TextEncoder().encode(METADATA))));
    asked.push({ amountMsat: amount, hash: inv.r_hash, at: Date.now() });
    return json({ pr: inv.payment_request, routes: [] });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lnurlServer.listen(0, '127.0.0.1', r));
const ADDRESS = `winner@127.0.0.1:${lnurlServer.address().port}`;
// WALKAWAY: THE DONATION SET'S RECIPIENTS, answering with alice's invoices under each recipient's own metadata.
const WALK = PHASE === 'walkaway';
const donationAsked = [];
const N = WALK ? Number(env.NODES || 2) : 2;
const DOWN = WALK && env.DONATION_DOWN === '1';
const startRecipients = () => serveDonationRecipients({ port: 0, invoice: async ({ amountMsat, descriptionHash }) => {
  const inv = await lncli('alice', 'addinvoice', '--amt_msat', String(amountMsat), '--description_hash', toHex(descriptionHash));
  donationAsked.push({ amountMsat: String(amountMsat), hash: inv.r_hash });
  return { request: inv.payment_request };
} });
let recipients = WALK && !DOWN ? await startRecipients() : null;
const SET_BASE = new URL(TEST_DONATION_ENDPOINTS[0]).origin;
const lnurlFetch = (url) => (WALK && String(url).startsWith('http://')
  ? (recipients ? fetch(String(url).replace(SET_BASE, recipients.base)) : Promise.reject(new Error(`connect ECONNREFUSED ${new URL(url).host}`)))
  : new Promise((done, fail) => {
  const req = httpsRequest(url, { ca: cert }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => done({ json: async () => JSON.parse(b) })); });
  req.on('error', fail); req.end();
}));

const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
// THE CHAIN THE ROUND IS READ FROM (RULED 2026-09-25: a paying round opens only on a node that reads the chain): the
// fixtures' bonded chain names the census and the beacon; the money is this regtest federation's, through its own lock
// port. The players seed from that beacon, as the signer nodes replay them.
const slot = bondedChainSlot(port);
const stores = Array.from({ length: N }, (_, i) => join(dir, `${'abcdefg'[i]}.db`));
// `ports`: a restart comes back on each node's own port - the round's contract names those endpoints.
const up = async (ports = []) => {
  const nodes = [];
  for (const [i, path] of stores.entries()) nodes.push(await serve(openStore(path), { plugins: [NEXTBLOCK], port: ports[i] || 0, ...opts, stakeLocks: slot.port, poolCurve: curve,
    finality: { everyMs: 500 }, lnurlFetch, winningsEveryMs: 3000, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor,
    ...(WALK ? { donationSets: [TEST_DONATION_SET_REGTEST], doorSweepMs: 250 } : {}) }));
  for (const d of nodes) d.round.chainView = CLOCK.chainView();
  for (const d of nodes) {
    const there = nodes.filter((o) => o !== d).map((o) => `http://127.0.0.1:${o.port}`);
    d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
  }
  return nodes;
};
const all = await up();
let [a, b] = all;

const esm = join(dir, 'blwp-lock-client.mjs');
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasmMod = await import(esm);
await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const { LockClient } = wasmMod;

const STAKE = 1000000n;
const minScore = PHASE === 'fail' ? 0xffffffff : 1;
const fedId = (await port.gateways()).federationId;
const drafted = { ...contractFor(all.map((d) => d.round.pubkey), 20000n, all.map((d) => `http://127.0.0.1:${d.port}`)),
  custody: 'FEDERATION', federationId: fedId, minScore, stakeMsat: STAKE };
const bonded = bondedChainFor(drafted.nodes, drafted, slot, { endpoints: all.map((d) => `ws://127.0.0.1:${d.port}`) });
const c = { ...drafted, censusRoot: bonded.censusRoot, committeeTimeMs: bonded.committeeTimeMs };
const rid = roundId(c);
const RANDOMNESS = slot.randomnessFor({ contract: c }).hash;
for (const d of all) {
  const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
  assumeAssigned(d.round, rid, c.nodes);
}
for (let pass = 0; pass < 2; pass++) for (const d of all) await d.dkg.run(c.nodes);
const held = a.dkg.signerNodeFor(c.nodes);
if (!held.ok) throw new Error(`claim key: ${held.why}`);
const claimPk = held.pool.groupPublicKey;
say_({ step: 'round', phase: PHASE, round: toHex(rid).slice(0, 16), claimKey: toHex(claimPk).slice(0, 16), minScore, address: ADDRESS });

// THE PLAYERS' MONEY, through the page's lock client: one deposit that covers both players' stake and fee locks.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const mem = new Map();
const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(rand(32)),
  { entries: () => JSON.stringify([...mem]), put: (k, v) => { mem.set(k, v); }, remove: (k) => { mem.delete(k); } });
const POOL = /^pool[AC]$/.test(PHASE);
const rcv = JSON.parse(await lc.receive(POOL ? '6600000' : '2300000', ''));
await lncli('alice', 'payinvoice', '--force', rcv.invoice).catch(() => null);
say_({ step: 'deposit', final: await lc.awaitReceive(rcv.operation), balanceMsat: await lc.balanceMsat() });
const rule = JSON.parse(await lc.feeRule());
const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });

async function lockAndPlay(who, { noMarks = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const p = secretScalar();
  const point = feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD);
  const refundPk = refundKeyOf(who.key);
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });
  const lk = lockFromClient(await lc.lock(toHex(point), String(net), toHex(claimPk), toHex(refundPk), 150), { point, claimPk, refundPk });
  let F = new Uint8Array(32), feeOut = { txid: new Uint8Array(32), outIdx: 0n }, feeFields = null;
  if (gate.pays) {
    F = rand(32);
    const fl = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(claimPk), toHex(refundPk), 150),
      { hash: sha256(F), claimPk, refundPk });
    feeOut = fl.outpoint; feeFields = fl.fields;
  }
  const e = rand(32);
  const dealt = await dealHandout({ preimage: p, signerNodes: c.nodes, roundId: rid, playerPubkey: who.key, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: receiptsNeeded(N) - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: receiptsNeeded(N), curve: feldmanGroup });
  const entry = { roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(p),
    stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0, worldSecret: who.worldSecret,
    vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: F,
    stakeLockOutpoint: lk.outpoint, feeLockOutpoint: feeOut, claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => (who.words || wordsAt)(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...(who.words || wordsAt)(t));
  const mark = { roundId: rid, entryId: eid, tick: who.ticks, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  const said = [];
  for (const d of all) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const j = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    if (j.status !== 201) throw new Error(`entry: ${j.status} ${await j.text()}`);
    const l = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
    if (feeFields) await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    said.push(l.status);
    // `noMarks`: seated and staked, and nothing sent - a walk-away (§15 at the door)
    if (noMarks) continue;
    await say(d.port, encodeInputBatch(input));
    await say(d.port, signedMark);
  }
  return { eid, session, outpoint: lk.outpoint, locked: said, late: [encodeInputBatch(input), signedMark] };
}
// REAL PLAYER KEYS, AND RUNS CHOSEN THE WAY THE FIXTURE CHOSE ITS OWN: the seed is the player's key with the world
// secret, so for each real key the world secret's last byte is stepped until the core itself says the fixture's
// driver DELIVERS (W) or WRECKS (L) within its ticks. Measured, never assumed.
const runOf = (playerPubkey, worldSecret, ticks) => {
  const st = init(seedWordForEntry({ playerPubkey, worldSecret, joinTick: 0 }, RANDOMNESS));
  for (let t = 0; t < ticks; t++) { step(st, ...wordsAt(t)); if (st.i32[O_SCORE + S_STATE] !== RUN_LIVE) break; }
  return st.i32[O_SCORE + S_STATE];
};
const playerLike = (who, want) => {
  for (;;) {
    let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02);
    const key = schnorr.getPublicKey(k);
    for (let last = 0; last < 256; last++) {
      const worldSecret = Uint8Array.from(who.worldSecret); worldSecret[31] = last;
      // THE WINNER IS DRIVEN CLOSED-LOOP IN ITS OWN WORLD (window-fixture drivenTape): the recorded tape was steered in
      // another world and misses under this round's beacon.
      if (want === RUN_DELIVERED) {
        const run = drivenTape(seedWordForEntry({ playerPubkey: key, worldSecret, joinTick: 0 }, RANDOMNESS), who.ticks);
        if (run.outcome === 'DELIVERED' && run.score > 0) return { ...who, key, worldSecret, score: run.score, words: (t) => run.tape[t] };
        continue;
      }
      if (runOf(key, worldSecret, who.ticks) === want) return { ...who, key, worldSecret };
    }
  }
};
const nameAddress = async (played) => {
  const signed = new TextEncoder().encode(ADDRESS);
  const sig = ed25519.sign(signed, played.session);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/payout-address?entry=${toHex(played.eid)}`, { method: 'POST', body: Buffer.concat([Buffer.from(signed), Buffer.from(sig)]) });
    if (r.status !== 201) throw new Error(`address: ${r.status} ${await r.text()}`);
  }
};
let W; let L; let Q = [];
if (WALK) {
  W = await lockAndPlay(playerLike(LOSER, RUN_WRECKED), { noMarks: true });
  L = await lockAndPlay(playerLike(LOSER, RUN_WRECKED));
  say_({ step: 'played', walker: { entry: toHex(W.eid).slice(0, 16), lock: W.locked }, failed: { entry: toHex(L.eid).slice(0, 16), lock: L.locked } });
  const resultsAt = (d, eid) => d.round.results(rid, eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body)).map((r) => `${r.outcome}/${r.score}`);
  const t = Date.now();
  for (const stop = Date.now() + 90000; Date.now() < stop && !(resultsAt(a, W.eid).length && resultsAt(b, W.eid).length); await wait(500));
  for (const stop = Date.now() + 60000; Date.now() < stop && all.some((d) => !resultsAt(d, W.eid).length); await wait(500));
  say_({ step: 'door', msAfterLock: Date.now() - t, A: resultsAt(a, W.eid), B: resultsAt(b, W.eid), signedAt: all.map((d) => resultsAt(d, W.eid).join()),
    entryVoid: [!!a.round.entryVoid(W.eid), !!b.round.entryVoid(W.eid)] });
  // THE WALKER'S FIRST MARK, SENT PAST THE LINE: the same door, recorded FORFEIT at both.
  const said = [];
  for (const d of all) for (const m of W.late) said.push(String(await say(d.port, m)).slice(0, 100));
  say_({ step: 'late first mark', said: [...new Set(said)], recorded: all.map((d) => !!d.round.startForfeit(W.eid)),
    A: resultsAt(a, W.eid), B: resultsAt(b, W.eid) });
} else if (POOL) {
  // FIVE QUALIFIERS WITH DISTINCT SCORES AND A LOSER: from find-players.mjs lines, or searched here.
  const lines = env.PLAYERS_FILE ? readFileSync(env.PLAYERS_FILE, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)) : [];
  const asWho = (x) => ({ name: x.state, key: fromHex(x.key), worldSecret: fromHex(x.worldSecret), ticks: x.ticks, score: x.score });
  const winners = lines.filter((x) => x.state === 'DELIVERED').map(asWho);
  while (winners.length < 5) winners.push(playerLike(WINNER, RUN_DELIVERED));
  const loser = lines.find((x) => x.state === 'WRECKED');
  for (const who of winners.slice(0, 5)) Q.push({ ...(await lockAndPlay(who)), key: who.key, score: who.score });
  L = await lockAndPlay(loser ? asWho(loser) : playerLike(LOSER, RUN_WRECKED));
  const top = [...Q].sort((x, y) => y.score - x.score)[0];
  for (const q of Q) { q.addressed = PHASE === 'poolC' || q !== top; if (q.addressed) await nameAddress(q); }
  say_({ step: 'played', qualifiers: Q.map((q) => ({ entry: toHex(q.eid).slice(0, 16), score: q.score, addressed: q.addressed, lock: q.locked })),
    L: { entry: toHex(L.eid).slice(0, 16), lock: L.locked } });
  W = Q.find((q) => q.addressed);
} else {
  W = await lockAndPlay(playerLike(WINNER, RUN_DELIVERED));
  L = await lockAndPlay(playerLike(LOSER, RUN_WRECKED));
  say_({ step: 'played', W: { entry: toHex(W.eid).slice(0, 16), lock: W.locked }, L: { entry: toHex(L.eid).slice(0, 16), lock: L.locked } });
  // W NAMES THE ADDRESS ONCE, signed with W's session key - and nothing of the player's runs from here. Not in POOL B.
  if (PHASE !== 'poolB') { await nameAddress(W); say_({ step: 'address named', address: ADDRESS }); }
}

// EXPIRY: GATEWAY A STAYS LIVE AND CANNOT CARRY THE WINNING. Drained here, after every deposit of this round (a deposit
// through A pays bob and refills his outbound - measured: it did, and A paid attempt 0), by an ordinary payment from bob
// to alice that leaves him less than the winning to send.
if (PHASE === 'expiry') {
  const chan = (await lncli('bob', 'listchannels')).channels[0];
  const spendable = Number(chan.local_balance) - Number(chan.local_constraints.chan_reserve_sat);
  let drained = null;
  for (let amt = spendable - 300; amt > spendable - 4000 && !drained; amt -= 250) {
    const pr = (await lncli('alice', 'addinvoice', '--amt', String(amt), '--memo', 'drain')).payment_request;
    const r = await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/bob`, `--rpcserver=${env.BOB_RPC}`, '--network=regtest', 'payinvoice', '--force', '--fee_limit', '50', pr]);
    if (/Payment status: SUCCEEDED/.test(r.out)) drained = amt;
  }
  const after = (await lncli('bob', 'listchannels')).channels[0];
  say_({ step: 'gateway A drained', paidToAlice: drained, bobLocal: after.local_balance, bobReserve: after.local_constraints.chan_reserve_sat });
}
await Promise.all(all.map((d) => say(d.port, `close ${toHex(rid)}`)));
const t0 = Date.now();
const standing = async (d) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(rid)}`)).json();
const winnings = async (d, eid) => (await fetch(`http://127.0.0.1:${d.port}/winnings?entry=${toHex(eid)}`)).json();
let settled = null;
for (const stop = Date.now() + 240000; Date.now() < stop; await wait(1000)) {
  const s = await standing(a);
  if (s.state === 'ACCEPTED') { settled = s; break; }
}
say_({ step: 'settlement', state: settled ? settled.state : (await standing(a)).state, ms: Date.now() - t0, txid: settled && settled.txid,
  moved: settled && settled.moved });

// THE SEATS AGREED BEFORE THE PAYOUT, AS A THRESHOLD OF SIGNATURES (PRIORITIES 2026-09-29 item 2): each signer node's
// certificate for the send plan - the plan id and the signed acceptances that counted - checked here, on its own, against
// the round's seats: a key the contract seats, a signature that verifies, over that id, one per seat, 2 of 2 needed.
for (const d of [a, b]) {
  const r = await fetch(`http://127.0.0.1:${d.port}/settle-taken?round=${toHex(rid)}`);
  if (r.status !== 200) { say_({ step: 'seats agreed', node: toHex(d.round.pubkey).slice(0, 16), status: r.status, why: (await r.text()).slice(0, 160) }); continue; }
  const cert = await r.json();
  const records = splitCertificate(fromHex(cert.certificate));
  const checked = records.map((x) => checkPlanTaken(x, { seats: c.nodes, planId: fromHex(cert.planId) }));
  const who = new Set(checked.filter((x) => x.ok).map((x) => x.who));
  say_({ step: 'seats agreed', node: toHex(d.round.pubkey).slice(0, 16), planId: cert.planId.slice(0, 16), signed: records.length,
    verified: checked.filter((x) => x.ok).length, distinctSeats: who.size, needed: receiptsNeeded(c.nodes.length),
    threshold: who.size >= receiptsNeeded(c.nodes.length) });
}

const invoiceOf = async (hash) => lncli('alice', 'lookupinvoice', hash);
const channelPeer = async (chanId) => {
  const chans = (await lncli('alice', 'listchannels')).channels || [];
  const ch = chans.find((x) => String(x.chan_id) === chanId || String(x.scid) === chanId);
  return ch ? ch.remote_pubkey : null;
};
const rowsOn = async (eid) => Promise.all([a, b].map((d) => winnings(d, eid)));

// THE FEE-LOCK PATH, TO THE END (PRIORITIES 2026-09-29 item 3; regtest only, never testnet4): the players' fee locks
// (hash locks to H(F), F handed over in the entry) are claimed by the settlement and pay each sitting signer node one
// pre-expired payout contract to its own key (lock-settlement.js). Here each signer node collects its own: the stock
// client's redeem with the refund witness, signed by the node's identity key, into this probe's federation client.
// Printed per node: the payout, accepted or not, whether the guardians still hold the contract after.
if (settled && settled.moved) {
  // AND A WALK-AWAY'S 75% (WALKAWAY): each sitting signer node's remainder payout, collected the same way.
  const fees = settled.moved.payouts.map((p, outIdx) => ({ ...p, outIdx })).filter((p) => p.kind === 'signer node' || p.kind === 'remainder node');
  for (const p of fees) {
    const d = all.find((n) => toHex(n.round.pubkey) === p.pk.slice(2));
    if (!d) { say_({ step: 'fee collected', pk: p.pk.slice(0, 18), why: 'no signer node here holds that key' }); continue; }
    let secret = Uint8Array.from(d.round.identity.secret);
    // THE CONTRACT NAMES THE EVEN KEY (02 || x): an odd node key signs with its negation, which is that key.
    if (secp256k1.getPublicKey(secret, true)[0] !== 0x02) secret = numberToBytes32(FIELD - bytesToNumber(secret));
    const r = await run(env.LOCK_BIN, ['--mode', 'redeem', '--data-dir', `${P}/client`, '--outpoint', `${settled.moved.txid}:${p.outIdx}`,
      '--signer-secret', toHex(secret), '--witness', 'refund', '--hash', '00'.repeat(32), '--amount-msat', String(p.msat),
      '--claim-pk', p.pk, '--refund-pk', p.pk, '--expiration', '0']);
    const line = r.out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const j = line ? JSON.parse(line) : {};
    say_({ step: 'fee collected', kind: p.kind, node: p.pk.slice(2, 18), outIdx: p.outIdx, msat: p.msat, accepted: j.accepted ?? null,
      signerIsRefundPk: j.signer_is_refund_pk ?? null, heldAfter: j.stored_after ? 'held' : 'none', error: j.error ? String(j.error).slice(0, 160) : (line ? null : r.err.slice(-200)) });
  }
}

if (PHASE === 'pass') {
  let rows = null;
  for (const stop = Date.now() + 180000; Date.now() < stop; await wait(1000)) {
    rows = await rowsOn(W.eid);
    if (rows.every((r) => r.winnings && r.winnings.state === 'PAID')) break;
  }
  // THE PROPOSER'S ROW carries the contract (txid, output); both carry the preimage.
  const send = rows.map((r) => r.send).find((x) => x && x.txid) || rows[0].send;
  const inv = send ? await invoiceOf(send.paymentHash) : null;
  const htlc = inv && inv.htlcs && inv.htlcs[0];
  const via = htlc ? await channelPeer(String(htlc.chan_id)) : null;
  const contract = send ? await port.send({ paymentHash: send.paymentHash, amountMsat: BigInt(send.payoutMsat), expiration: BigInt(send.expiration),
    claimPk: send.gatewayPk, refundPk: claimPk, invoice: send.invoice }) : null;
  const contractAfter = send && send.txid ? await port.status({ txid: fromHex(send.txid), outIdx: BigInt(send.outIdx) }) : null;
  const gwKeys = { A: (await lncli('bob', 'getinfo')).identity_pubkey, B: (await lncli('carol', 'getinfo')).identity_pubkey };
  const lStatus = await port.status(L.outpoint);
  say_({ step: 'winnings', owedMsat: send && send.owedMsat, payoutMsat: send && send.payoutMsat,
    invoice: send && { hash: send.paymentHash, amountMsat: send.invoiceMsat, gatewayUrl: send.gatewayUrl, gatewayModuleKey: send.gatewayPk,
      expiration: send.expiration, txid: send.txid, outIdx: send.outIdx },
    alice: inv && { state: inv.state, amtPaidMsat: inv.amt_paid_msat, settleDate: inv.settle_date,
      paidOverChannelTo: via === gwKeys.A ? 'gateway A (bob)' : via === gwKeys.B ? 'gateway B (carol)' : via },
    preimageHashesToInvoice: send && send.preimage ? toHex(sha256(fromHex(send.preimage))) === send.paymentHash : false,
    contractId: contract && contract.contractId, contractInFederationAfter: contractAfter,
    htlcChannel: htlc ? String(htlc.chan_id) : null, gatewayLnds: gwKeys,
    rows: rows.map((r) => r.winnings && r.winnings.state), loserLockInFederationAfter: lStatus, addressAsked: asked.length });

  // RESTART both signer nodes on their stores; give them time to re-gather; nothing may be paid twice.
  const before = { asked: asked.length, settled: (await lncli('alice', 'listinvoices', '--max_invoices', '1000')).invoices.filter((i) => i.state === 'SETTLED').length };
  await a.close(); await b.close();
  [a, b] = await up();
  await wait(30000);
  const after = { asked: asked.length, settled: (await lncli('alice', 'listinvoices', '--max_invoices', '1000')).invoices.filter((i) => i.state === 'SETTLED').length };
  const rowsAfter = await rowsOn(W.eid);
  say_({ step: 'restart', before, after, settlement: (await standing(a)).state,
    rows: rowsAfter.map((r) => r.winnings && r.winnings.state), aliceInvoice: send ? (await invoiceOf(send.paymentHash)).state : null });
} else if (PHASE === 'expiry') {
  const attempts = () => a.round.sendAttemptsOf(rid).concat(b.round.sendAttemptsOf(rid));
  let first = null;
  for (const stop = Date.now() + 180000; Date.now() < stop; await wait(1000)) {
    first = attempts().find((r) => r.attempt === 0 && /did not pay/.test(r.why || ''));
    if (first) break;
  }
  say_({ step: 'attempt 0', gatewayUrl: first && first.gatewayUrl, why: first && first.why, expiration: first && first.expiration,
    invoiceOnAlice: first ? (await invoiceOf(first.paymentHash)).state : null });
  // PAST THE CONTRACT'S EXPIRATION, on this probe's own chain: mined, and waited for in the federation's own height.
  const cli = (...x) => execFileSync('/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli', ['-regtest', `-rpcport=${env.BTC_RPCPORT}`,
    '-rpcuser=arena', '-rpcpassword=arena', `-rpcwallet=${env.BTC_WALLET}`, ...x], { encoding: 'utf8' }).trim();
  const need = Number(first.expiration);
  let fedHeight = (await port.gateways()).height;
  const addr = cli('getnewaddress');
  while (fedHeight < need + 2) {
    cli('generatetoaddress', String(Math.min(200, need + 4 - fedHeight)), addr);
    await wait(3000);
    fedHeight = (await port.gateways()).height;
  }
  say_({ step: 'mined past expiration', federationHeight: fedHeight, expiration: need });
  let rows = null;
  for (const stop = Date.now() + 300000; Date.now() < stop; await wait(2000)) {
    rows = await rowsOn(W.eid);
    if (rows.every((r) => r.winnings && r.winnings.state === 'PAID')) break;
  }
  const all = a.round.sendAttemptsOf(rid);
  const second = all.find((r) => r.attempt === 1) || b.round.sendAttemptsOf(rid).find((r) => r.attempt === 1);
  const inv2 = second ? await invoiceOf(second.paymentHash) : null;
  say_({ step: 'expiry', attempts: all.map((r) => ({ attempt: r.attempt, gatewayUrl: r.gatewayUrl, hash: r.paymentHash.slice(0, 16),
      invoiceMsat: r.invoiceMsat, payoutMsat: r.payoutMsat, txid: r.txid, state: r.state, why: (r.why || '').slice(0, 120) })),
    firstInvoiceOnAlice: first ? (await invoiceOf(first.paymentHash)).state : null,
    secondInvoiceOnAlice: inv2 && { state: inv2.state, amtPaidMsat: inv2.amt_paid_msat, settleDate: inv2.settle_date },
    preimageHashesToSecondInvoice: rows && rows[0].send && rows[0].send.preimage ? toHex(sha256(fromHex(rows[0].send.preimage))) === second.paymentHash : null,
    rows: rows && rows.map((r) => r.winnings && r.winnings.state), addressAsked: asked.length });
} else if (POOL) {
  // EVERY ADDRESSED QUALIFIER WITH A PAYOUT, PAID ONCE; what the settlement moved, against the pot it claimed.
  const moved = settled && settled.moved;
  const paidAll = async () => {
    const out = [];
    for (const q of Q) out.push({ q, rows: await rowsOn(q.eid) });
    return out;
  };
  let rows = await paidAll();
  for (const stop = Date.now() + 240000; Date.now() < stop; await wait(2000)) {
    rows = await paidAll();
    // EVERY SENT PAYOUT OF THE SETTLEMENT PAID ON BOTH SIGNER NODES (measured: a row not yet made read as done).
    const sent = moved ? moved.payouts.filter((p) => p.kind === 'sent').length : 0;
    if (rows.filter(({ rows: r }) => r.every((x) => x.winnings && x.winnings.state === 'PAID')).length >= sent) break;
  }
  const settledOnAlice = async () => (await lncli('alice', 'listinvoices', '--max_invoices', '1000')).invoices.filter((i) => i.state === 'SETTLED').length;
  const perQ = [];
  for (const { q, rows: r } of rows) {
    const send = r.map((x) => x.send).find((x) => x && x.txid) || r[0].send;
    const inv = send ? await invoiceOf(send.paymentHash) : null;
    perQ.push({ entry: toHex(q.eid).slice(0, 16), score: q.score, addressed: q.addressed, payoutMsat: send && send.payoutMsat,
      owedMsat: send && send.owedMsat, invoiceMsat: send && send.invoiceMsat, gateway: send && send.gatewayUrl,
      alice: inv && { state: inv.state, amtPaidMsat: inv.amt_paid_msat, htlcs: (inv.htlcs || []).length },
      preimageHashes: send && send.preimage ? toHex(sha256(fromHex(send.preimage))) === send.paymentHash : null,
      rows: r.map((x) => x.winnings && x.winnings.state), attempts: a.round.sendAttemptsOf(rid).filter((x) => toHex(x.entryId) === toHex(q.eid)).length,
      ownLockInFederation: await port.status(q.outpoint) });
  }
  const g = await port.gateways();
  say_({ step: 'pool', phase: PHASE, moved, qualifiers: perQ, lowestLiveGateway: (lowestLiveGateway(g.gateways) || {}).url,
    loserLockInFederationAfter: await port.status(L.outpoint), addressAsked: asked.length });
  // RESTART both signer nodes on their stores; nothing may be paid twice.
  const before = { asked: asked.length, settled: await settledOnAlice() };
  await a.close(); await b.close();
  [a, b] = await up();
  await wait(30000);
  const after = { asked: asked.length, settled: await settledOnAlice() };
  say_({ step: 'restart', before, after, settlement: (await standing(a)).state,
    rows: await Promise.all(Q.map(async (q) => (await rowsOn(q.eid)).map((r) => r.winnings && r.winnings.state))) });
} else if (WALK) {
  // THE PROPOSER holds the sends it drives: the round's asker (M3.3-19's seat 0).
  const sorted = [...all].sort((x, y) => (toHex(x.round.pubkey) < toHex(y.round.pubkey) ? -1 : 1));
  const first = askerOrder(rid, sorted.map((d) => d.round.pubkey)).order[0];
  let lead = sorted.find((d) => toHex(d.round.pubkey) === toHex(first));
  let others = all.filter((d) => d !== lead);
  // DONATION_DOWN: the settlement went through with nothing answering for the set - the 25% HELD under the committee key.
  if (DOWN) {
    const heldRows = () => lead.round.sendAttemptsOf(rid).filter((r) => r.donation && r.attempt === 0);
    for (const stop = Date.now() + 120000; Date.now() < stop && !(heldRows().length && heldRows().every((r) => r.state === 'HELD')); await wait(1000));
    const m = settled && settled.moved;
    const held = [];
    for (const r of heldRows()) held.push({ address: r.address.slice(0, 28), state: r.state, payoutMsat: r.payoutMsat, invoice: r.invoice ? 'yes' : 'none',
      contract: r.txid ? `${r.txid.slice(0, 16)}:${r.outIdx}` : null,
      inFederation: r.txid ? await port.status({ txid: fromHex(r.txid), outIdx: BigInt(r.outIdx) }) : null });
    say_({ step: 'held, nothing answering for the set', settlement: settled && settled.state, remainder: m && m.remainder,
      remainderNodes: m && m.payouts.filter((p) => p.kind === 'remainder node').map((p) => [p.pk.slice(2, 14), p.msat]),
      heldPayouts: m && m.payouts.filter((p) => p.kind === 'held').map((p) => [p.msat, p.pk === toHex(claimPk) ? 'committee claim key' : p.pk]),
      held, recipientsAsked: donationAsked.length, walkerLockInFederation: await port.status(W.outpoint) });
    // RESTART=1: every signer node stopped and started again on its own store while the share is held.
    if (env.RESTART === '1') {
      const li = all.indexOf(lead);
      for (const d of all) await d.close();
      const fresh = await up(all.map((d) => d.port));
      all.splice(0, all.length, ...fresh);
      lead = all[li]; others = all.filter((d) => d !== lead);
      say_({ step: 'restarted every signer node on its store', held: lead.round.sendAttemptsOf(rid).filter((r) => r.donation).map((r) => [r.attempt, r.state]) });
    }
    recipients = await startRecipients();
    say_({ step: 'the recipients answer now', at: recipients.base });
  }
  const donations = () => lead.round.sendPlansOf(rid).filter((r) => r.donation);
  for (const stop = Date.now() + 300000; Date.now() < stop; await wait(2000)) {
    const rows = donations();
    if (rows.length && rows.every((r) => r.state === 'PAID')) break;
  }
  const sends = [];
  for (const r of donations()) {
    const inv = r.paymentHash ? await invoiceOf(r.paymentHash) : {};
    sends.push({ address: r.address.slice(0, 28), attempt: r.attempt, owedMsat: r.owedMsat, payoutMsat: r.payoutMsat, invoiceMsat: r.invoiceMsat, gateway: r.gatewayUrl,
      state: r.state, atOthers: others.map((d) => (d.round.sendPlansOf(rid).find((x) => x.paymentHash === r.paymentHash) || {}).state || '-').join(),
      preimageHashes: r.preimage ? toHex(sha256(fromHex(r.preimage))) === r.paymentHash : null,
      alice: { state: inv.state, amtPaidMsat: inv.amt_paid_msat } });
  }
  const forfeit = async (eid) => (await fetch(`http://127.0.0.1:${lead.port}/forfeit?round=${toHex(rid)}&entry=${toHex(eid)}`)).status;
  say_({ step: 'walkaway', settlement: settled && settled.state, why: settled && settled.why, remainder: settled && settled.moved && settled.moved.remainder,
    claims: settled && settled.moved && settled.moved.claims, payouts: settled && settled.moved && settled.moved.payouts,
    donationSends: sends, recipientsAsked: donationAsked.length, winnerAddressAsked: asked.length,
    walkerLockInFederationAfter: await port.status(W.outpoint), failedLockInFederationAfter: await port.status(L.outpoint),
    forfeitDoor: { walker: await forfeit(W.eid), failed: await forfeit(L.eid) },
    heldContractsAfter: DOWN ? await Promise.all(lead.round.sendAttemptsOf(rid).filter((r) => r.donation && r.attempt === 0 && r.txid)
      .map(async (r) => ((await port.status({ txid: fromHex(r.txid), outIdx: BigInt(r.outIdx) })).stored ? 'held' : 'spent'))) : null,
    signerNodes: `${receiptsNeeded(N)} of ${N}` });
} else if (PHASE === 'poolB') {
  await wait(20000);
  const s = await standing(a);
  const g = await port.gateways();
  say_({ step: 'pool B', settlement: s.state, why: s.why, moved: s.moved, addressAsked: asked.length,
    rows: (await rowsOn(W.eid)).map((r) => r.winnings), stakeLocksStillStored: { W: await port.status(W.outpoint), L: await port.status(L.outpoint) },
    liveGateways: g.gateways.filter((x) => x.live).length });
} else {
  await wait(20000);
  const rows = await rowsOn(W.eid);
  const s = await standing(a);
  const stored = { W: await port.status(W.outpoint), L: await port.status(L.outpoint) };
  say_({ step: 'no qualifier', settlement: s.state, moved: s.moved, addressAsked: asked.length, rows: rows.map((r) => r.winnings),
    sends: rows.map((r) => r.send), stakeLocksStillStored: stored });
}
for (const d of (WALK ? all : [a, b])) await d.close(); lnurlServer.close(); if (recipients) await recipients.close();
process.exit(0);
