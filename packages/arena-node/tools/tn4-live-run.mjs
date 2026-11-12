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
import { readFileSync, copyFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { routeGuardianSockets } from './guardian-ws-local.mjs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey } from '../../arena-client/src/join.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { addressBook } from './signer-addresses.mjs';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { settlementOf, forfeitOf, isArenaLock } from '../../arena-client/src/page-lock.js';
import { GATE_X } from '../../nextblock/src/rules/gate.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { entrySplit, lockEntry } from './entry-locks.mjs';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

import { worldSeedFor, settlementBy } from '../../arena-client/src/join.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { drivenTape, say as sayTo, bedFrom, GENESIS_HASH } from '../test/window-fixture.js';
import * as truckCores from '../../nextblock/plugin/truck-cores.js';
// EVERY CORE A ROUND MAY NAME: every NEXTBLOCK_CORES_* map the app exports (v6 plays v5's 0847, measured 2026-10-27 10:18Z; kanban #1123,
// measured 2026-11-04: a list of v3 and v5 only stopped a v7 round after the locks - "the round names core 8cbc74b27bee7872, which
// nextblock does not hold" - and the deposit was lost)
const NEXTBLOCK_CORES = new Map(Object.entries(truckCores).filter(([k, v]) => /^NEXTBLOCK_CORES/.test(k) && v instanceof Map).flatMap(([, m]) => [...m]));
import { MANIFEST_V3, GAME_ID_V3 } from '../../nextblock/plugin/nextblock-v3.js';
import { itemsKeyFor, ownedItems, entryItemsFor, entryUnlocks } from '../../arena-client/src/item-buy.js';
const env = process.env;
// CENSUS KEY 0 OF A PRIVATE CHAIN (kanban #972): mainnet's genesis names it, regtest's does not, so a harness hands the client the one its seats were started with
// (ARENA_CENSUS_KEY_0 on the seats), and the client counts template-3 bonds naming it as a page on mainnet would. Regtest only.
const regtestKey0 = (() => {
  if (!env.ARENA_REGTEST_CENSUS_KEY_0 || (env.ARENA_TN4_NETWORK || 'testnet4') !== 'regtest') return null;
  const k = JSON.parse(readFileSync(env.ARENA_REGTEST_CENSUS_KEY_0, 'utf8'));
  return { ...genesisFor('regtest'), censusKey0: { publicKey: fromHex(k.publicKey), holders: k.holders.map(fromHex), threshold: k.threshold } };
})();
for (const k of [env.NODES ? 'NODES' : 'PORTS', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
// A SEAT THAT DROPS ONE CONNECTION IS ASKED AGAIN (2026.1.9.11 release check: a Next Block player's first handout POST got
// "fetch failed" under load, and the run stopped with its stake locked; the other player's, 5 s later, went through at every seat)
{ const once = globalThis.fetch;
  globalThis.fetch = async (u, o) => { for (let i = 0; ; i++) { try { return await once(u, o); }
    catch (e) { if (i >= 2 || !/fetch failed/.test(String(e && e.message))) throw e; await new Promise((ok) => setTimeout(ok, 1000)); } } }; }
// A SEAT'S /play AT ITS OWN ADDRESS (the fixture's say() opens ws://127.0.0.1:<port>/play, so with NODES naming the
// macOS's seats every batch and mark went to a local port nothing listens on, and those signers never held the run)
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
// A PRIVATE CHAIN'S OWN GENESIS (kanban #397): ANCHOR_HASH=<block hash hex, display order> on a devnet, where no compiled-in anchor names the chain. A page never has this
const anchorAt = env.ANCHOR_HASH ? { hash: Uint8Array.from(Buffer.from(env.ANCHOR_HASH, 'hex')).reverse(), height: Number(env.ANCHOR_HEIGHT || 0) } : null;
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
// the player's key with its secret: a winner collects its payout and its stake under it (redeemPayout / redeemStake)
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return { secret: k, pubkey: schnorr.getPublicKey(k) }; };

// SEARCH=1: A RUN THAT DELIVERS, FOUND ON THE ROUND'S OWN CORE (2026.1.9.11 release check: drivenTape steers the source tree's
// truck, and on the round's core 0847c99f it wrecked by tick 220 - FAILED, nothing to pay). The world is known before anything is
// sent, so drives are tried on it until one delivers: full or part throttle, steered at a point past the gate, at most SEARCH_MS.
// Measured offline on 0847c99f: 8 of 10 worlds give one, most in 1-17 s.
function searchedTape(A, config, seedWord, N, startOpts, { ms = 60000 } = {}) {
  const until = Date.now() + ms;
  let tried = 0;
  // A SECOND, FINER PASS WHEN THE FIRST GRID FINDS NONE (kanban #1346, measured 2026-11-10 runs c46h and c46i: a shared grid-2 world, which cannot be drawn again,
  // had no delivering drive among the first 315 and both players stopped): other aims, leads and gains, inside the same time budget
  const drives = [];
  for (const thr of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 1]) for (const gain of [6, 3, 10]) for (const lead of [20, 0, 40]) for (const aimZ of [0, 10, -10, 20, -20]) drives.push([thr, gain, lead, aimZ]);
  for (const thr of [0.45, 0.35, 0.55, 0.8]) for (const gain of [4, 8, 14]) for (const lead of [10, 30, 60]) for (const aimZ of [5, -5, 15, -15, 30, -30, 40, -40]) drives.push([thr, gain, lead, aimZ]);
  for (const [thr, gain, lead, aimZ] of drives) {
    if (Date.now() > until) return { tape: null, outcome: null, tried };
    tried++;
    const st = A.start(seedWord, config, { runTicks: N, ...startOpts });
    const ev = A.eventsOf({ loads: bedFrom(0) });
    const tape = [];
    for (let t = 0; t < N; t++) {
      if (A.result(st).outcome) { tape.push([0, 0, 0, 0, 0]); continue; }
      const p = A.picture(st);
      let off = Math.atan2(GATE_X / 65536 + lead - p.x / 65536, aimZ - p.z / 65536) / (2 * Math.PI) - p.heading / 65536;
      off -= Math.round(off);
      const w = [Math.round(thr * 65536), Math.max(-65536, Math.min(65536, Math.round(off * gain * 65536))), 0, 0, 0];
      tape.push(w); ev.before(st, t); A.step(st, w);
    }
    const r = A.result(st);
    if (r.outcome === 'DELIVERED') return { tape, outcome: r.outcome, score: r.score, tried, drive: { thr, gain, lead, aimZ } };
  }
  return { tape: null, outcome: null, tried };
}

// NODES: the seats by URL - a v2 round draws its signer nodes from all 14, seven of them on the test host
const nodes = env.NODES ? env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, '')) : env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
// A PLAYER'S OWN REFERRAL LINK (kanban #681): REFERRER_SECRET_FILE=<64 hex identity secret> - the entry names that player's program
// key, 02 and the identity key's x (identity.js referralOf), as a page opened by their ?ref= link does; with REFERRER_COLLECT=1 the run
// then collects the share the seats paid to it, by refund under that secret, as the referrer's own wallet does (collectZaps)
const REFERRER_SECRET = env.REFERRER_SECRET_FILE ? fromHex(readFileSync(env.REFERRER_SECRET_FILE, 'utf8').trim()) : null;
const REFERRAL_PK = REFERRER_SECRET ? toHex(refundKeyOf(schnorr.getPublicKey(REFERRER_SECRET))) : env.FRONTEND_PK;
let code = 0;
try {
  // WHICH ROUND: the one named, else the next nextblock round of the series that is open for entries and starts 75 s ahead
  if (!env.ROUND) {
    // THE FIRST SEAT THAT ANSWERS (2026-10-26: a seat held for minutes stopped every try at "fetch failed" before any step)
    let list = null;
    // ONLY THE NEXT ROUNDS OF EACH SERIES, as the lobby asks (measured 2026-10-27 09:27Z: the whole list was 19 MB and took 31.5 s, past the
    // 30 s this waited, so every seat counted as not answering)
    for (const n of nodes) { try { const r = await fetch(`${n}/rounds?next=2`, { signal: AbortSignal.timeout(30000) }); if (r.ok) { list = (await r.json()).rounds; break; } } catch { /* the next seat */ } }
    if (!list) throw new Error('no seat answered GET /rounds');
    const now = Date.now();
    const next = list.filter((x) => x.entryOpen && x.game && x.game.name === 'nextblock' && Number(x.startTimeMs) - now > 75000
      && (!env.GAME_ID || String(x.game.id).startsWith(env.GAME_ID.toLowerCase()))
      // NOT A BACKUP ROUND (kanban #804, measured 08:29Z 10-30: round 5aa07386 was its window's backup, and all 14 seats refused the
      // entry - "this window is played on its primary grid, whose committee is drawn (the backup rule, §5A.5)" - after it was paid and locked)
      && !x.backup
      // FEDERATION=<hex prefix> (kanban #804): only a round of the federation this payer's wallet pays into - both list together
      && (!env.FEDERATION || String(x.federation || '').toLowerCase().startsWith(String(env.FEDERATION).toLowerCase())))
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
  let seatedKeys = [];
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
        const got = await clientSettlementSignerNodes(env.ROUND, c0, nodes, { curve: pageCurve, ...(anchorAt ? { anchorAt } : {}), ...(regtestKey0 ? { genesis: regtestKey0 } : {}) });
        const st = got.derived.seating || {};
        seatedKeys = [...(st.game && st.game.seated) || [], ...(st.settlement && st.settlement.seated) || []];
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
  // THE SIGNER NODES OUTSIDE NODES (kanban #804, signer-addresses.mjs): asked for the claim key and handed the entry at their own addresses
  { const out = await addressBook([...nodes]).outside([...c.nodes, ...seatedKeys]); if (out.length) { nodes.push(...out); log({ step: 'signer nodes outside NODES', addresses: out }); } }

  // ASKED AGAIN WHILE THE SIGNER NODES ARE STILL MAKING IT (kanban #675, measured 2026-10-26 07:16Z: "holds no claim key for that round
  // yet: it is making it now, ask again in a few seconds" from three of them, right after the seating; still so after 60 s at 07:21Z), every 5 s for up to 100 s
  let att;
  for (const until = Date.now() + 100000; ;) {
    att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve });
    // AND WHILE TOO FEW OF THEM ATTEST IT YET (2026.1.9.11 check, 2026-10-27 09:31Z: "3 of 7 signer nodes attest this claim key, and this
    // round needs 5" 2 s after the seating - the rest still dealing): asked again, each count said
    if (att.ok || !/making it now|signer nodes attest this claim key/.test(String(att.why)) || Date.now() >= until) break;
    log({ step: 'claim key forming', why: String(att.why).slice(0, 160) });
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
  // NOTHING PAID INTO A FEDERATION THE ROUND DOES NOT NAME (two RPS runs took a federation-B table with the federation-A wallet)
  if (String(LockClient.federationIdOf(invite)).toLowerCase() !== toHex(c.federationId))
    throw new Error(`the round names federation ${toHex(c.federationId).slice(0, 8)}, this wallet pays into ${String(LockClient.federationIdOf(invite)).slice(0, 8)}: nothing paid`);
  const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), toHex(rand(32)), memStore);
  const rule = JSON.parse(await lc.feeRule());
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
  // WHAT THE ENTRY PAYS, AS THE PAGE'S JOIN (entry-locks.mjs): from protocol 11 a 4 % fee, 4 % to the developers, 2 % to the reserves
  const split = await entrySplit({ c, roundHex: toHex(rid), nodes });
  const net = split.netMsat;
  log({ step: 'joined', feeRule: rule, feeLock: gate.pays, netStakeMsat: net, feeMsat: split.feeMsat, donationMsat: split.donationMsat, reserveKey: split.reserveKey ? toHex(split.reserveKey).slice(0, 16) : null });

  // THE CORE IS CHECKED BEFORE ANYTHING IS PAID (kanban #1123): a round whose core this tool cannot drive stops here, not after the deposit
  if (!NEXTBLOCK_CORES.has(toHex(c.simCoreHash))) throw new Error(`the round names core ${toHex(c.simCoreHash).slice(0, 16)}, which nextblock does not hold here (place the app at its pin) - nothing is paid`);
  // THE DEPOSIT: the stake plus the entry fee and what the federation takes, through whichever gateway the client picks
  const depositMsat = STAKE + entryFeeMsat(STAKE) + 200000n;
  const t = Date.now();
  // THROUGH THE PAGE'S OWN GATEWAY (GATEWAY, else the lobby's): with none named the federation picks one, and gateway A runs
  // on lnd-testnet4 itself - the payer - so its invoice was one the payer cannot pay (lnd does not pay its own invoices):
  // the three hung deposits of 2026-10-11 (12:31:44, 13:47:52, 14:04:58Z) were gateway A's invoices, never paid
  // A PRIVATE CHAIN NAMES ITS OWN (kanban #397, measured 2026-11-02 on a devnet: this default, a testnet4 gateway the devnet's federation does not list, answered
  // "Failed to connect to gateway" in 85 ms; the devnet's own gateway gave its invoice in 89 ms, on localhost and on 127.0.0.1)
  if (anchorAt && !env.GATEWAY) throw new Error('a private chain has its own gateways: name one, GATEWAY=<url>');
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
  // THE KEYS AS SOON AS THE LOCKS STAND (kanban #1123): a run that stops after this line can still refund its locks
  if (env.KEYS_FILE) appendFileSync(env.KEYS_FILE, `${JSON.stringify({ at: new Date().toISOString(), round: toHex(rid), entry: null, step: 'locked',
    secret: toHex(me.secret), stake: `${toHex(lk.outpoint.txid)}:${lk.outpoint.outIdx}`,
    fee: locks.fee ? `${toHex(locks.fee.outpoint.txid)}:${locks.fee.outpoint.outIdx}` : null })}\n`);
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
    ...(/^0[23][0-9a-f]{64}$/.test(REFERRAL_PK || '') ? { frontendPk: fromHex(REFERRAL_PK) } : {}) };
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
  // THE RUN: the world the round's randomness seeds, driven to the gate, under the round's core and run length
  const core = NEXTBLOCK_CORES.get(toHex(c.simCoreHash));
  if (!core) throw new Error(`the round names core ${toHex(c.simCoreHash).slice(0, 16)}, which nextblock does not hold`);
  const config = core.configs.get(toHex(c.configHash)) || {};
  const N = c.blockTicks;
  const A = core.adapter;
  // A WORLD WITH NO DELIVERING DRIVE IS DRAWN AGAIN (its own world secret) while the round's world is the player's own
  let seed, drive;
  for (let tries = 1; ; tries++) {
    seed = await worldSeedFor({ entry, round: env.ROUND, nodes, contract: c });
    if (!env.SEARCH) { drive = drivenTape(seed.seedWord, N); break; }
    drive = searchedTape(A, config, seed.seedWord, N, { ...(unlocks.length ? { items: unlocks } : {}), ...(seed.slot === undefined ? {} : { slot: seed.slot }) }, { ms: Number(env.SEARCH_MS || 60000) });
    log({ step: 'searched', tries, drivesTried: drive.tried, outcome: drive.outcome, score: drive.score, drive: drive.drive });
    // QUALIFY=1 (regtest, kanban #1044): a delivery at or above the round's minimum score, so the round has a winner (measured 2026-11-05 on s27g, round
    // 687ebcdb: the search's first delivery scored 13,587 under a minimum of 100,000 - nobody won, and offence (b) had nothing to stand on)
    if (drive.tape && (!env.QUALIFY || BigInt(drive.score) >= BigInt(c.minScore))) break;
    // A SHARED WORLD WITH NO DELIVERING DRIVE IS PLAYED ANYWAY WHEN ASKED (SEARCH_FALLBACK=1, kanban #1346: runs c46h and c46i stopped on a grid-2 world 603 drives
    // could not deliver, so the round was never played and published, and what the books count - a played round - never came): the driven run, delivering or not
    if (env.SEARCH_FALLBACK === '1' && !env.QUALIFY && worldIsShared(c, sharedWorldOf(c.gameId))) { drive = drivenTape(seed.seedWord, N); log({ step: 'no delivering drive: the plain drive is played', outcome: drive.outcome || null }); break; }
    if (worldIsShared(c, sharedWorldOf(c.gameId)) || tries >= (env.QUALIFY ? 8 : 3)) throw new Error(`no ${env.QUALIFY ? 'qualifying' : 'delivering'} drive found for this world`);
    entry.worldSecret = rand(32);
  }
  // LOSE=1 (regtest, kanban #1044 B1 phase 4, offence (b)): a run that sends every mark and never moves the truck - a non-qualifying result the seats sign
  if (env.LOSE) drive = { tape: Array.from({ length: N }, () => [0, 0, 0, 0, 0]) };
  const eid = entryId(entry);
  if (env.KEYS_FILE) appendFileSync(env.KEYS_FILE, `${JSON.stringify({ at: new Date().toISOString(), round: toHex(rid), entry: toHex(eid),
    secret: toHex(me.secret), stake: `${toHex(locks.stake.outpoint.txid)}:${locks.stake.outpoint.outIdx}`,
    fee: locks.fee ? `${toHex(locks.fee.outpoint.txid)}:${locks.fee.outpoint.outIdx}` : null })}\n`);
  const st = A.start(seed.seedWord, config, { runTicks: N, ...(unlocks.length ? { items: unlocks } : {}), ...(seed.slot === undefined ? {} : { slot: seed.slot }) });
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
    msgs.push([signedBatchOf(b, (id) => ed25519.sign(id, session)), `batch ${from}..${to - 1}`]);
    previousHash = batchId(b);
    if (to === FIRST || to === N) {
      const m = { roundId: rid, entryId: eid, tick: to, stateHash: fromHex(stateAt[to]), inputChainHash: previousHash, previousHash: previousMark, sessionPubkey: entry.sessionPubkey };
      msgs.push([sign(m), `mark ${to}`]);
      previousMark = checkpointId(m);
    }
    from = to;
  }
  // IDENTITY_SECRET_FILE=<64 hex> (kanban #1346): the round is booked to that identity, with its own consent (#1278, RULED #1276) - a name
  // record signed by the round key, and the identity key over (round, round key). POSTED TO EACH SEAT RIGHT AFTER IT TOOK THE ENTRY, as the
  // page names with the join (#1267: within the seat's 15 s grace from its join; measured 2026-11-10 run c46g: posted only after all seven
  // held the entry, 16-19 s after the first, two of three identities were refused "named with the join, not later" by every seat)
  let naming = null;
  if (env.IDENTITY_SECRET_FILE) {
    const idSecret = fromHex(readFileSync(env.IDENTITY_SECRET_FILE, 'utf8').trim());
    const identityKey = schnorr.getPublicKey(idSecret);
    const rec = { roundId: rid, playerPubkey: s.player, identityPubkey: identityKey, name: env.PLAYER_NAME || '', atMs: BigInt(Date.now()) };
    naming = { identityKey, said: [], body: JSON.stringify({ record: toHex(encodeLobbyName(rec)), sig: toHex(schnorr.sign(lobbyNameId(rec), me.secret)),
      identitySig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: s.player, identityKey }), idSecret)) }) };
  }
  const signerNodes = [];
  for (const n of nodes) {
    const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const enWhy = (await en.text()).trim().slice(0, 140);
    // TO EVERY SEAT AT ONCE, ONCE THE FIRST SEAT TOOK THE ENTRY (measured 2026-11-10 run c46h: named seat by seat, seats 4-7 answered 409 - they had the entry
    // from the first seats' hand-on ~15 s before this loop reached them, past the join grace); a seat still without the entry is asked again after its own
    if (naming) {
      const nameAt = (to) => fetch(`${to}/name`, { method: 'POST', body: naming.body, signal: AbortSignal.timeout(15000) })
        .then(async (r) => (r.status === 201 ? 201 : `${r.status} ${(await r.text()).trim().slice(0, 90)}`), (e) => e.message);
      if (!naming.said.length && en.status < 300) naming.said = await Promise.all(nodes.map(nameAt));
      const k = nodes.indexOf(n);
      if (k >= 0 && naming.said[k] !== 201 && en.status < 300) naming.said[k] = await nameAt(n);
    }
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
    // ITS FIRST MARK AT ONCE (measured 2026-10-14: published 30 s after the seats stored the entry, past their start
    // deadline - 900 ticks + 5 s from the stake seen - two seats signed FORFEIT at the door and the entry went VOID), as the page
    // sends it a second into the run; the rest after every seat holds the entry
    const early = [];
    if (!env.NO_MARKS && Date.now() >= Number(c.startTimeMs)) for (const [m, kind] of msgs.slice(0, 2)) { let got; try { got = await sayAt(n, m); } catch (e) { got = `error ${e.message}`; } early.push(`${kind}: ${saidOf(got)}`); }
    signerNodes.push({ node: n, handout: h.status, entry: en.status, ...(en.status >= 300 ? { entryWhy: enWhy } : {}),
      lock: l.status, lockSaid: (await l.text()).trim().slice(0, 160), ...(early.length ? { early } : {}) });
  }
  log({ step: 'handed over', entry: toHex(eid).slice(0, 16), signerNodes });
  // IDENTITY_SECRET_FILE=<64 hex> (kanban #1346): the round is booked to that identity, with its own consent (#1278, RULED #1276) - a name
  // record signed by the round key, and the identity key over (round, round key), posted to every seat once they hold the entry (a seat answers 409 for a round key it holds no entry of), within the join's grace (#1267)
  if (naming) log({ step: 'identity named', identity: toHex(naming.identityKey).slice(0, 16), said: naming.said });
  if (signerNodes.filter((x) => x.lock >= 200 && x.lock < 300).length < needed) throw new Error('fewer seats than needed took the lock');
  // NO_MARKS=1: IN THE ROUND AND NEVER PLAYED: not one mark is sent (tools/no-quorum-devnet.mjs)
  if (env.NO_MARKS && !env.REFUND_AT_EXPIRY) { log({ step: 'no marks sent' }); process.exit(0); }
  // REFUND_AT_EXPIRY=1 (with NO_MARKS, kanban #1044 B1 phase 4): an Arena lock nobody forfeits goes back to its player by the refund from its
  // expiration - the lock client's arenaRedeem { kind: 'refund' }. MINE_CMD "<bin> <args...>" mines blocks on a private chain meanwhile.
  async function refundAtExpiry() {
    const refunds = [];
    for (const [l, kind] of [[locks.stake, 'stake'], [locks.fee, 'fee']]) {
      if (!l || !isArenaLock(l.fields)) continue;
      for (const stop = Date.now() + Number(env.REFUND_MS || 40 * 60000); ;) {
        const st = JSON.parse(await lc.arenaLockStatus(toHex(l.outpoint.txid), Number(l.outpoint.outIdx)));
        if (Number(st.block_count) >= Number(l.fields.expiration)) break;
        if (Date.now() > stop) throw new Error(`the ${kind} lock did not expire: block count ${st.block_count}, expiration ${l.fields.expiration}`);
        log({ step: 'waiting for expiry', kind, blockCount: st.block_count, expiration: l.fields.expiration });
        if (env.MINE_CMD) { const [bin, ...args] = env.MINE_CMD.split(' '); await run(bin, args); }
        await new Promise((ok) => setTimeout(ok, 10000));
      }
      const said = JSON.parse(await lc.arenaRedeem(toHex(l.outpoint.txid), Number(l.outpoint.outIdx), JSON.stringify({ kind: 'refund' }), toHex(me.secret)));
      refunds.push({ kind, outpoint: `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`, accepted: said.accepted === true, txid: said.txid, error: said.error || undefined,
        blockCount: said.block_count, expiration: said.expiration });
    }
    log({ step: 'refunded', refunds, balanceMsat: await lc.balanceMsat() });
    process.exit(refunds.length && refunds.every((x) => x.accepted) ? 0 : 1);
  }
  if (env.REFUND_AT_EXPIRY) { log({ step: 'no marks sent' }); await refundAtExpiry(); }


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
  // REFUND_AFTER_PLAY=1 (regtest, kanban #1044 hole 1, three settlement seats silent): a loser who played takes its stake and fee lock back by the
  // refund from their expiration, once REFUND_GO_FILE exists (the harness writes it when the stall has been watched), never asking for a forfeit
  if (env.REFUND_AFTER_PLAY) {
    for (const stop = Date.now() + Number(env.REFUND_GO_MS || 3 * 3600000); !(env.REFUND_GO_FILE && existsSync(env.REFUND_GO_FILE)); ) {
      if (Date.now() > stop) throw new Error('REFUND_GO_FILE never came');
      await new Promise((ok) => setTimeout(ok, 5000));
    }
    log({ step: 'refund go' });
    await refundAtExpiry();
  }
  // PAYOUT_ADDRESS (regtest, kanban #1044 B1 phase 4, ruling #1134 2): the winner names a Lightning address (an LNURL) at every seat, signed with the
  // session key, as the page does: its winnings are then sent through a gateway, refunding to KeyAgg(S), with the presigned refund (c) to its own key
  if (env.PAYOUT_ADDRESS) {
    const signed = new TextEncoder().encode(env.PAYOUT_ADDRESS);
    const body = Buffer.concat([Buffer.from(signed), Buffer.from(ed25519.sign(signed, session))]);
    const named = [];
    for (const n of nodes) { try { const r = await fetch(`${n}/payout-address?entry=${toHex(eid)}`, { method: 'POST', body }); named.push(r.status); } catch (e) { named.push(e.message.slice(0, 40)); } }
    log({ step: 'payout address', address: env.PAYOUT_ADDRESS.slice(0, 24), named });
  }

  // EARLY_FORFEIT=1 (regtest, kanban #1044 B1 phase 4, offence (b)): the stake lock's forfeit asked for at once and redeemed as soon as a quorum signs it -
  // before the settlement claims the lock. Honest seats sign none for an entry they hold lost; seats armed with `forfeit-lost <entry>` do
  // (ARENA_TEST_NAMED_OFFENCE_FILE). Asked until a seat holds the accepted settlement, at most COLLECT_MS; then the run goes on as before
  if (env.EARLY_FORFEIT && locks.stake && isArenaLock(locks.stake.fields)) {
    for (const stop = Date.now() + Number(env.COLLECT_MS || 15 * 60000); Date.now() < stop;) {
      const f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes, lock: 'stake', named: true });
      if (f.ok) {
        const l = locks.stake;
        const said = JSON.parse(await lc.arenaRedeem(toHex(l.outpoint.txid), Number(l.outpoint.outIdx), JSON.stringify({ kind: 'cancel', signers: f.signers, signature: f.signature }), toHex(me.secret)));
        log({ step: 'early forfeit', outpoint: `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`, signers: f.signers, from: f.from, accepted: said.accepted === true, txid: said.txid,
          error: said.error || undefined, balanceMsat: await lc.balanceMsat() });
        process.exit(said.accepted === true ? 0 : 1);
      }
      const stl0 = await settlementOf({ roundId: rid, nodes });
      if (stl0.ok) { log({ step: 'no early forfeit: the settlement came first', txid: stl0.txid.slice(0, 16), why: f.why.slice(0, 160) }); break; }
      await new Promise((ok) => setTimeout(ok, 10000));
    }
  }

  // THE CLOSE AND THE SETTLEMENT, as the page watches them
  const endMs = Number(c.startTimeMs) + Number(c.runMs || 0n);
  const until = Date.now() + 15 * 60000;
  let settled = null;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 15000));
    try { settled = await settlementBy({ entryId: eid, signerNodes: c.nodes, nodes }); } catch (e) { settled = { error: e.message }; }
    log({ step: 'settlement', at: Math.round((Date.now() - endMs) / 1000), said: settled });
    if ((settled && (settled.decided || settled.state === 'ACCEPTED' || settled.settled || settled.finality === 'FINAL')) || Date.now() > until) break;
  }
  const results = [];
  for (const n of nodes) {
    try { const x = await fetch(`${n}/results?round=${env.ROUND}`); results.push({ node: n, status: x.status, body: (await x.text()).slice(0, 300) }); }
    catch (e) { results.push({ node: n, error: e.message }); }
  }
  log({ step: 'results', entry: toHex(eid), results });

  // THE PLAYER COLLECTS, as the page's redeemPayout and redeemStake do (the owner HARD for 2026.1.9.11: "Auszahlung muss
  // funktionieren"): a payout contract to this player's refund key, by refund under that key, then its stake and fee lock by
  // the seats' forfeit. Asked until a seat holds the accepted settlement, at most COLLECT_MS (15 min).
  let stl = null;
  for (const stop = Date.now() + Number(env.COLLECT_MS || 15 * 60000); ;) {
    stl = await settlementOf({ roundId: rid, nodes });
    if (stl.ok || Date.now() > stop) break;
    log({ step: 'settlement not accepted yet', why: stl.why.slice(0, 200) });
    await new Promise((ok) => setTimeout(ok, 30000));
  }
  if (!stl.ok) throw new Error(`no accepted settlement to collect from: ${stl.why}`);
  log({ step: 'settled', txid: stl.txid.slice(0, 16), from: stl.from, payouts: stl.moved.payouts.length });
  const before = await lc.balanceMsat();
  const mine = toHex(refundKeyOf(s.player));
  const at = stl.moved.payouts.findIndex((x) => x.kind === 'qualifier' && String(x.pk).toLowerCase() === mine);
  let payout = null;
  if (at >= 0) {
    const x = stl.moved.payouts[at];
    const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(x.msat), claimPk: mine, refundPk: mine, expiration: 0 };
    const said = JSON.parse(await lc.refund(stl.txid, at, JSON.stringify(fields), toHex(me.secret)));
    payout = { msat: String(x.msat), outIdx: at, accepted: said.accepted === true, ...(said.accepted === true ? {} : { said: JSON.stringify(said).slice(0, 200) }) };
  }
  const stakes = [];
  for (const [l, kind] of [[locks.stake, 'stake'], [locks.fee, 'fee']]) {
    if (!l) continue;
    // AN ARENA LOCK (protocol 27, kanban #1044 B1): its forfeit names its signers, and the 2.0 lock client spends it by arenaRedeem
    const named = isArenaLock(l.fields);
    let f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes, lock: kind, named });
    // FORFEIT_RETRY_S (regtest, kanban #1044): asked again every 20 s, as a page left open asks - a seat whose settlement is not ACCEPTED yet refuses the
    // nobody-won return now and signs it a minute later (measured 2026-11-05 on s27g, round b4900236: asked once while seat 1 was still SUBMITTING)
    for (const stop = Date.now() + Number(env.FORFEIT_RETRY_S || 0) * 1000; !f.ok && kind === 'stake' && Date.now() < stop;) {
      await new Promise((ok) => setTimeout(ok, 20000));
      f = await forfeitOf({ roundId: rid, entryId: toHex(eid), nodes, lock: kind, named });
    }
    if (!f.ok) { stakes.push({ kind, forfeit: f.why.slice(0, 300) }); continue; }
    const said = named
      ? JSON.parse(await lc.arenaRedeem(toHex(l.outpoint.txid), Number(l.outpoint.outIdx), JSON.stringify({ kind: 'cancel', signers: f.signers, signature: f.signature }), toHex(me.secret)))
      : JSON.parse(await lc.redeem(toHex(l.outpoint.txid), Number(l.outpoint.outIdx), JSON.stringify(lockFieldsToJson(l.fields)), f.signature, toHex(me.secret)));
    stakes.push({ kind, accepted: said.accepted === true, ...(named ? { signers: f.signers, from: f.from, txid: said.txid } : {}),
      ...(said.accepted === true ? {} : { said: JSON.stringify(said).slice(0, 200) }) });
  }
  // REFUND_C=1 (regtest, ruling #1134 2): a failed send's winnings, once anyone submitted its presigned refund (c), are the pre-expired payout contract at
  // ((c)'s txid, 0) to this player's own key - taken into the wallet by refund, as any payout. Asked until it is there, at most COLLECT_MS
  let refundC = null;
  if (env.REFUND_C) {
    for (const stop = Date.now() + Number(env.COLLECT_MS || 15 * 60000); Date.now() < stop && !(refundC && refundC.accepted);) {
      let c = null;
      for (const n of nodes) {
        try { const j = await (await fetch(`${n}/send-refunds?round=${env.ROUND}`)).json(); c = (j.refunds || []).find((x) => String(x.qualifierPk).toLowerCase() === mine) || null; } catch { c = null; }
        if (c) break;
      }
      if (c && c.payoutMsat) {
        const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(c.payoutMsat), claimPk: mine, refundPk: mine, expiration: 0 };
        const said = JSON.parse(await lc.refund(c.txid, 0, JSON.stringify(fields), toHex(me.secret)));
        refundC = { txid: c.txid, payoutMsat: c.payoutMsat, accepted: said.accepted === true, ...(said.accepted === true ? {} : { said: JSON.stringify(said).slice(0, 160) }) };
        if (refundC.accepted) break;
      }
      log({ step: 'refund (c) not in the wallet yet', refundC });
      await new Promise((ok) => setTimeout(ok, 20000));
    }
  }
  log({ step: 'collected', payout, stakes, ...(env.REFUND_C ? { refundC } : {}), balanceBeforeMsat: before, balanceAfterMsat: await lc.balanceMsat() });
  // WITHDRAW=1 (kanban #808): the money out over Lightning, to an invoice of the payer lnd, as the page's withdraw does
  if (env.WITHDRAW && ((payout && payout.accepted) || stakes.some((x) => x.accepted))) {
    const can = BigInt(await lc.withdrawableMsat()); const sat = can / 1000n - 10n;
    const inv = JSON.parse((await payer('addinvoice', '--amt', String(sat), '--memo', 'kanban 808 payout')).out);
    const said = JSON.parse(await lc.withdraw(inv.payment_request, env.GATEWAY || undefined));
    const held = JSON.parse((await payer('lookupinvoice', inv.r_hash)).out);
    log({ step: 'lightning payout', sat: String(sat), paymentHash: inv.r_hash, state: said.state, settled: held.state, amtPaidSat: held.amt_paid_sat, balanceBeforeMsat: said.balance_before, balanceAfterMsat: said.balance_after });
  }

  // THE REFERRER COLLECTS ITS SHARE (#681): every payout the seats list under its key (GET /donations?key=), spent by refund
  if (REFERRER_SECRET && env.REFERRER_COLLECT) {
    const found = new Map();
    for (const n of nodes) {
      try { const r = await fetch(`${n}/donations?key=${REFERRAL_PK}&since=0`); if (r.ok) for (const d of ((await r.json()).donations || [])) if (d && d.outpoint) found.set(d.outpoint, d); } catch { /* another seat */ }
    }
    const mine = [...found.values()].filter((d) => d.roundId === toHex(rid) || String(d.roundId || '').startsWith(toHex(rid).slice(0, 16)));
    const refBefore = await lc.balanceMsat();
    const got = [];
    for (const d of mine) {
      const [txid, vout] = String(d.outpoint).split(':');
      const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(d.amountMsat), claimPk: REFERRAL_PK, refundPk: REFERRAL_PK, expiration: 0 };
      const said = JSON.parse(await lc.refund(txid, Number(vout), JSON.stringify(fields), toHex(REFERRER_SECRET)));
      got.push({ outpoint: d.outpoint, item: d.item, msat: String(d.amountMsat), accepted: said.accepted === true, ...(said.accepted === true ? {} : { said: JSON.stringify(said).slice(0, 160) }) });
    }
    log({ step: 'referral collected', key: REFERRAL_PK.slice(0, 16), listed: found.size, thisRound: mine.length, got, balanceBeforeMsat: refBefore, balanceAfterMsat: await lc.balanceMsat() });
  }
} catch (e) {
  code = 1;
  log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) });
}
process.exit(code);
