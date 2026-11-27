#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * A TEST OPPONENT FOR ROCK PAPER SCISSORS (kanban #926): measured 2026-11-01, a stranger alone at a table paid and saw no result. This is one more player: it asks the page's
 * want list which table has somebody at it, says it is there, and once a player has paid into that round it enters as any player does - the same stake, fee, lock, entry and reveal, under the round's own rules. Its move is
 * drawn evenly. It decides nothing, and its name says what it is ("Test bot").
 *
 *   NODES=<seat url,...> WANTS=<faucet url>/opponent INVITES=<invite file,...> WASM_PKG=<dir> DIR=<its wallets and keys> node tools/rps-opponent.mjs
 *   [MOST_PER_HOUR=120] [MIN_LEFT_MS=4050] [ONCE=1]
 *   FUND=<sat> instead: prints one invoice per federation (the wallets' top-up, paid from outside), waits for them, and exits.
 *
 * WALLETS: DIR/wallet-<federation>.json, kept across runs. DIR/keys.jsonl: each entry's player key and locks, as tn4-rps-paid's KEYS_FILE, for tn4-collect.mjs.
 */
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { routeGuardianSockets } from './guardian-ws-local.mjs';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey } from '../../arena-client/src/join.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { hiddenMove, moveCommitment } from '../../arena-client/src/head-to-head.js';
import { revealAsPage } from './h2h-reveal.mjs';
import { gatewaysOf, topUp } from './bot-topup.mjs';   // kanban #3893: the next working gateway   // kanban #2658: from protocol 28 the reveal waits for the certified lock set
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { markBot, entryKeys } from './mark-bot.mjs';   // kanban #2035: every live entry marked bot in the explorer
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { entrySplit, lockEntry } from './entry-locks.mjs';
import { handoutThenLock, h2hLeadMs } from './h2h-order.mjs';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { matchProofId, presenceId } from '../../arena-protocol/src/match.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';
import { botMayEnter, BOT_LEAD_MS, tapKeysOf, tapKeyToLearn } from '../src/opponent-trigger.js';   // kanban #2842: it stakes only on a verified stake lock

const env = process.env;
const nodes = String(env.NODES || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const DIR = env.DIR, NAME = 'Test bot';
// MIN_LEFT_MS (kanban #2043): the seats take a head-to-head handout only with more than ceil(h2hHandoutLeadMs * 1.5) left (node-start.js 2700 ms, so 4.05 s),
// so an entry started with less could never be taken - it is not started
const MOST_PER_HOUR = Number(env.MOST_PER_HOUR || 400), MIN_LEFT_MS = Number(env.MIN_LEFT_MS || 4050);
// THE BOT'S LEAD FROM ITS TYPICAL LOCK, NOT ITS SLOWEST (kanban #2901, measured 2026-11-16 14:09-14:17Z: one 18.6 s lock while a seat restarted
// made the max-based lead 19.4 s and the bot skipped the next rounds of known players with 9.7-15 s left): the median of its last locks + 1.5 s,
// at least 4 s and at most 10 s
const botLeadMs = (seen = []) => { const v = [...seen].sort((x, y) => x - y); const m = v.length ? v[Math.floor(v.length / 2)] : 0; return Math.max(4000, Math.min(10000, m + 1500)); };
const lockMsSeen = [];   // the bot's last locks' times (kanban #2043): its lead before a lock is the page's rule over them (h2h-order.mjs h2hLeadMs)
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return { secret: k, pubkey: schnorr.getPublicKey(k) }; };
mkdirSync(DIR, { recursive: true });

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
routeGuardianSockets();
const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasm = await import(esm);
await wasm.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const { LockClient } = wasm;

// ONE WALLET PER FEDERATION, its secret and notes on disk: a restart keeps the money
const wallets = new Map();
const ROTATE_ENTRIES = Number(env.ROTATE_ENTRIES || 8000);   // kanban #2910
for (const file of String(env.INVITES || '').split(',').filter(Boolean)) {
  const invite = readFileSync(file, 'utf8').replace(/["\s]/g, '');
  const fed = String(LockClient.federationIdOf(invite)).toLowerCase();
  const path = join(DIR, `wallet-${fed.slice(0, 16)}.json`);
  const kept = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { secret: toHex(rand(32)), notes: [] };
  const held = new Map(kept.notes);
  // kanban #2910: the store was written whole and synchronously on every put/remove - 42,418 entries, 46 MB, the bot blocked ~8 s per lock
  // (handout posted 9 s late). Written in the background at most once a second; the first write (below) stays synchronous.
  let flushTimer = null;
  const flushNow = () => writeFileSync(path, JSON.stringify({ secret: kept.secret, notes: [...held] }), { mode: 0o600 });
  const flush = () => { if (flushTimer) return; flushTimer = setTimeout(() => { flushTimer = null; try { flushNow(); } catch {} }, 1000); };
  const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); flush(); }, remove: (k) => { held.delete(k); flush(); } };
  const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), kept.secret, store);
  flushNow();
  wallets.set(fed, { lc, rule: JSON.parse(await lc.feeRule()) });
  // A WALLET THAT GROWS TOO BIG IS ROTATED (kanban #2910, the owner 2026-11-16 "die Wallet-Migration regelmaessig, so dass es nicht mehr auftritt"): its
  // store grew to 42,418 entries (46 MB) and slowed every lock to ~10 s. Past ROTATE_ENTRIES the file is renamed (never deleted) and the bot exits:
  // its loop starts it again on a fresh wallet, which tops itself up from the faucet; what was left in the old one stays in the renamed file.
  setInterval(() => {
    if (held.size <= ROTATE_ENTRIES || busy) return;
    try { flushNow(); renameSync(path, path + '.rotated-' + new Date().toISOString().replace(/[:.]/g, '')); } catch (e) { log({ step: 'rotate failed', why: e.message }); return; }
    log({ step: 'wallet rotated', federation: fed.slice(0, 8), entries: held.size }); setTimeout(() => process.exit(0), 500);
  }, 600000).unref();
  log({ step: 'wallet', federation: fed.slice(0, 8), balanceMsat: String(await lc.balanceMsat()) });
}

