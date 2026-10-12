#!/usr/bin/env node
/**
 * ONE LIVE TESTNET4 ROUND, PLAYED WITHOUT A BROWSER (kanban #328: "one live round replayed and settled sandboxed on a seat").
 * The lock is testnet4-lock.mjs's - the page's own wasm lock client, the deposit paid from a testnet4 lnd - and then the run:
 * the round's randomness asked of its seats (the page's worldSeedFor), a closed-loop drive of the core the round names
 * (window-fixture's drivenTape, under the round's run length), its inputs published as the page publishes them - a batch
 * and a first mark at tick 60, the rest and a last mark - over /play at every seat. Then it waits for the round to close
 * and reads what each seat replayed and signed, and the settlement.
 *
 * PREFLIGHT BEFORE PAYING: the round must be held by all seven seats, still open for entries, starting far enough ahead
 * for the deposit, and its claim key attested - or nothing is paid.
 *
 *   PORTS=<seven seat ports> INVITE_FILE=<federation invite> WASM_PKG=<dir with blwp_lock_client.js> LNCLI=<lncli>
 *   PAYER_DIR=<payer lnd dir> PAYER_RPC=<host:port> [ROUND=<id hex>] node tools/tn4-live-run.mjs
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey } from '../../arena-client/src/join.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

import { worldSeedFor, settlementBy } from '../../arena-client/src/join.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { drivenTape, say as sayTo, bedFrom, GENESIS_HASH } from '../test/window-fixture.js';
import { NEXTBLOCK_CORES } from '../../nextblock/plugin/truck-cores.js';
const env = process.env;
for (const k of ['PORTS', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 },
  (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };

const nodes = env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
let code = 0;
try {
  // WHICH ROUND: the one named, else the next nextblock round of the series that is open for entries and starts 75 s ahead
  if (!env.ROUND) {
    const list = (await (await fetch(`${nodes[0]}/rounds`)).json()).rounds;
    const now = Date.now();
    const next = list.filter((x) => x.entryOpen && x.game && x.game.name === 'nextblock' && Number(x.startTimeMs) - now > 75000)
      .sort((a, b) => Number(a.startTimeMs) - Number(b.startTimeMs))[0];
    if (!next) throw new Error('no nextblock round open for entries and starting more than 75 s ahead');
    env.ROUND = next.id;
  }
  // PREFLIGHT: every seat holds the round, the same bytes
  const copies = await Promise.all(nodes.map(async (n) => { const x = await fetch(`${n}/round?id=${env.ROUND}`); return x.ok ? toHex(new Uint8Array(await x.arrayBuffer())) : `HTTP ${x.status}`; }));
  if (new Set(copies).size !== 1 || copies[0].startsWith('HTTP')) throw new Error(`preflight: the seats do not all hold round ${env.ROUND.slice(0, 16)}: ${copies.map((h) => h.slice(0, 12)).join(' ')}`);
  log({ step: "preflight", round: env.ROUND.slice(0, 16), seats: copies.length });
  // SEATED BEFORE ANYTHING IS PAID (§5A.7, kanban #301): a seat running ARENA_SEATING takes no entry without the round's
  // seating certificate, which exists from seating_close (start - 120 s) - so wait for it, and check it as the page does
  {
    const c0 = decodeRoundContract(new Uint8Array(Buffer.from(copies[0], 'hex')));
    const close = Number(seatingCloseMs(c0)) + 5000;
    if (Date.now() < close) { log({ step: 'waiting for the seating', closeAt: new Date(close).toISOString() }); await new Promise((r) => setTimeout(r, close - Date.now())); }
    try {
      const got = await clientSettlementSignerNodes(env.ROUND, c0, nodes, { curve: pageCurve });
      const st = got.derived.seating || {};
      log({ step: 'seated', signerNodes: got.signerNodes.length, agreed: got.agreed,
        game: st.game && st.game.seated ? st.game.seated.length : null, settlement: st.settlement && st.settlement.seated ? st.settlement.seated.length : null });
    } catch (e) { throw new Error(`preflight: the round is not seated, nothing is paid: ${e.message}`); }
  }
  if (env.DRY) { log({ step: 'dry run: nothing paid' }); process.exit(0); }
  // THE ROUND, AS ITS OWN SIGNER NODES HOLD IT
  const r = await fetch(`${nodes[0]}/round?id=${env.ROUND}`);
  if (!r.ok) throw new Error(`${nodes[0]} holds no round ${env.ROUND}: ${r.status}`);
  const c = decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
  const rid = roundId(c);
  if (toHex(rid) !== env.ROUND) throw new Error('the node answered another round');
  const STAKE = BigInt(c.stakeMsat);
  log({ step: 'round', id: env.ROUND.slice(0, 16), stakeMsat: STAKE, custody: c.custody, federation: toHex(c.federationId).slice(0, 16),
    nodes: c.nodes.length, needed: receiptsNeeded(c.nodes.length), entryClose: new Date(Number(c.entryCloseMs)).toISOString() });

  const att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve });
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  log({ step: 'claim key', claimPk: toHex(att.claimPk).slice(0, 16) });

  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  const held = new Map();
  const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
  const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), toHex(rand(32)), memStore);
  const rule = JSON.parse(await lc.feeRule());
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });
  log({ step: 'joined', feeRule: rule, feeLock: gate.pays, netStakeMsat: net });

  // THE DEPOSIT: the stake plus the entry fee and what the federation takes, through whichever gateway the client picks
  const depositMsat = STAKE + entryFeeMsat(STAKE) + 200000n;
  const t = Date.now();
  // THROUGH THE PAGE'S OWN GATEWAY (GATEWAY, else the lobby's): with none named the federation picks one, and gateway A runs
  // on lnd-testnet4 itself - the payer - so its invoice was one the payer cannot pay (lnd does not pay its own invoices):
  // the three hung deposits of 2026-10-11 (12:31:44, 13:47:52, 14:04:58Z) were gateway A's invoices, never paid
  const gateway = env.GATEWAY || 'https://cleaner-cindy-duty-biggest.trycloudflare.com/';
  const rcv = JSON.parse(await lc.receive(String(depositMsat), gateway));
  const payee = JSON.parse((await payer('decodepayreq', rcv.invoice)).out).destination;
  const self = JSON.parse((await payer('getinfo')).out).identity_pubkey;
  if (payee === self) throw new Error(`the deposit invoice is on the payer's own node (${payee.slice(0, 16)}): lnd does not pay its own invoice - name another GATEWAY`);
  const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
  const final = await lc.awaitReceive(rcv.operation);
  log({ step: 'deposit', msat: depositMsat, payee: payee.slice(0, 16),
    paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, ms: Date.now() - t,
    balanceMsat: await lc.balanceMsat() });

  // LOCKED TO THE ATTESTED CLAIM KEY, AND HANDED TO EVERY SIGNER NODE
  const s = { p: scalar(), player: evenPlayer() };
  s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
  const t2 = Date.now();
  const lk = lockFromClient(await lc.lock(toHex(s.point), String(net), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
    { point: s.point, claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
  log({ step: 'locked', outpoint: `${toHex(lk.outpoint.txid)}:${lk.outpoint.outIdx}`, msat: net, ms: Date.now() - t2 });
  let fee = null, hand = null;
  if (gate.pays) {
    const F = rand(32);
    const got = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
      { hash: sha256(F), claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
    fee = { preimage: F, outpoint: got.outpoint }; hand = got.fields;
    log({ step: 'fee locked', outpoint: `${toHex(got.outpoint.txid)}:${got.outpoint.outIdx}` });
  }
  const needed = receiptsNeeded(c.nodes.length);
  const e = rand(32);
  const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(s.p), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0,
    // A SHARED-WORLD ROUND'S ENTRY NAMES NO WORLD SECRET, as the page's join writes it (join.js; found by the regtest run of
    // kanban #148 step 6: every seat refused a random one, "an entry names no world secret (32 zero bytes)")
    worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? new Uint8Array(32) : rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: fee ? fee.preimage : new Uint8Array(32), stakeLockOutpoint: lk.outpoint,
    feeLockOutpoint: fee ? fee.outpoint : { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: att.ref };
  const eid = entryId(entry);
  const signerNodes = [];
  for (const n of nodes) {
    const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const enWhy = (await en.text()).trim().slice(0, 140);
    if (hand) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(hand)) });
    const l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
    signerNodes.push({ node: n, handout: h.status, entry: en.status, ...(en.status >= 300 ? { entryWhy: enWhy } : {}),
      lock: l.status, lockSaid: (await l.text()).trim().slice(0, 160) });
  }
  log({ step: 'handed over', entry: toHex(eid).slice(0, 16), signerNodes });
  if (signerNodes.filter((x) => x.lock >= 200 && x.lock < 300).length < needed) throw new Error('fewer seats than needed took the lock');

  // THE RUN: the world the round's randomness seeds, driven to the gate, under the round's core and run length
  const seed = await worldSeedFor({ entry, round: env.ROUND, nodes, contract: c });
  const core = NEXTBLOCK_CORES.get(toHex(c.simCoreHash));
  if (!core) throw new Error(`the round names core ${toHex(c.simCoreHash).slice(0, 16)}, which nextblock does not hold`);
  const config = core.configs.get(toHex(c.configHash)) || {};
  const N = c.blockTicks;
  const drive = drivenTape(seed.seedWord, N);
  const A = core.adapter;
  const st = A.start(seed.seedWord, config, { runTicks: N });
  const ev = A.eventsOf({ loads: bedFrom(0) });
  const stateAt = [];
  const FIRST = 60;
  for (let t = 0; t < N; t++) { ev.before(st, t); A.step(st, drive.tape[t]); if (t + 1 === FIRST || t + 1 === N) stateAt[t + 1] = A.stateHash(st); }
  const played = A.result(st);
  log({ step: 'driven', seedWord: seed.seedWord, beaconHeight: seed.height, ticks: N, outcome: played.outcome, score: played.score, final: stateAt[N].slice(0, 16) });
  // THE BATCHES: the first 60 ticks, then 600 at a time - a transcript frames each batch with a u16 length (transcript.js),
  // so one batch of the whole run (97309 bytes at 4860 ticks, measured on the first live round) can never be posted
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const msgs = [];
  let previousHash = GENESIS_HASH;
  let previousMark = NO_PREVIOUS;
  for (let from = 0; from < N;) {
    const to = from === 0 ? FIRST : Math.min(N, from + 600);
    const b = { roundId: rid, entryId: eid, previousHash, firstTick: from, ticks: drive.tape.slice(from, to), liquidations: [], loads: from === 0 ? bedFrom(0) : [] };
    msgs.push([encodeInputBatch(b), `batch ${from}..${to - 1}`]);
    previousHash = batchId(b);
    if (to === FIRST || to === N) {
      const m = { roundId: rid, entryId: eid, tick: to, stateHash: fromHex(stateAt[to]), inputChainHash: previousHash, previousHash: previousMark, sessionPubkey: entry.sessionPubkey };
      msgs.push([sign(m), `mark ${to}`]);
      previousMark = checkpointId(m);
    }
    from = to;
  }
  // after the round's start, as a player's inputs are
  const waitMs = Number(c.startTimeMs) - Date.now() + 2000;
  if (waitMs > 0) { log({ step: 'waiting for the start', ms: waitMs }); await new Promise((ok) => setTimeout(ok, waitMs)); }
  const published = [];
  for (const n of nodes) {
    const port = Number(new URL(n).port);
    const said = [];
    for (const [m, kind] of msgs) {
      let got; try { got = await sayTo(port, m); } catch (e) { got = `error ${e.message}`; }
      said.push(`${kind}: ${got instanceof Uint8Array ? (got.length === SIGNED_RECEIPT_BYTES ? 'receipt' : `${got.length} bytes`) : String(got).slice(0, 80)}`);
    }
    published.push({ port, said });
  }
  log({ step: 'published', published });

  // THE CLOSE AND THE SETTLEMENT, as the page watches them
  const endMs = Number(c.startTimeMs) + Number(c.runMs || 0n);
  const until = Date.now() + 15 * 60000;
  let settled = null;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 15000));
    try { settled = await settlementBy({ entryId: eid, signerNodes: c.nodes, nodes }); } catch (e) { settled = { error: e.message }; }
    log({ step: 'settlement', at: Math.round((Date.now() - endMs) / 1000), said: settled });
    if ((settled && (settled.decided || settled.state === 'ACCEPTED' || settled.settled)) || Date.now() > until) break;
  }
  const results = [];
  for (const n of nodes) {
    try { const x = await fetch(`${n}/results?round=${env.ROUND}`); results.push({ node: n, status: x.status, body: (await x.text()).slice(0, 300) }); }
    catch (e) { results.push({ node: n, error: e.message }); }
  }
  log({ step: 'results', entry: toHex(eid), results });
} catch (e) {
  code = 1;
  log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) });
}
process.exit(code);
