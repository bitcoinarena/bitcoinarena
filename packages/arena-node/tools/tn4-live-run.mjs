#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
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
 *
 * WITH THE PLAYER'S ITEMS: ITEMS_SEED_FILE=<64 hex player seed> - the entry names every item that seed's items key owns
 * in the round's game (GET /items), each with its owner proof, as the page's join does, and the run is driven with their unlocks.
 * GAME_ID=<hex prefix> picks the next round of that game version (nextblock v3: b8b88e23).
 *
 * THROUGH A REFERRAL PROGRAM (kanban #675): FRONTEND_PK=<33-byte website key hex> - the entry names it as a page that came by a ?ref= link
 * does; at settlement the key is paid 10% of the nodes' fee on this stake (GET /referral-fees on the seats then counts it).
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { routeGuardianSockets } from './guardian-ws-local.mjs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
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
import { entrySplit, lockEntry } from './entry-locks.mjs';
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
import { NEXTBLOCK_CORES_V3 as NEXTBLOCK_CORES } from '../../nextblock/plugin/truck-cores.js';
import { MANIFEST_V3, GAME_ID_V3 } from '../../nextblock/plugin/nextblock-v3.js';
import { itemsKeyFor, ownedItems, entryItemsFor, entryUnlocks } from '../../arena-client/src/item-buy.js';
const env = process.env;
for (const k of [env.NODES ? 'NODES' : 'PORTS', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
// A SEAT'S /play AT ITS OWN ADDRESS (the fixture's say() opens ws://127.0.0.1:<port>/play, so with NODES naming the
// test host's seats every batch and mark went to a local port nothing listens on, and those signers never held the run)
const sayAt = (node, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${String(node).replace(/^http/, 'ws').replace(/\/+$/, '')}/play`);
  const t = setTimeout(() => { try { ws.close(); } catch { /* closed */ } reject(new Error('no answer in 20 s')); }, 20000);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { clearTimeout(t); resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', (e) => { clearTimeout(t); reject(e); });
});
const saidOf = (got) => (got instanceof Uint8Array ? (got.length === SIGNED_RECEIPT_BYTES ? 'receipt' : `${got.length} bytes`) : String(got).slice(0, 80));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 },
  (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };

// NODES: the seats by URL - a v2 round draws its signer nodes from all 14, seven of them on the test host
const nodes = env.NODES ? env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, '')) : env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
let code = 0;
try {
  // WHICH ROUND: the one named, else the next nextblock round of the series that is open for entries and starts 75 s ahead
  if (!env.ROUND) {
    // THE FIRST SEAT THAT ANSWERS (2026-10-26: a seat held for minutes stopped every try at "fetch failed" before any step)
    let list = null;
    for (const n of nodes) { try { const r = await fetch(`${n}/rounds`, { signal: AbortSignal.timeout(30000) }); if (r.ok) { list = (await r.json()).rounds; break; } } catch { /* the next seat */ } }
    if (!list) throw new Error('no seat answered GET /rounds');
    const now = Date.now();
    const next = list.filter((x) => x.entryOpen && x.game && x.game.name === 'nextblock' && Number(x.startTimeMs) - now > 75000
      && (!env.GAME_ID || String(x.game.id).startsWith(env.GAME_ID.toLowerCase())))
      .sort((a, b) => Number(a.startTimeMs) - Number(b.startTimeMs))[0];
    if (!next) throw new Error('no nextblock round open for entries and starting more than 75 s ahead');
    env.ROUND = next.id;
  }
  // PREFLIGHT: every seat holds the round - a copy that decodes to the round's id, as a page takes it (measured 2026-10-26 00:0xZ: seat 2
  // held the 10-26 Next Block series rounds with their committee named in `nodes`, the six others without; a series round's id is
  // H(series id || index) either way, and the byte-for-byte check refused every round)
  const copies = await Promise.all(nodes.map(async (n) => { const x = await fetch(`${n}/round?id=${env.ROUND}`); return x.ok ? toHex(new Uint8Array(await x.arrayBuffer())) : `HTTP ${x.status}`; }));
  const idOfCopy = (h) => { if (h.startsWith('HTTP')) return h; try { return toHex(roundId(decodeRoundContract(new Uint8Array(Buffer.from(h, 'hex'))))); } catch (e) { return `undecodable: ${e.message}`; } };
  const ids = copies.map(idOfCopy);
  if (!ids.every((x) => x === env.ROUND)) throw new Error(`preflight: the seats do not all hold round ${env.ROUND.slice(0, 16)}: ${ids.map((h) => h.slice(0, 12)).join(' ')}`);
  if (new Set(copies).size !== 1) log({ step: 'copies differ in bytes, not in id', distinct: new Set(copies).size });
  log({ step: "preflight", round: env.ROUND.slice(0, 16), seats: copies.length });
  // SEATED BEFORE ANYTHING IS PAID (§5A.7): a seat running ARENA_SEATING takes no entry without the round's
  // seating certificate, which exists from seating_close (start - 120 s) - so wait for it, and check it as the page does
  {
    const c0 = decodeRoundContract(new Uint8Array(Buffer.from(copies[0], 'hex')));
    const close = Number(seatingCloseMs(c0)) + 5000;
    if (Date.now() < close) { log({ step: 'waiting for the seating', closeAt: new Date(close).toISOString() }); await new Promise((r) => setTimeout(r, close - Date.now())); }
    // ASKED AGAIN EVERY 5 S FOR UP TO 60 S (kanban #675, measured 2026-10-26 06:52Z and 06:56Z: the certificate stood on the seats a few
    // seconds after seating_close + 5 s, and one ask stopped two runs that had ~110 s left before the start)
    let lastWhy = null;
    for (const until = Date.now() + 60000; ;) {
      try {
        const got = await clientSettlementSignerNodes(env.ROUND, c0, nodes, { curve: pageCurve });
        const st = got.derived.seating || {};
        log({ step: 'seated', signerNodes: got.signerNodes.length, agreed: got.agreed,
          game: st.game && st.game.seated ? st.game.seated.length : null, settlement: st.settlement && st.settlement.seated ? st.settlement.seated.length : null });
        break;
      } catch (e) { lastWhy = e.message; }
      if (Date.now() >= until) throw new Error(`preflight: the round is not seated, nothing is paid: ${lastWhy}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
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
    nodes: c.nodes.length, needed: receiptsNeeded(c.gameVerifySlots), entryClose: new Date(Number(c.entryCloseMs)).toISOString() });

  // ASKED AGAIN WHILE THE SIGNER NODES ARE STILL MAKING IT (kanban #675, measured 2026-10-26 07:16Z: "holds no claim key for that round
  // yet: it is making it now, ask again in a few seconds" from three of them, right after the seating; still so after 60 s at 07:21Z), every 5 s for up to 100 s
  let att;
  for (const until = Date.now() + 100000; ;) {
    att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve });
    if (att.ok || !/making it now/.test(String(att.why)) || Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 5000));
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
  const s = { p: scalar(), player: evenPlayer() };
  s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
  const t2 = Date.now();
  const locks = await lockEntry({ lc, c, split, stakePoint: s.point, player: s.player, claimPk: att.claimPk, gate, rand });
  const lk = locks.stake;
  log({ step: 'locked', outpoint: `${toHex(lk.outpoint.txid)}:${lk.outpoint.outIdx}`, msat: net, ms: Date.now() - t2, ...(locks.txid ? { tx: locks.txid.slice(0, 16), donationOutputs: (locks.entryFields.donationOutpoints || []).length, reserveOutput: !!locks.entryFields.reserveOutpoint } : {}) });
  const fee = locks.fee, hand = fee ? fee.fields : null;
  if (fee) log({ step: 'fee locked', outpoint: `${toHex(fee.outpoint.txid)}:${fee.outpoint.outIdx}` });
  const needed = receiptsNeeded(c.gameVerifySlots);
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
    ...locks.entryFields, claimKeyAttestationRef: att.ref,
    // THE OPERATOR THIS PLAYER DECLARES (§5A.13): OPERATOR_ID=<64 hex> - a committee node advertising the same operator
    // is conflicted in this round: it neither signs nor earns
    ...(/^[0-9a-f]{64}$/.test(env.OPERATOR_ID || '') ? { operatorId: fromHex(env.OPERATOR_ID) } : {}),
    ...(/^0[23][0-9a-f]{64}$/.test(env.FRONTEND_PK || '') ? { frontendPk: fromHex(env.FRONTEND_PK) } : {}) };
  // THE PLAYER'S ITEMS, as the page's join names them (ARENA_ITEMS_FOR_ENTRY): owned by the seed's items key, in a round of version 10+
  let unlocks = [];
  if (env.ITEMS_SEED_FILE) {
    const key = itemsKeyFor(fromHex(readFileSync(env.ITEMS_SEED_FILE, 'utf8').trim()), { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) });
    if (toHex(c.gameId) !== toHex(GAME_ID_V3)) throw new Error(`round ${env.ROUND.slice(0, 16)} is not nextblock v3, which sells the items`);
    const owned = await ownedItems({ seats: nodes, player: key.pubkey, gameName: 'nextblock', fetch: (u, o) => fetch(u, o) });
    entry.items = entryItemsFor({ round: c, roundId: rid, playerPubkey: s.player, owned, manifest: MANIFEST_V3, key });
    unlocks = entryUnlocks(entry, MANIFEST_V3);
    log({ step: 'items', itemsKey: toHex(key.pubkey).slice(0, 16), owned: owned.map((o) => `${o.itemId} ${o.id.slice(0, 8)}`), entry: entry.items.map((i) => `${i.itemId} ${toHex(i.purchaseId).slice(0, 8)}`), unlocks: unlocks.map((u) => u.slice(0, 16)) });
    if (!entry.items.length) throw new Error('the seed owns no item this round\'s game sells');
  }
  const eid = entryId(entry);
  // THE RUN: the world the round's randomness seeds, driven to the gate, under the round's core and run length
  const seed = await worldSeedFor({ entry, round: env.ROUND, nodes, contract: c });
  const core = NEXTBLOCK_CORES.get(toHex(c.simCoreHash));
  if (!core) throw new Error(`the round names core ${toHex(c.simCoreHash).slice(0, 16)}, which nextblock does not hold`);
  const config = core.configs.get(toHex(c.configHash)) || {};
  const N = c.blockTicks;
  const drive = drivenTape(seed.seedWord, N);
  const A = core.adapter;
  const st = A.start(seed.seedWord, config, { runTicks: N, ...(unlocks.length ? { items: unlocks } : {}) });
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
  const signerNodes = [];
  for (const n of nodes) {
    const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const enWhy = (await en.text()).trim().slice(0, 140);
    if (hand) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(hand)) });
    const l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
    // ITS FIRST MARK AT ONCE (measured 2026-10-14: published 30 s after the seats stored the entry, past their start
    // deadline - 900 ticks + 5 s from the stake seen - two seats signed FORFEIT at the door and the entry went VOID), as the page
    // sends it a second into the run; the rest after every seat holds the entry
    const early = [];
    if (Date.now() >= Number(c.startTimeMs)) for (const [m, kind] of msgs.slice(0, 2)) { let got; try { got = await sayAt(n, m); } catch (e) { got = `error ${e.message}`; } early.push(`${kind}: ${saidOf(got)}`); }
    signerNodes.push({ node: n, handout: h.status, entry: en.status, ...(en.status >= 300 ? { entryWhy: enWhy } : {}),
      lock: l.status, lockSaid: (await l.text()).trim().slice(0, 160), ...(early.length ? { early } : {}) });
  }
  log({ step: 'handed over', entry: toHex(eid).slice(0, 16), signerNodes });
  if (signerNodes.filter((x) => x.lock >= 200 && x.lock < 300).length < needed) throw new Error('fewer seats than needed took the lock');


  // after the round's start, as a player's inputs are
  const waitMs = Number(c.startTimeMs) - Date.now() + 2000;
  if (waitMs > 0) { log({ step: 'waiting for the start', ms: waitMs }); await new Promise((ok) => setTimeout(ok, waitMs)); }
  const published = [];
  for (const n of nodes) {
    const said = [];
    const sent = signerNodes.find((x) => x.node === n);
    for (const [m, kind] of msgs.slice(sent && sent.early ? 2 : 0)) {
      let got; try { got = await sayAt(n, m); } catch (e) { got = `error ${e.message}`; }
      said.push(`${kind}: ${saidOf(got)}`);
    }
    published.push({ node: n, said });
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
