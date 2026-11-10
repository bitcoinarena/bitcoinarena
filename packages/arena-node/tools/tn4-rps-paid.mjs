#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * TWO PAID PLAYERS AT ONE ROCK PAPER SCISSORS TABLE ON TESTNET4, WITHOUT A BROWSER (2026-10-11: "first
 * player joins, second player joins the same round"). Each player is its own wallet (the page's wasm lock client): a
 * deposit from the payer lnd through the named gateway, the stake and fee locks to the round's attested claim key, the
 * shares handed out, and an entry carrying its hidden move (head-to-head.js). Player 2 sits at player 1's table. After the
 * entry close both reveal; then the settlement is read until FINAL. Paid as tn4-live-run.mjs pays (its block, unchanged).
 *
 *   PORTS=... INVITE_FILE=... WASM_PKG=... LNCLI=... PAYER_DIR=... PAYER_RPC=... [ROUND=<id>] node tools/tn4-rps-paid.mjs
 *
 * (tn4-live-run.mjs's header, for the paid part:)
 * ONE LIVE TESTNET4 ROUND, PLAYED WITHOUT A BROWSER ("one live round replayed and settled sandboxed on a seat").
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
import { readFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { routeGuardianSockets } from './guardian-ws-local.mjs';
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
import { settlementOf, forfeitOf } from '../../arena-client/src/page-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { entrySplit, lockEntry } from './entry-locks.mjs';
import { pickSeatedTableRound } from './seated-table-pick.mjs';
import { addressBook } from './signer-addresses.mjs';
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
for (const k of [env.NODES ? 'NODES' : 'PORTS', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
// A SEAT THAT DROPS ONE CONNECTION IS ASKED AGAIN (2026.1.9.11 release check: a Next Block player's first handout POST got
// "fetch failed" under load, and the run stopped with its stake locked; the other player's, 5 s later, went through at every seat)
{ const once = globalThis.fetch;
  globalThis.fetch = async (u, o) => { for (let i = 0; ; i++) { try { return await once(u, o); }
    catch (e) { if (i >= 2 || !/fetch failed/.test(String(e && e.message))) throw e; await new Promise((ok) => setTimeout(ok, 1000)); } } }; }
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 },
  (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
// the player's key with its secret: the winner collects its payout and its stake under it (redeemPayout / redeemStake)
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return { secret: k, pubkey: schnorr.getPublicKey(k) }; };

import { hiddenMove, moveCommitment, revealMove } from '../../arena-client/src/head-to-head.js';
import { RPS_GAME_ID } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { GAME_ID_V2 as RPS_GAME_ID_V2 } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v2.js';
import { GAME_ID_V5 as RPS_GAME_ID_V5 } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v5.js';
// NODES: the seats by URL - a v2 round draws its signer nodes from all 14, seven of them on the test host
const nodes = env.NODES ? env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, '')) : env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
// THE NEWEST VERSION'S TABLES by default (2026-10-27: the day grids post v5 62a940ae; v5 decides with v4's core, which decides as v1's -
// the moves, the hidden entry and the reveal are the same); RPS_V1=1 / RPS_V2=1 for the older tables
// A PRIVATE CHAIN'S OWN GENESIS (as tn4-live-run.mjs, kanban #1412: the head-to-head audit regtest): ANCHOR_HASH=<block hash hex, display order>
// on a devnet, where no compiled-in anchor names the chain
const anchorAt = env.ANCHOR_HASH ? { hash: Uint8Array.from(Buffer.from(env.ANCHOR_HASH, 'hex')).reverse(), height: Number(env.ANCHOR_HEIGHT || 0) } : null;
const GAME = toHex(env.RPS_V1 ? RPS_GAME_ID : env.RPS_V2 ? RPS_GAME_ID_V2 : RPS_GAME_ID_V5);

async function paidEntry(c, rid, roundHex, move, who) {
  const STAKE = BigInt(c.stakeMsat);
  const log0 = log;
  const log1 = (o) => log0({ player: who, ...o });
  { const log = log1;
    // A TABLE'S KEY IS MADE WHEN A PLAYER FIRST ASKS (pick (c)): asked again every 3 s for up to 90 s, as the page does
    let att = null;
    for (let t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 3000))) {
      att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve });
      if (att.ok || Date.now() - t0 > 90000) break;
    }
    if (!att.ok) throw new Error(`claim key: ${att.why}`);
    log({ step: 'claim key', claimPk: toHex(att.claimPk).slice(0, 16) });

    if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
    if (!globalThis.__guardianRouted) globalThis.__guardianRouted = routeGuardianSockets() || -1;
    const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
    copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
    const wasmMod = await import(esm);
    await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
    const { LockClient } = wasmMod;
    const held = new Map();
    const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
    // NOTHING PAID INTO A FEDERATION THE ROUND DOES NOT NAME (2026.1.9.11 release check: two runs took a federation-B table with
    // this federation-A wallet - every seat then said "the federation holds no lock" and the stake waits for its expiry)
    if (String(LockClient.federationIdOf(invite)).toLowerCase() !== toHex(c.federationId))
      throw new Error(`the round names federation ${toHex(c.federationId).slice(0, 8)}, this wallet pays into ${String(LockClient.federationIdOf(invite)).slice(0, 8)}: nothing paid`);
    const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), toHex(rand(32)), memStore);
    const rule = JSON.parse(await lc.feeRule());
    const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
    // WHAT THE ENTRY PAYS, AS THE PAGE'S JOIN (entry-locks.mjs): from protocol 11 a 4 % fee, 4 % to the developers, 2 % to the reserves
    const split = await entrySplit({ c, roundHex: toHex(rid), nodes });
    const net = split.netMsat;
    log({ step: 'joined', feeRule: rule, feeLock: gate.pays, netStakeMsat: net, feeMsat: split.feeMsat, donationMsat: split.donationMsat, reserveKey: split.reserveKey ? toHex(split.reserveKey).slice(0, 16) : null });

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
    const me = evenPlayer();
    const s = { p: scalar(), player: me.pubkey };
    s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
    const t2 = Date.now();
    const locks = await lockEntry({ lc, c, split, stakePoint: s.point, player: s.player, claimPk: att.claimPk, gate, rand });
    const lk = locks.stake;
    log({ step: 'locked', outpoint: `${toHex(lk.outpoint.txid)}:${lk.outpoint.outIdx}`, msat: net, ms: Date.now() - t2, ...(locks.txid ? { tx: locks.txid.slice(0, 16), donationOutputs: (locks.entryFields.donationOutpoints || []).length, reserveOutput: !!locks.entryFields.reserveOutpoint } : {}) });
    const fee = locks.fee, hand = fee ? fee.fields : null;
    if (fee) log({ step: 'fee locked', outpoint: `${toHex(fee.outpoint.txid)}:${fee.outpoint.outIdx}` });
    // THE CONTRACT'S SLOTS NAME THE THRESHOLD, as join.js reads it: 9 drawn for 7 slots, so a round with 6 seated plays at 5
    // (2026.1.9.11 release check: "no committee threshold for 6 slots" after the deposit)
    const needed = receiptsNeeded(c.settlementSlots ?? c.gameVerifySlots);
    const e = rand(32);
    const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
      coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
    const session = ed25519.utils.randomSecretKey();
    const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(s.p), stakeMsat: STAKE, feeMsat: split.feeMsat, donationMsat: split.donationMsat, joinTick: 0,
      // A SHARED-WORLD ROUND'S ENTRY NAMES NO WORLD SECRET, as the page's join writes it (join.js; found by the regtest run of
      //: every seat refused a random one, "an entry names no world secret (32 zero bytes)")
      worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? new Uint8Array(32) : rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
      ...locks.entryFields, claimKeyAttestationRef: att.ref };
    // THE HIDDEN MOVE (head-to-head.js): the entry commits to it; the move and salt are revealed after the entry close
    const hidden = hiddenMove(move, rand);
    entry.commit = moveCommitment({ roundId: rid, sessionPubkey: entry.sessionPubkey, move: hidden.move, salt: hidden.salt });
    const eid = entryId(entry);
    // EVERY SEAT AT ONCE (2026.1.9.12 release check, 2026-10-29: locked at 11:29:32Z, handed to the 14 seats one after another until
    // 11:32:43Z - 35 s past the entry close; every signer node said "the round is closed")
    const signerNodes = await Promise.all(nodes.map(async (n) => {
      // SKIP_ENTRY=<port or host> (kanban #1068): P2's entry, handout and locks are not handed to that seat, as a client that
      // never reached it; the seats that took it hand it on (entry-relay.js), and the run reads whether the skipped seat holds it
      if (who === 'P2' && env.SKIP_ENTRY && n.includes(env.SKIP_ENTRY)) return { node: n, skipped: true };
      const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      const enWhy = (await en.text()).trim().slice(0, 140);
      // ASKED AGAIN UNTIL THE SEAT SEES THE LOCK, as the page's market.js asks (2026.1.9.11 release check: the RPS run handed
      // its lock 2 s after the lock tx and all 7 signer nodes said "the federation holds no lock"; Next Block's 7 s later passed)
      let l;
      for (const until = Date.now() + 45000; ;) {
        if (hand) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(hand)) });
        l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
        if (l.status !== 409 || Date.now() >= until) break;
        const why = await l.clone().text();
        if (!/holds no lock/.test(why)) break;
        await new Promise((ok) => setTimeout(ok, 3000));
      }
      return { node: n, handout: h.status, entry: en.status, ...(en.status >= 300 ? { entryWhy: enWhy } : {}),
        lock: l.status, lockSaid: (await l.text()).trim().slice(0, 160) };
    }));
    log({ step: 'handed over', entry: toHex(eid).slice(0, 16), signerNodes });
    // KEYS_FILE: the player's key and locks, one line each, so a collect that failed can be done again by hand (testnet only). Kept BEFORE
    // the seats' count is judged (kanban #803: a run stopped by that throw left a 94,000 msat lock whose key was gone with the process).
    if (env.KEYS_FILE) appendFileSync(env.KEYS_FILE, `${JSON.stringify({ at: new Date().toISOString(), round: toHex(rid), entry: toHex(eid), player: who,
      secret: toHex(me.secret), stake: `${toHex(locks.stake.outpoint.txid)}:${locks.stake.outpoint.outIdx}`,
      fee: locks.fee ? `${toHex(locks.fee.outpoint.txid)}:${locks.fee.outpoint.outIdx}` : null })}\n`);
    if (signerNodes.filter((x) => x.lock >= 200 && x.lock < 300).length < needed) throw new Error('fewer seats than needed took the lock');

  return { eid, hidden, signerNodes, lc, playerSecret: me.secret, playerPubkey: s.player, stake: locks.stake, fee: locks.fee };
  }
}