if (env.FUND) {
  await Promise.all([...wallets].map(async ([fed, w]) => {
    const rcv = JSON.parse(await w.lc.receive(String(BigInt(env.FUND) * 1000n), env.GATEWAY || ''));
    log({ step: 'pay this', federation: fed.slice(0, 8), invoice: rcv.invoice });
    const final = await w.lc.awaitReceive(rcv.operation);
    log({ step: 'funded', federation: fed.slice(0, 8), final, balanceMsat: String(await w.lc.balanceMsat()) });
  }));
  process.exit(0);
}

// ITS IDENTITY, kept: one name and one score across rounds
const idPath = join(DIR, 'identity.json');
const identity = existsSync(idPath) ? fromHex(JSON.parse(readFileSync(idPath, 'utf8')).secret) : (() => { const k = evenPlayer().secret; writeFileSync(idPath, JSON.stringify({ secret: toHex(k) }), { mode: 0o600 }); return k; })();
const identityKey = schnorr.getPublicKey(identity);

const ms = (t) => Date.now() - t;
// THE ENTRY'S SPLIT, KEPT (measured: 11.5 s, GET /reserves at 14 seats under load, in an 8 s round): it changes with the federation's reserve key, the stake and the sets the
// contract names, and those are the same for a day's rounds. Asked again after SPLIT_KEEP_MS, behind the entries.
const SPLIT_KEEP_MS = 6 * 3600000;
const splits = new Map();
const splitFile = join(DIR, 'splits.json');
const big = (_, v) => (typeof v === 'bigint' ? { $n: String(v) } : v instanceof Uint8Array ? { $b: toHex(v) } : v);
const un = (_, v) => (v && typeof v === 'object' && v.$n !== undefined ? BigInt(v.$n) : v && typeof v === 'object' && v.$b !== undefined ? fromHex(v.$b) : v);
try { for (const [k, x] of JSON.parse(readFileSync(splitFile, 'utf8'), un)) splits.set(k, x); } catch { /* none kept yet */ }
// the protocol version is part of the key (kanban #2658): a protocol-27 round's entry carries no donation, a cached split of an older round's did
const splitKey = (c) => [toHex(c.federationId), c.stakeMsat, toHex(c.donationSetId), toHex(c.gameId), Number(c.protocolVersion)].join(':');
// A SEAT THAT ANSWERS FIRST: the donation sets of a round come from whichever of a few seats holds them soonest
const firstSeat = async (u, o) => { const path = String(u).replace(/^https?:\/\/[^/]+/, ''); return Promise.any(nodes.slice(0, 5).map(async (n) => { const r = await fetch(`${n}${path}`, { ...o, signal: AbortSignal.timeout(3000) }); if (!r.ok) throw new Error(String(r.status)); return r; })); };
const keys = new Map();   // federation hex -> its reserve key, read once
const POST_MS = 6000;
const claimKeyOf = (c, rid) => attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve, timeoutMs: 6000 });
const readSplit = async (c, roundHex) => { const fed = toHex(c.federationId); const v = await entrySplit({ c, roundHex, nodes, fetcher: keys.has(fed) ? firstSeat : fetch, reserveKeyHex: keys.get(fed) || null }); if (v.reserveKey) keys.set(fed, toHex(v.reserveKey)); splits.set(splitKey(c), { v, at: Date.now() }); try { writeFileSync(splitFile, JSON.stringify([...splits], big)); } catch { /* kept in memory */ } return v; };
const splitFor = async (c, roundHex) => {
  for (const [key, x] of splits) if (x.v && x.v.reserveKey && !keys.has(key.split(':')[0])) keys.set(key.split(':')[0], toHex(x.v.reserveKey));
  const k = splits.get(splitKey(c));
  if (!k) return readSplit(c, roundHex);
  if (Date.now() - k.at > SPLIT_KEEP_MS) readSplit(c, roundHex).catch(() => {});
  return k.v;
};
async function enter(c, rid, ready) {
  const roundHex = toHex(rid), t0 = Date.now(), steps = {};
  const w = wallets.get(toHex(c.federationId));
  if (!w) return { ok: false, why: `no wallet in federation ${toHex(c.federationId).slice(0, 8)}` };
  log({ step: 'entering', round: roundHex.slice(0, 8), leftMs: Number(c.entryCloseMs) - Date.now() });
  const att = await (ready || claimKeyOf(c, rid));
    if (!att.ok) return { ok: false, why: `claim key: ${att.why}` };
  steps.claimKey = ms(t0);
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(w.rule.fee_ppm), baseMsat: BigInt(w.rule.fee_base_msat) } });
  const split = await splitFor(c, roundHex);
  steps.split = ms(t0);
  // NOT UNDER THE SEATS' KEPT LEAD (kanban #2043): a handout posted with less than ceil(h2hHandoutLeadMs * 1.5) left is refused by every seat
  if (Number(c.entryCloseMs) - Date.now() < 4050) return { ok: false, why: 'too late to enter' };
  const me = evenPlayer();
  botKeys.add(toHex(me.pubkey));   // kanban #2842: its own entries never count as a player
  const s = { p: scalar(), player: me.pubkey };
  s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
  const needed = receiptsNeeded(c.settlementSlots ?? c.gameVerifySlots);
  const e = rand(32);
  const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  // THE HANDOUT FIRST, THE LOCK AFTER, AS THE PAGE (kanban #2043, #1489 refute 3 of #1485/#1742/#1892, feedback #010): POST /handout to every seat, and the stake and
  // fee lock only once `needed` seats took it and the time left on the seats' clock (their 201s' x-entry-close-in-ms) still covers the lock and the entry
  // (h2hLockRefusal, the page's lead). Before, the bot locked first: with 0.9-4.05 s left it spent the developers' and reserves' parts, then every seat refused
  // the handout 409 and the entry with it. A refused or late handout now leaves nothing locked.
  // THE LOCK IN PARALLEL WITH THE HANDOUT (kanban #2910, the owner 2026-11-16 "mach den Lock des Bots viel schneller"; measured 19:03Z: handout 3.7 s, then the
  // lock submitted and accepted 6 s later - 9.8 s in all, the page's lock overlaps its handout): the lock is submitted at once and the handout posted beside
  // it. A refused handout leaves a lock no certified set names: the round voids and its locks come back at once (#2872); the donation parts of a test bot's
  // 100 sat stake are the price.
  const tLock = Date.now();
  const pre = lockEntry({ lc: w.lc, c, split, stakePoint: s.point, player: s.player, claimPk: att.claimPk, gate, rand, expiry: Number(c.stakeExpiryBlocks), submitOnly: true })
    .then((l) => { const sub = Date.now() - tLock; lockMsSeen.push(sub); if (lockMsSeen.length > 8) lockMsSeen.shift(); log({ step: "lock submitted", round: roundHex.slice(0, 8), submitMs: sub }); if (l && l.accepted) l.accepted.then(() => log({ step: "lock accepted", round: roundHex.slice(0, 8), acceptedMs: Date.now() - tLock }), () => {}); return l; });
  pre.catch(() => {});
  const order = await handoutThenLock({ body: encodeHandout(dealt.handout), needed, nodes, entryCloseMs: c.entryCloseMs, leadMs: botLeadMs(lockMsSeen), waitMs: POST_MS,
    lock: () => pre });
  steps.handout = ms(t0);
  if (!order.ok) return { ok: false, why: order.why };
  const locks = order.locks;
  const accepted = (locks.accepted || Promise.resolve()).then(() => { steps.accepted = ms(t0); });
  steps.locked = ms(t0);
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(s.p), stakeMsat: BigInt(c.stakeMsat), feeMsat: split.feeMsat,
    donationMsat: split.donationMsat, joinTick: 0, worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? new Uint8Array(32) : rand(32), vssSharesRef: handoutId(dealt.handout),
    stakePoint: dealt.handout.commitments[0], ...locks.entryFields, claimKeyAttestationRef: att.ref };
  const hidden = hiddenMove(randomInt(3), rand);      // evenly: rock, paper, scissors
  entry.commit = moveCommitment({ roundId: rid, sessionPubkey: entry.sessionPubkey, move: hidden.move, salt: hidden.salt });
  const eid = entryId(entry);
  // MARKED BOT IN THE EXPLORER AS IT GOES OUT (kanban #2035): by the admin code, so the real-player count stays true
  markBot(entryKeys(eid, entry)).then((m) => { if (!m.ok) log({ step: 'not marked bot', entry: toHex(eid).slice(0, 8), why: m.why }); });
  appendFileSync(join(DIR, 'keys.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), round: roundHex, entry: toHex(eid), player: 'bot', secret: toHex(me.secret),
    stake: `${toHex(locks.stake.outpoint.txid)}:${locks.stake.outpoint.outIdx}`, fee: locks.fee ? `${toHex(locks.fee.outpoint.txid)}:${locks.fee.outpoint.outIdx}` : null })}\n`);
  const hand = locks.fee ? locks.fee.fields : null;
  // ENOUGH SEATS, NOT ALL OF THEM: a seat that is restarting never answered and held the bot for minutes (measured 2026-11-01). The rest go on behind.
  // Each seat's entry after its own handout post (a seat still answering its handout gets the entry once it did)
  const posts = nodes.map(async (n) => {
    await order.put.posted.get(n);
    const en = await fetch(`${n}/entry`, { method: 'POST', signal: AbortSignal.timeout(POST_MS), body: encodeEntryContract(entry) }).catch(() => ({ status: 0, text: async () => 'no answer' }));
    // THE PLAYER'S LOCK CLAIM (kanban #2069, #2088): a signature by the stake point over the entry id, as the page sends it - a seat then hands
    // these locks only to a claimed entry, never to a copy under another stake point. Never fatal.
    if (en.status >= 200 && en.status < 300) { try { await fetch(`${n}/lock-claim?entry=${toHex(eid)}`, { method: 'POST', signal: AbortSignal.timeout(POST_MS), body: schnorr.sign(lockClaimDigest(eid), s.p) }).then((r) => r.text()); } catch { /* the seats show it to each other */ } }
    return { node: n, entry: en.status, why: en.text ? (await en.text().catch(() => '')).trim().slice(0, 120) : '' };
  });
  const said = [];
  const tookOf = () => said.filter((x) => x.entry >= 200 && x.entry < 300).length;
  await new Promise((done) => { for (const p of posts) p.then((x) => { said.push(x); if (tookOf() >= needed || said.length === nodes.length) done(); }); });
  steps.entry = ms(t0);
  // AND ITS LOCKS, once the federation holds them
  const handed = accepted.then(() => Promise.all(nodes.map(async (n, i) => {
    // ONLY THE SEATS THAT TOOK THE ENTRY, NOT THE OTHERS FOR 45 S (kanban #947, measured 2026-11-01: 14 seats, two asks each, every 0.7 s, after every round)
    const inn = await posts[i];
    if (!(inn.entry >= 200 && inn.entry < 300)) return 0;
    let l, fee = !hand;
    // BOTH LOCKS AT EVERY SEAT THAT TAKES THEM (kanban #926, measured 2026-11-01 13:20Z): a fee lock that reached a seat before the entry had a 404, was not sent again, and that seat
    // built another settlement than the rest, so the round did not settle
    for (const until = Date.now() + 30000; ;) {
      if (hand && !fee) { const f = await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', signal: AbortSignal.timeout(POST_MS), body: JSON.stringify(lockFieldsToJson(hand)) }).catch(() => null); fee = !!f && f.status >= 200 && f.status < 300; }
      l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', signal: AbortSignal.timeout(POST_MS), body: JSON.stringify(lockFieldsToJson(locks.stake.fields)) }).catch(() => ({ status: 0, clone: () => ({ text: async () => '' }) }));
      const stakeIn = l.status >= 200 && l.status < 300;
      if ((stakeIn && fee) || Date.now() >= until) break;
      if (l.status === 409 && !/holds no lock/.test(await l.clone().text())) break;
      if (!stakeIn && l.status !== 409 && l.status !== 404 && l.status !== 0) break;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    return l.status;
  })));
  handed.then((st) => log({ step: 'locks handed', round: roundHex.slice(0, 8), took: st.filter((x) => x >= 200 && x < 300).length, of: st.length, ms: { accepted: steps.accepted, all: ms(t0) } }), (e) => log({ step: 'locks not accepted', round: roundHex.slice(0, 8), why: String(e.message || e).slice(0, 200) }));
  const took = tookOf();
  // ITS NAME, signed with the round key as a page's is
  const rec = { roundId: rid, playerPubkey: s.player, identityPubkey: identityKey, name: NAME, atMs: BigInt(Date.now()) };
  // AND ITS IDENTITY'S CONSENT, as the page sends it (kanban #1278; audit 5 #1401: a seat keeps a reveal's identity only when the join's record consented to it)
  const nameBody = JSON.stringify({ record: toHex(encodeLobbyName(rec)), sig: toHex(schnorr.sign(lobbyNameId(rec), me.secret)),
    identitySig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: s.player, identityKey }), identity)) });
  for (const n of nodes) fetch(`${n}/name`, { method: 'POST', signal: AbortSignal.timeout(POST_MS), body: nameBody }).catch(() => null);
  log({ step: 'entered', round: roundHex.slice(0, 8), entry: toHex(eid).slice(0, 8), took, of: said.length, needed, ms: steps, leftAtEndMs: Number(c.entryCloseMs) - Date.now(),
    ...(took < needed ? { refused: [...new Set(said.map((x) => x.why).filter(Boolean))].slice(0, 2) } : {}) });
  // THE REVEAL AFTER THE ENTRY CLOSE, as a page's - from protocol 28 once the lock set is certified (kanban #2658: one revealMove at close + 150 ms
  // was refused 409 by every seat, the bot FORFEITED and the player at its table won every paid round)
  const proof = { key: toHex(identityKey), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey }), identity)) };
  setTimeout(async () => {
    const said = await revealAsPage({ c, roundIdHex: roundHex, entryIdHex: toHex(eid), move: hidden.move, salt: hidden.salt, nodes, identity: proof }).catch((x) => ({ seats: [{ status: 0, why: x.message }] }));
    const r = said.seats || [];
    log({ step: 'revealed', round: roundHex.slice(0, 8), move: hidden.move, ok: r.filter((x) => x.status === 200 || x.status === 201).length, of: r.length, ...(said.why ? { why: said.why } : {}) });
  }, Math.max(0, Number(c.entryCloseMs) - Date.now() + 150));
  return { ok: took >= needed };
}

// A TABLE IS WATCHED WHILE THE PAGE SAYS SOMEBODY IS AT IT: the bot says it is there (free) and reads the claim key ahead, and enters when the player taps. Measured 2026-11-01: entering
// every 8 s round while somebody looked would lock 100 sat a round for a day, and an entry lands about 4 s after its tap, so one that waited to see the player's entry had no time left.
const seen = new Map();      // round hex -> { c, rid, told, entered }
// KNOWN PLAYERS (kanban #2901): keys whose stake lock a seat verified in an earlier round
const KNOWN_FILE = env.KNOWN_FILE || join(process.env.HOME || '.', 'm808/bot926/opp/known-players.json');
const KNOWN = new Set((() => { try { return JSON.parse(readFileSync(KNOWN_FILE, 'utf8')); } catch { return []; } })());
const knownAdd = (key) => { if (!/^[0-9a-f]{64}$/.test(key) || KNOWN.has(key)) return; KNOWN.add(key); try { writeFileSync(KNOWN_FILE, JSON.stringify([...KNOWN])); } catch {} log({ step: 'known player', key: key.slice(0, 8), known: KNOWN.size }); };
const botKeys = new Set();    // the player keys this bot entered with (kanban #2842): never a reason to enter
const hour = [];
let busy = false;
const contractOf = async (round) => {
  let k = seen.get(round);
  if (!k) {
    // THE FIRST BYTES A MAJORITY OF THE ASKED SEATS ANSWER (kanban #3370, audit h2h a6-3-1, bypass of #3041): whichever seat answered first was
    // kept, and a series round's id hashes only its series id and index - so one of the five seats answering first with its own stake and lock
    // expiry under the same id set what the bot locked for every round (money no seat holds an entry for, parked to the expiry it chose). The
    // contract is now the first byte-identical answer of more than half of the seats asked; still no wait for the slowest (measured under a
    // loaded test host: one seat took over 3 s, another 6 s, and an 8 s round was gone)
    const asked = nodes.slice(0, 5), need = Math.floor(asked.length / 2) + 1;
    const bytes = await new Promise((done, fail) => {
      const said = new Map(); let left = asked.length;
      if (!left) { fail(new Error('no seat to ask')); return; }
      for (const n of asked) {
        (async () => { const r = await fetch(`${n}/round?id=${round}`, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(String(r.status)); return new Uint8Array(await r.arrayBuffer()); })()
          .then((b) => { const h = Buffer.from(b).toString('hex'); const c = (said.get(h) || 0) + 1; said.set(h, c); if (c >= need) done(b); }, () => {})
          .finally(() => { if (--left === 0) fail(new Error(`no ${need} of ${asked.length} seats answered one contract for round ${round}`)); });
      }
    });
    const c = decodeRoundContract(bytes);
    k = { c, rid: roundId(c), told: false, entered: false }; seen.set(round, k);
  }
  return k;
};
const sayHere = (round, k, again = false) => {
  if (k.told && !again) return;
  k.told = true;
  k.claim = k.claim || claimKeyOf(k.c, k.rid).catch((e) => ({ ok: false, why: e.message }));
  const body = k.hereBody = k.hereBody || JSON.stringify({ key: toHex(identityKey), sig: toHex(schnorr.sign(presenceId({ roundId: k.rid, identityKey }), identity)) });
  for (const n of nodes) fetch(`${n}/here?round=${round}`, { method: 'POST', body, signal: AbortSignal.timeout(3000) }).catch(() => {});
};
const go = (w, k, step) => {
  const now = Date.now();
  while (hour.length && now - hour[0] > 3600000) hour.shift();
  if (hour.length >= MOST_PER_HOUR) { log({ step: 'hourly limit' }); return; }
  k.entered = true; hour.push(now); busy = true;
  sayHere(w.round, k);   // kanban #2901: said only now, as it enters
  log({ step, round: w.round.slice(0, 8), leftMs: Number(k.c.entryCloseMs) - now });
  enter(k.c, k.rid, k.claim).then((r) => { if (!r.ok) log({ step: 'entry not made', round: w.round.slice(0, 8), why: String(r.why || 'too few seats took it').slice(0, 200) }); }, (e) => log({ step: 'entry failed', round: w.round.slice(0, 8), why: String(e.message).slice(0, 200) })).finally(() => { busy = false; if (env.ONCE) setTimeout(() => process.exit(0), 40000); });
};
// AT THE TABLE BEFORE THE ROUND BEGINS (kanban #947, 2026-11-01: "Es dauert erstmal 1-2 runden bis der Bot überhaupt kommt"): while a table is in use the next rounds of its kind are
// said at once, so nobody waits for a want to come round first
const tables = new Map();     // fed:game:stake -> until
const tableOf = (c) => `${toHex(c.federationId)}:${toHex(c.gameId)}:${c.stakeMsat}`;
const sayAtTables = () => {
  const now = Date.now();
  for (const [round, k] of seen) {
    const until = tables.get(tableOf(k.c));
    // AGAIN EVERY 2 S, AS A PAGE DOES: a seat forgets who is at a table in seconds, and a word said before the round began was gone by its first seconds ("You are alone" from 0:10 to 0:07)
    // only a table the bot entered (kanban #2901, the owner's playtest 12:5xZ: "Test bot" stood at his table, its hand '?', and it never staked)
    if (k.entered && until && until > now && Number(k.c.entryCloseMs) > now && Number(k.c.entryCloseMs) - now < 20000) sayHere(round, k, true);
  }
};
setInterval(sayAtTables, 2000);
const pass = async () => {
  const wants = (await (await fetch(env.WANTS, { signal: AbortSignal.timeout(3000) })).json()).wants || [];
  // FOUR REAL TABLES, NOT THE FIRST FOUR ROWS (kanban #1718, #1781): the list is anyone's, so the reading never stops at row 4 - it walks up to 16
  // rows and reads the first 4 whose contract is a real round, a made-up round skipped without counting
  let real = 0;
  for (const w of wants.slice(0, 16)) {
    if (real >= 4) break;
    // ONE BAD ROUND IS NOT THE WHOLE PASS (kanban #1535): a made-up round anyone posted throws here; skip it and read the next table
    const k = await contractOf(w.round).catch(() => null);
    if (!k) continue;
    const left = Number(k.c.entryCloseMs) - Date.now();
    // ONLY AN OPEN TABLE COUNTS (kanban #1912, #1954, #1991): a real round that is over is still served by the seats, so four re-posted past
    // rounds were counted as the 4 tables and the real player's table was never read; one that is over or already entered is skipped uncounted
    if (left <= 0 || k.entered) continue;
    real++;
    tables.set(tableOf(k.c), Date.now() + 40000);
    // NOT AT THE TABLE BEFORE IT STAKES (kanban #2901): its presence is said by go(), once it enters - a player never sees the bot seated in a round it stays out of
    if (busy || left < MIN_LEFT_MS) continue;
    // A TAP IS A HINT (kanban #2842, ruling 2026-11-16 (a)): it only puts the table on this list; the bot stakes on the seats' own fact - a seat
    // holding a VERIFIED stake lock of one non-bot entry (GET /order-locks: stakeVerifiedMs), with BOT_LEAD_MS before the close (opponent-trigger.js).
    // Read beside the loop so it never holds up another table; the first seat that answers is enough
    // A KNOWN PLAYER'S TAP BRINGS THE BOT AT ONCE (kanban #2901): the faucet now passes the signed tap's key; a key the bot saw play before
    // (its lock verified at a seat) gets the bot on the tap, 2-4 s before its entry reaches the seats - a fresh key's tap still waits (#2842)
    // ANY KNOWN KEY AMONG THE ROUND'S TAPS (kanban #3729): a stranger's extra tap on the round leaves it no single tap key, and must not cost a known player the fast path
    if (w.tapped && tapKeysOf(w).some((t) => KNOWN.has(t)) && left >= Math.max(MIN_LEFT_MS, botLeadMs(lockMsSeen) + 1000)) { go(w, k, 'a known player tapped'); continue; }
    if (k.asking) continue;
    k.asking = true;
    Promise.any(nodes.slice(0, 5).map(async (n) => {
      const j = await (await fetch(`${n}/api/round-result?round=${w.round}`, { signal: AbortSignal.timeout(2500) })).json();
      const entries = ((j && j.players) || []).filter((p) => BigInt(p.stakeMsat || 0) > 0n).map((p) => ({ entry: p.entry, player: p.player }));
      if (!entries.length) throw new Error('none');
      const locks = new Map(), posted = new Set();   // kanban #2901: posted = a seat holds the entry's stake lock (verified or not yet)
      await Promise.all(entries.map(async (e) => { const r = await fetch(`${n}/order-locks?entry=${e.entry}`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) { const o = await r.json(); if (o && o.stake) posted.add(e.entry); if (o && o.stake && Number.isFinite(Number(o.stakeVerifiedMs))) locks.set(e.entry, Number(o.stakeVerifiedMs)); } }));
      return { entries, locks, posted };
    }))
      .then(({ entries, locks, posted }) => {
        if (k.entered || busy) return;
        // A KNOWN PLAYER GETS THE BOT AT ONCE (kanban #2901, the owner 2026-11-16 ~14:10Z "ja"): a key whose stake lock a seat has verified before is
        // learnt (kept in KNOWN_FILE); its next entry brings the bot straight away, without waiting for this round's lock to be verified - a fresh
        // key still needs a verified lock (#2842), so a stranger's free tap never sends the bot to an empty table
        for (const e of entries) if (e.player && locks.has(e.entry) && !botKeys.has(String(e.player))) knownAdd(String(e.player));
        // kanban #2901: the tapping key played - only the round's one tap key, beside its one non-bot entry whose lock verified (#3309, #3729:
        // a stranger's tap on a real player's round, before or after the player's, no longer gets his never-staked key into KNOWN)
        { const t = tapKeyToLearn({ tapKeys: tapKeysOf(w), entries, locks, botKeys }); if (t) knownAdd(t); }
        const others = entries.filter((e) => e && e.entry && !botKeys.has(String(e.player || '')));
        if (others.length === 1 && KNOWN.has(String(others[0].player || '')) && Number(k.c.entryCloseMs) - Date.now() >= MIN_LEFT_MS) { go(w, k, 'a known player entered'); return; }
        // A POSTED STAKE LOCK IS ENOUGH (kanban #2901, the owner 2026-11-16 "mach den Lock des Bots viel schneller"; measured 18:41Z: the seats verified the
        // player's lock with 4.7 s left and the bot came too late): the page gives each round a fresh key, so 'known' rarely matches - the bot now
        // enters as soon as a seat holds the one other entry's stake lock, verified or not. A made-up lock only parks the bot's stake: the round
        // voids for want of a certified opponent and its locks come back at once (#2872).
        if (others.length === 1 && posted && posted.has(others[0].entry) && Number(k.c.entryCloseMs) - Date.now() >= MIN_LEFT_MS) { go(w, k, 'a player posted a stake lock'); return; }
        // WHAT THE BOT ITSELF NEEDS, NOT A FIXED 12 S (kanban #2901, the owner's playtest 2026-11-16 12:49Z, round 1dc93d0e: his lock was verified 7.9 s
        // before the close and the bot stayed out "under the 12000 ms lead"): the 12 s lead is the page's to give (it offers a round only with
        // H2H_OPPONENT_LEAD_MS left); the bot joins whenever its own handout, lock and entry still fit - its slowest recent lock + 1.5 s, at least 4 s
        const need = Math.max(MIN_LEFT_MS, botLeadMs(lockMsSeen) + 1000);
        const d = botMayEnter({ entries, locks, botKeys, closeMs: Number(k.c.entryCloseMs), nowMs: Date.now(), leadMs: 0, minLeftMs: need });
        if (d.go) go(w, k, w.tapped ? 'a player locked (tapped)' : 'a player locked');
        else if (k.said !== d.why) { k.said = d.why; log({ step: 'not entered', round: w.round.slice(0, 8), tapped: !!w.tapped, why: d.why }); }
      }, () => {}).finally(() => { k.asking = false; });
  }
  if (seen.size > 2048) seen.clear();
};
// READ BEFORE THE FIRST PLAYER COMES, one round of each federation it pays in
{ const rows = ((await (await fetch(`${nodes[0]}/rounds?next=60`, { signal: AbortSignal.timeout(60000) })).json()).rounds || []).filter((r) => /rock/.test((r.game && r.game.name) || ''));
  for (const fed of wallets.keys()) { const r = rows.find((x) => String(x.federation || '').toLowerCase() === fed); if (!r) continue;
    const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${r.id}`)).arrayBuffer()));
    const known = splits.get(splitKey(c));
    if (known && Date.now() - known.at < SPLIT_KEEP_MS) continue;
    const t = Date.now(); await readSplit(c, r.id).catch((e) => log({ step: 'split not read', why: e.message })); log({ step: 'split read', federation: fed.slice(0, 8), ms: ms(t) }); } }
