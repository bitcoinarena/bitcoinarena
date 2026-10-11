#!/usr/bin/env node
/**
 * TWO PAID PLAYERS AT ONE ROCK PAPER SCISSORS TABLE ON TESTNET4, WITHOUT A BROWSER (kanban #344, the owner 2026-10-11: "first
 * player joins, second player joins the same round"). Each player is its own wallet (the page's wasm lock client): a
 * deposit from the payer lnd through the named gateway, the stake and fee locks to the round's attested claim key, the
 * shares handed out, and an entry carrying its hidden move (head-to-head.js). Player 2 sits at player 1's table. After the
 * entry close both reveal; then the settlement is read until FINAL. Paid as tn4-live-run.mjs pays (its block, unchanged).
 *
 *   PORTS=... INVITE_FILE=... WASM_PKG=... LNCLI=... PAYER_DIR=... PAYER_RPC=... [ROUND=<id>] node tools/tn4-rps-paid.mjs
 *
 * (tn4-live-run.mjs's header, for the paid part:)
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

import { hiddenMove, moveCommitment, revealMove } from '../../arena-client/src/head-to-head.js';
import { RPS_GAME_ID } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
const nodes = env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
const GAME = toHex(RPS_GAME_ID);

async function paidEntry(c, rid, roundHex, move, who) {
  const STAKE = BigInt(c.stakeMsat);
  const log0 = log;
  const log1 = (o) => log0({ player: who, ...o });
  { const log = log1;
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
    // THE HIDDEN MOVE (head-to-head.js): the entry commits to it; the move and salt are revealed after the entry close
    const hidden = hiddenMove(move, rand);
    entry.commit = moveCommitment({ roundId: rid, sessionPubkey: entry.sessionPubkey, move: hidden.move, salt: hidden.salt });
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

  return { eid, hidden, signerNodes };
  }
}

let code = 0;
try {
  // THE ROUND: the one named, else the soonest seated RPS round whose entry closes more than 150 s ahead (time for two deposits)
  let roundHex = env.ROUND;
  if (!roundHex) {
    const list = (await (await fetch(`${nodes[0]}/rounds?ahead=7200000`)).json()).rounds || [];
    const now = Date.now();
    const rows = list.filter((r) => r.game && r.game.id === GAME && Number(r.entryCloseMs) - now > 150000).sort((a, b) => Number(a.entryCloseMs) - Number(b.entryCloseMs) || (a.id < b.id ? -1 : 1));
    if (!rows.length) throw new Error('no RPS round held whose entry closes more than 150 s ahead');
    roundHex = rows[0].id;
  }
  const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${roundHex}`)).arrayBuffer()));
  const rid = roundId(c);
  if (toHex(rid) !== roundHex) throw new Error('the seat answered another round');
  log({ step: 'round', id: roundHex.slice(0, 16), stakeMsat: c.stakeMsat, entryClose: new Date(Number(c.entryCloseMs)).toISOString(), nodes: c.nodes.length });
  // SEATED BEFORE ANYTHING IS PAID (§5A.7): wait for the seating close, then the page's own certificate check
  const close = Number(seatingCloseMs(c)) + 5000;
  if (Date.now() < close) { log({ step: 'waiting for the seating', closeAt: new Date(close).toISOString() }); await new Promise((r) => setTimeout(r, close - Date.now())); }
  const seated = await clientSettlementSignerNodes(roundHex, c, nodes, { curve: pageCurve });
  log({ step: 'seated', signerNodes: seated.signerNodes.length, agreed: seated.agreed });
  if (env.DRY) { log({ step: 'dry run: nothing paid' }); process.exit(0); }
  const moves = [Number(env.MOVE_1 ?? 0), Number(env.MOVE_2 ?? 2)];   // 0 rock, 1 paper, 2 scissors (the game's own numbering)
  const p1 = await paidEntry(c, rid, roundHex, moves[0], 'P1');
  const p2 = await paidEntry(c, rid, roundHex, moves[1], 'P2');
  const table = await (await fetch(`${nodes[0]}/api/round-result?round=${roundHex}`)).json().catch(() => null);
  log({ step: 'table', players: table && table.players ? table.players.length : null });
  // THE REVEALS after the entry close
  const wait = Number(c.entryCloseMs) - Date.now() + 1500;
  if (wait > 0) { log({ step: 'waiting for the entry close', ms: wait }); await new Promise((r) => setTimeout(r, wait)); }
  for (const [p, who] of [[p1, 'P1'], [p2, 'P2']])
    log({ step: 'revealed', player: who, said: (await revealMove({ entryIdHex: toHex(p.eid), move: p.hidden.move, salt: p.hidden.salt, nodes })).map((x) => x.status ?? x) });
  // THE SETTLEMENT, until FINAL or 20 min
  const until = Date.now() + 20 * 60000;
  for (;;) {
    const said = [];
    for (const [p, who] of [[p1, 'P1'], [p2, 'P2']]) {
      let s; try { s = await settlementBy({ entryId: p.eid, signerNodes: c.nodes, nodes }); } catch (e) { s = { error: e.message }; }
      said.push({ player: who, finality: s.finality, answered: s.answered, outcome: (s.per || []).map((x) => x.outcome).filter(Boolean)[0] });
    }
    log({ step: 'settlement', said });
    if (said.every((x) => x.finality === 'FINAL') || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 30000));
  }
  const rr = await (await fetch(`${nodes[0]}/api/round-result?round=${roundHex}`)).json().catch((e) => ({ error: e.message }));
  log({ step: 'result', result: JSON.stringify(rr).slice(0, 600) });
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) }); }
process.exit(code);