let code = 0;
try {
  // THE ROUND: the one named, else the soonest seated RPS round whose entry closes more than 150 s ahead (time for two deposits)
  let roundHex = env.ROUND;
  if (!roundHex) {
    // the next 60 rounds of each series (measured 2026-10-27: ?ahead=7200000 took over 20 s, the whole list 19 MB in 31 s; next=60, 1.5 MB in 12 s)
    const list = (await (await fetch(`${nodes[0]}/rounds?next=60`)).json()).rounds || [];
    const now = Date.now();
    // AHEAD_S (default 270): a round whose seating is still to come (seating close = entry close - 200 s on an RPS grid), so its
    // certificate forms while this waits - measured 20:38Z and 20:53Z: a round taken 150 s ahead had missed its seating under load
    const ahead = Number(env.AHEAD_S || 270) * 1000;
    const rows = list.filter((r) => r.game && r.game.id === GAME && Number(r.entryCloseMs) - now > ahead
      && (!env.FEDERATION || String(r.federation || '').toLowerCase().startsWith(String(env.FEDERATION).toLowerCase()))).sort((a, b) => Number(a.entryCloseMs) - Number(b.entryCloseMs) || (a.id < b.id ? -1 : 1));
    if (!rows.length) throw new Error(`no RPS round held whose entry closes more than ${ahead / 1000} s ahead`);
    // ONLY A ROUND OF A SEATED TABLE (kanban #803, seated-table-pick.mjs); FEDERATION=<hex prefix>: only a table of the federation this
    // payer's wallet pays into - both grids list together; PROTOCOL=<n> (kanban #543, 2026-10-21): only a round of that protocol version
    {
      // a backup grid's round takes no entry while its window's primary committee is drawn (§5A.5; kanban #1068's first run paid a lock into one)
      const got = await pickSeatedTableRound(rows.filter((r) => !r.backup).map((r) => r.id), {
        contractOf: async (id) => new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${id}`)).arrayBuffer()),
        // a seat not drawn for the table holds no certificate of it (404): every seat is asked, any one holding it is enough
        seated: async (anchor, role) => (await Promise.all(nodes.map((n) => fetch(`${n}/seating?round=${anchor}&role=${role}`, { signal: AbortSignal.timeout(10000) }).then((r) => r.ok, () => false)))).some(Boolean),
        accept: (k) => (!env.FEDERATION || toHex(k.federationId).startsWith(String(env.FEDERATION).toLowerCase())) && (!env.PROTOCOL || Number(k.protocolVersion) === Number(env.PROTOCOL)) });
      for (const p of got.passed) log({ step: 'round passed', id: p.id.slice(0, 16), why: p.why });
      roundHex = got.id;
      if (!roundHex) throw new Error(`no RPS round of a seated table${env.FEDERATION ? ` of federation ${env.FEDERATION}` : ''}${env.PROTOCOL ? ` at protocol ${env.PROTOCOL}` : ''} among the next 40`);
    }
  }
  const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${roundHex}`)).arrayBuffer()));
  const rid = roundId(c);
  if (toHex(rid) !== roundHex) throw new Error('the seat answered another round');
  log({ step: 'round', id: roundHex.slice(0, 16), stakeMsat: c.stakeMsat, entryClose: new Date(Number(c.entryCloseMs)).toISOString(), nodes: c.nodes.length });
  // SEATED BEFORE ANYTHING IS PAID (§5A.7): wait for the seating close, then the page's own certificate check
  const close = Number(seatingCloseMs(c)) + 5000;
  if (Date.now() < close) { log({ step: 'waiting for the seating', closeAt: new Date(close).toISOString() }); await new Promise((r) => setTimeout(r, close - Date.now())); }
  // THE CERTIFICATE MAY COME A LITTLE AFTER THE CLOSE: every seated seat's signature is gathered (measured 21:11Z under load:
  // none 11 s after the close, all 7 seats holding it a minute later) - asked again every 5 s, until 150 s before entry close
  let seated = null;
  for (;;) {
    try { seated = await clientSettlementSignerNodes(roundHex, c, nodes, { curve: pageCurve, ...(anchorAt ? { anchorAt } : {}) }); break; }
    catch (e) { if (!/no certificate/.test(e.message) || Date.now() > Number(c.entryCloseMs) - 150000) throw e; log({ step: 'certificate not yet', why: e.message.slice(0, 120) }); await new Promise((r) => setTimeout(r, 5000)); }
  }
  log({ step: 'seated', signerNodes: seated.signerNodes.length, agreed: seated.agreed });
  // SKIP_ENTRY=auto (kanban #1068): the seat P2 skips is the first of PORTS that sits on the round's settlement
  if (env.SKIP_ENTRY === 'auto') {
    const keys = new Set(seated.signerNodes.map((k) => (typeof k === 'string' ? k : toHex(k)).toLowerCase()));
    for (const n of nodes.filter((u) => /127\.0\.0\.1:312/.test(u))) {
      const k = toHex(new Uint8Array(await (await fetch(`${n}/identity`)).arrayBuffer())).slice(0, 64);
      if (keys.has(k)) { env.SKIP_ENTRY = n; break; }
    }
    log({ step: 'P2 skips', seat: env.SKIP_ENTRY });
    if (env.SKIP_ENTRY === 'auto') throw new Error('no seated seat among PORTS to skip');
  }
  // THE SIGNER NODES OUTSIDE NODES (kanban #804, signer-addresses.mjs): asked for the claim key and handed the entries at their own addresses
  { const st = (seated.derived && seated.derived.seating) || {};
    const out = await addressBook([...nodes]).outside([...c.nodes, ...(st.game && st.game.seated) || [], ...(st.settlement && st.settlement.seated) || []]);
    // a seated node that has since stopped (kanban #808: mactest19911b) answers nothing: the round plays on without it
    const live = (await Promise.all(out.map((u) => fetch(`${u}/identity`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? u : null), () => null)))).filter(Boolean);
    if (out.length) { nodes.push(...live); log({ step: 'signer nodes outside NODES', addresses: out, answering: live.length }); } }
  // NOTHING PAID FOR A ROUND TOO FEW SEATS TOOK
  if (seated.signerNodes.length < receiptsNeeded(c.settlementSlots ?? c.gameVerifySlots)) throw new Error(`seated ${seated.signerNodes.length}, fewer than the round needs: nothing paid`);
  if (env.DRY) { log({ step: 'dry run: nothing paid' }); process.exit(0); }
  const moves = [Number(env.MOVE_1 ?? 0), Number(env.MOVE_2 ?? 2)];   // 0 rock, 1 paper, 2 scissors (the game's own numbering)
  const p1 = await paidEntry(c, rid, roundHex, moves[0], 'P1');
  const p2 = await paidEntry(c, rid, roundHex, moves[1], 'P2');
  const table = await (await fetch(`${nodes[0]}/api/round-result?round=${roundHex}`)).json().catch(() => null);
  log({ step: 'table', players: table && table.players ? table.players.length : null });
  // THE REVEALS after the entry close
  const wait = Number(c.entryCloseMs) - Date.now() + 1500;
  if (wait > 0) { log({ step: 'waiting for the entry close', ms: wait }); await new Promise((r) => setTimeout(r, wait)); }
  // BOTH AT ONCE, as two players' pages do (kanban #604, 2026-10-24 05:36Z: one after the other, P1's reveal waited 37 s on one seat
  // and P2's reached the seats after the reveal window - a FORFEIT the harness made); each seat's refusal is logged with its reason
  await Promise.all([[p1, 'P1'], [p2, 'P2']].map(async ([p, who]) => {
    const t0 = Date.now();
    const said = await revealMove({ entryIdHex: toHex(p.eid), move: p.hidden.move, salt: p.hidden.salt, nodes });
    log({ step: 'revealed', player: who, ms: Date.now() - t0, said: said.map((x) => x.status ?? x),
      refused: said.filter((x) => x.status === 409).map((x) => `${x.node}: ${x.why}`) });
  }));
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

  // THE WINNER COLLECTS, as the page's redeemPayout and redeemStake do (2026.1.9.11 release check, the owner HARD: "Auszahlung muss
  // funktionieren"): the settlement's payout contract to this player's refund key, spent by refund under that key, then its own
  // stake (and fee lock) by the seats' forfeit. Asked until a seat holds the accepted settlement, at most 15 min.
  let st = null;
  for (const stop = Date.now() + 15 * 60000; ;) {
    st = await settlementOf({ roundId: rid, nodes });
    if (st.ok || Date.now() > stop) break;
    log({ step: 'settlement not accepted yet', why: st.why.slice(0, 200) });
    await new Promise((r) => setTimeout(r, 30000));
  }
  if (!st.ok) throw new Error(`no accepted settlement to collect from: ${st.why}`);
  log({ step: 'settled', txid: st.txid.slice(0, 16), from: st.from, payouts: st.moved.payouts.length });
  for (const [p, who] of [[p1, 'P1'], [p2, 'P2']]) {
    const before = await p.lc.balanceMsat();
    const mine = toHex(refundKeyOf(p.playerPubkey));
    const at = st.moved.payouts.findIndex((x) => x.kind === 'qualifier' && String(x.pk).toLowerCase() === mine);
    let payout = null;
    if (at >= 0) {
      const x = st.moved.payouts[at];
      const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(x.msat), claimPk: mine, refundPk: mine, expiration: 0 };
      const said = JSON.parse(await p.lc.refund(st.txid, at, JSON.stringify(fields), toHex(p.playerSecret)));
      payout = { msat: String(x.msat), outIdx: at, accepted: said.accepted === true, ...(said.accepted === true ? {} : { said: JSON.stringify(said).slice(0, 200) }) };
    }
    const stakes = [];
    for (const [l, kind] of [[p.stake, 'stake'], [p.fee, 'fee']]) {
      if (!l) continue;
      const f = await forfeitOf({ roundId: rid, entryId: toHex(p.eid), nodes, lock: kind });
      if (!f.ok) { stakes.push({ kind, forfeit: f.why.slice(0, 160) }); continue; }
      const said = JSON.parse(await p.lc.redeem(toHex(l.outpoint.txid), Number(l.outpoint.outIdx), JSON.stringify(lockFieldsToJson(l.fields)), f.signature, toHex(p.playerSecret)));
      stakes.push({ kind, accepted: said.accepted === true, ...(said.accepted === true ? {} : { said: JSON.stringify(said).slice(0, 200) }) });
    }
    log({ step: 'collected', player: who, payout, stakes, balanceBeforeMsat: before, balanceAfterMsat: await p.lc.balanceMsat() });
    // WITHDRAW=1 (kanban #808): the winner takes the money out over Lightning, to an invoice of the payer lnd, as the page's withdraw does
    if (env.WITHDRAW && payout && payout.accepted) {
      const can = BigInt(await p.lc.withdrawableMsat()); const sat = can / 1000n - 10n;
      const inv = JSON.parse((await payer('addinvoice', '--amt', String(sat), '--memo', 'kanban 808 B payout')).out);
      const said = JSON.parse(await p.lc.withdraw(inv.payment_request, env.GATEWAY || undefined));
      const held = JSON.parse((await payer('lookupinvoice', inv.r_hash)).out);
      log({ step: 'lightning payout', player: who, sat: String(sat), paymentHash: inv.r_hash, state: said.state, settled: held.state, amtPaidSat: held.amt_paid_sat,
        balanceBeforeMsat: said.balance_before, balanceAfterMsat: said.balance_after });
    }
  }
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) }); }
process.exit(code);