// THE NEXT ROUNDS' CONTRACTS, READ AHEAD (kanban #947, measured 2026-11-01: reading a round's contract when a player arrives took seconds under load, in an 8 s round the bot came a round late)
const ahead = async () => {
  const rows = await Promise.any(nodes.slice(0, 5).map(async (n) => { const r = await fetch(`${n}/rounds?next=16`, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(String(r.status)); return (await r.json()).rounds || []; }));
  for (const r of rows.filter((x) => /rock/.test((x.game && x.game.name) || '') && wallets.has(String(x.federation || '').toLowerCase()) && !seen.has(x.id)).slice(0, 8)) await contractOf(r.id).catch(() => {});
};
setInterval(() => { ahead().catch(() => {}); }, 15000);
// ITS OWN TOP-UP (kanban #947): a stake waits in a lock until its round settles, so a wallet under REFILL_BELOW sat asks the faucet for REFILL_SATS, one wallet and one ask at a time
// OVER THE NEXT WORKING GATEWAY, EARLY (kanban #3893, 2026-11-27: gw-a's LND was down for ten hours, every top-up failed and the bot ran out): the
// invoice is made at GATEWAYS in turn (./bot-topup.mjs - the last one that worked first) until the faucet pays one; the default threshold is
// 3000 sat (several stakes, not the last one). DIR/balance.json says each wallet's balance and the last top-up and failure, every pass, for the
// health watcher (kanban #3893: a Signal alert when a bot cannot top up)
const REFILL_BELOW = Number(env.REFILL_BELOW || 3000), REFILL_SATS = Number(env.REFILL_SATS || 6000), refilling = new Set();
const GATEWAYS = gatewaysOf(env), topState = { lastOk: null, lastFail: null, gateway: {} };   // gateway: the one that worked last, per federation
const balanceFile = env.DIR ? join(env.DIR, 'balance.json') : null;
// A WALLET WHOSE TOP-UP FAILED AT EVERY GATEWAY WAITS (measured 2026-11-27 20:00Z: in federation 4dc88be7 the faucet paid gw-a's and gw-b's
// invoices and no claim came - asked again every 30 s, each pass would have put two more payments in flight): 5 min, doubled, at most 60 min
const backoff = new Map(), BACKOFF_FIRST_MS = Number(env.REFILL_BACKOFF_MS || 300000), BACKOFF_MOST_MS = 3600000;
const refill = async () => {
  const token = env.REFILL_URL && env.REFILL_TOKEN_FILE ? readFileSync(env.REFILL_TOKEN_FILE, 'utf8').trim() : null;
  const seen = {};
  for (const [fed, w] of wallets) {
    const have = BigInt(await w.lc.balanceMsat());
    seen[fed.slice(0, 8)] = String(have);
    if (!token || refilling.has(fed)) continue;
    if (have >= BigInt(REFILL_BELOW) * 1000n) continue;
    const wait = backoff.get(fed);
    if (wait && Date.now() < wait.untilMs) continue;
    refilling.add(fed);
    try {
      const r = await topUp({ gateways: GATEWAYS, prefer: topState.gateway[fed.slice(0, 8)],
        receive: async (gw) => JSON.parse(await w.lc.receive(String(BigInt(REFILL_SATS) * 1000n), gw)),
        ask: async (invoice) => (await fetch(env.REFILL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoice, token }), signal: AbortSignal.timeout(90000) })).json(),
        awaitReceive: (op) => w.lc.awaitReceive(op),
        listed: async () => JSON.parse(await w.lc.gateways()),   // kanban #3893b: only gateways joined to this federation; none when its guardians are out of reach
        log: (x) => log({ ...x, federation: fed.slice(0, 8) }) });
      if (r.ok) {
        topState.lastOk = { at: new Date().toISOString(), gateway: r.gateway }; topState.gateway[fed.slice(0, 8)] = r.gateway; backoff.delete(fed);
        const after = String(await w.lc.balanceMsat()); seen[fed.slice(0, 8)] = after;
        log({ step: 'topped up', federation: fed.slice(0, 8), haveMsat: String(have), gateway: r.gateway, skipped: r.tried.length, final: r.final, balanceMsat: after });
      } else {
        topState.lastFail = { at: new Date().toISOString(), why: r.tried.map((t) => `${t.gateway.replace(/^https?:\/\//, '').split('.')[0]} ${t.step}: ${t.why}`).join('; ').slice(0, 300) };
        const ms = Math.min(BACKOFF_MOST_MS, wait ? wait.ms * 2 : BACKOFF_FIRST_MS); backoff.set(fed, { ms, untilMs: Date.now() + ms });
        log({ step: 'top-up failed', federation: fed.slice(0, 8), haveMsat: String(have), why: topState.lastFail.why, nextTryMin: Math.round(ms / 60000) });
      }
    } catch (e) { topState.lastFail = { at: new Date().toISOString(), why: String(e.message).slice(0, 160) }; log({ step: 'top-up failed', federation: fed.slice(0, 8), why: topState.lastFail.why }); }
    refilling.delete(fed);
  }
  if (balanceFile) {
    try { writeFileSync(balanceFile + '.tmp', JSON.stringify({ at: new Date().toISOString(), belowSat: REFILL_BELOW, refillSat: REFILL_SATS, gateways: GATEWAYS, balanceMsat: seen, ...topState })); renameSync(balanceFile + '.tmp', balanceFile); } catch { /* next pass */ }
  }
};
setInterval(() => { refill().catch(() => {}); }, 30000);
refill().catch(() => {});
ahead().catch(() => {});
log({ step: 'watching', wants: env.WANTS, seats: nodes.length });
for (;;) { await pass().catch((e) => log({ step: 'pass failed', why: String(e.message).slice(0, 120) })); await new Promise((r) => setTimeout(r, 200)); }
