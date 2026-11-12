#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * A TEST OPPONENT FOR ROCK PAPER SCISSORS (kanban #926): measured 2026-11-01, a stranger alone at a table paid and saw no result. This is one more player: it asks the page's
 * want list which table has somebody at it, says it is there, and once a player has paid into that round it enters as any player does - the same stake, fee, lock, entry and reveal, under the round's own rules. Its move is
 * drawn evenly. It decides nothing, and its name says what it is ("Test bot").
 *
 *   NODES=<seat url,...> WANTS=<faucet url>/opponent INVITES=<invite file,...> WASM_PKG=<dir> DIR=<its wallets and keys> node tools/rps-opponent.mjs
 *   [MOST_PER_HOUR=120] [MIN_LEFT_MS=900] [ONCE=1]
 *   FUND=<sat> instead: prints one invoice per federation (the wallets' top-up, paid from outside), waits for them, and exits.
 *
 * WALLETS: DIR/wallet-<federation>.json, kept across runs. DIR/keys.jsonl: each entry's player key and locks, as tn4-rps-paid's KEYS_FILE, for tn4-collect.mjs.
 */
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
import { hiddenMove, moveCommitment, revealMove } from '../../arena-client/src/head-to-head.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { entrySplit, lockEntry } from './entry-locks.mjs';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { matchProofId, presenceId } from '../../arena-protocol/src/match.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';

const env = process.env;
const nodes = String(env.NODES || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const DIR = env.DIR, NAME = 'Test bot';
const MOST_PER_HOUR = Number(env.MOST_PER_HOUR || 400), MIN_LEFT_MS = Number(env.MIN_LEFT_MS || 900);
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
for (const file of String(env.INVITES || '').split(',').filter(Boolean)) {
  const invite = readFileSync(file, 'utf8').replace(/["\s]/g, '');
  const fed = String(LockClient.federationIdOf(invite)).toLowerCase();
  const path = join(DIR, `wallet-${fed.slice(0, 16)}.json`);
  const kept = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { secret: toHex(rand(32)), notes: [] };
  const held = new Map(kept.notes);
  const flush = () => writeFileSync(path, JSON.stringify({ secret: kept.secret, notes: [...held] }), { mode: 0o600 });
  const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); flush(); }, remove: (k) => { held.delete(k); flush(); } };
  const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), kept.secret, store);
  flush();
  wallets.set(fed, { lc, rule: JSON.parse(await lc.feeRule()) });
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
const splitKey = (c) => [toHex(c.federationId), c.stakeMsat, toHex(c.donationSetId), toHex(c.gameId)].join(':');
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
  if (Number(c.entryCloseMs) - Date.now() < 400) return { ok: false, why: 'too late to enter' };
  const me = evenPlayer();
  const s = { p: scalar(), player: me.pubkey };
  s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
  const needed = receiptsNeeded(c.settlementSlots ?? c.gameVerifySlots);
  const e = rand(32);
  const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  // THE HANDOUT FIRST, THE LOCK ONLY ONCE ENOUGH SEATS TOOK IT (kanban #1596, the #1489 audit of #1485), as the page does: the bot locked first and posted
  // the handout after, so a head-to-head seat's late-handout refusal (2 s before the close, node-start.js h2hHandoutLeadMs) came after its money - every
  // order with 0.4-2 s left had its stake and fee locked and every seat refused it. Now a refused handout costs nothing: no lock is made
  const handouts = nodes.map((n) => fetch(`${n}/handout`, { method: 'POST', signal: AbortSignal.timeout(POST_MS), body: encodeHandout(dealt.handout) })
    .then(async (h) => ({ status: h.status, why: h.status === 201 ? '' : (await h.text().catch(() => '')).trim().slice(0, 120) }), () => ({ status: 0, why: 'no answer' })));
  const dealtTo = [];
  await new Promise((done) => { for (const p of handouts) p.then((x) => { dealtTo.push(x); if (dealtTo.filter((y) => y.status === 201).length >= needed || dealtTo.length === nodes.length) done(); }); });
  steps.handout = ms(t0);
  if (dealtTo.filter((y) => y.status === 201).length < needed)
    return { ok: false, why: `handout taken by ${dealtTo.filter((y) => y.status === 201).length} of ${nodes.length} seats (${needed} needed), nothing locked: ${[...new Set(dealtTo.map((y) => y.why).filter(Boolean))].join('; ').slice(0, 200)}` };
  // SUBMITTED, NOT WAITED FOR (as market-bot.mjs, kanban #601): the guardians' agreement took over 30 s from the test host, in an 8 s round. The entry goes in at once, its locks after it
  const locks = await lockEntry({ lc: w.lc, c, split, stakePoint: s.point, player: s.player, claimPk: att.claimPk, gate, rand, expiry: Number(c.stakeExpiryBlocks), submitOnly: true });
  const accepted = (locks.accepted || Promise.resolve()).then(() => { steps.accepted = ms(t0); });
  steps.locked = ms(t0);
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(s.p), stakeMsat: BigInt(c.stakeMsat), feeMsat: split.feeMsat,
    donationMsat: split.donationMsat, joinTick: 0, worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? new Uint8Array(32) : rand(32), vssSharesRef: handoutId(dealt.handout),
    stakePoint: dealt.handout.commitments[0], ...locks.entryFields, claimKeyAttestationRef: att.ref };
  const hidden = hiddenMove(randomInt(3), rand);      // evenly: rock, paper, scissors
  entry.commit = moveCommitment({ roundId: rid, sessionPubkey: entry.sessionPubkey, move: hidden.move, salt: hidden.salt });
  const eid = entryId(entry);
  appendFileSync(join(DIR, 'keys.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), round: roundHex, entry: toHex(eid), player: 'bot', secret: toHex(me.secret),
    stake: `${toHex(locks.stake.outpoint.txid)}:${locks.stake.outpoint.outIdx}`, fee: locks.fee ? `${toHex(locks.fee.outpoint.txid)}:${locks.fee.outpoint.outIdx}` : null })}\n`);
  const hand = locks.fee ? locks.fee.fields : null;
  // ENOUGH SEATS, NOT ALL OF THEM: a seat that is restarting never answered and held the bot for minutes (measured 2026-11-01). The rest go on behind
  const posts = nodes.map(async (n, i) => {
    const o = () => ({ method: 'POST', signal: AbortSignal.timeout(POST_MS) });
    const h = await handouts[i];   // posted above, before the lock (kanban #1596)
    const en = await fetch(`${n}/entry`, { ...o(), body: encodeEntryContract(entry) }).catch(() => ({ status: 0, text: async () => 'no answer' }));
    // THE PLAYER'S LOCK CLAIM (kanban #2069, #2088): a signature by the stake point over the entry id, as the page sends it - a seat then hands
    // these locks only to a claimed entry, never to a copy under another stake point. Never fatal.
    if (en.status >= 200 && en.status < 300) { try { await fetch(`${n}/lock-claim?entry=${toHex(eid)}`, { ...o(), body: schnorr.sign(lockClaimDigest(eid), s.p) }).then((r) => r.text()); } catch { /* the seats show it to each other */ } }
    return { node: n, handout: h.status, entry: en.status, why: en.text ? (await en.text().catch(() => '')).trim().slice(0, 120) : '' };
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
  // THE REVEAL AFTER THE ENTRY CLOSE, as a page's
  const proof = { key: toHex(identityKey), sig: toHex(schnorr.sign(matchProofId({ roundId: rid, entryId: eid, identityKey }), identity)) };
  setTimeout(async () => {
    const r = await revealMove({ entryIdHex: toHex(eid), move: hidden.move, salt: hidden.salt, nodes, identity: proof }).catch((x) => [{ status: 0, why: x.message }]);
    log({ step: 'revealed', round: roundHex.slice(0, 8), move: hidden.move, ok: r.filter((x) => x.status === 200 || x.status === 201).length, of: r.length });
  }, Math.max(0, Number(c.entryCloseMs) - Date.now() + 150));
  return { ok: took >= needed };
}

// A TABLE IS WATCHED WHILE THE PAGE SAYS SOMEBODY IS AT IT: the bot says it is there (free) and reads the claim key ahead, and enters when the player taps. Measured 2026-11-01: entering
// every 8 s round while somebody looked would lock 100 sat a round for a day, and an entry lands about 4 s after its tap, so one that waited to see the player's entry had no time left.
const seen = new Map();      // round hex -> { c, rid, told, entered }
const hour = [];
let busy = false;
const contractOf = async (round) => {
  let k = seen.get(round);
  if (!k) {
    // WHICHEVER SEAT ANSWERS FIRST (measured under a loaded test host: one seat took over 3 s, another 6 s, and an 8 s round was gone)
    const bytes = await Promise.any(nodes.slice(0, 5).map(async (n) => { const r = await fetch(`${n}/round?id=${round}`, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(String(r.status)); return new Uint8Array(await r.arrayBuffer()); }));
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
    if (until && until > now && Number(k.c.entryCloseMs) > now && Number(k.c.entryCloseMs) - now < 20000) sayHere(round, k, true);
  }
};
setInterval(sayAtTables, 2000);
const pass = async () => {
  const wants = (await (await fetch(env.WANTS, { signal: AbortSignal.timeout(3000) })).json()).wants || [];
  for (const w of wants.slice(0, 4)) {
    // ONE BAD ROUND IS NOT THE WHOLE PASS (kanban #1535): a made-up round anyone posted throws here; skip it and read the next table
    const k = await contractOf(w.round).catch(() => null);
    if (!k) continue;
    const left = Number(k.c.entryCloseMs) - Date.now();
    if (left <= 0 || k.entered) continue;
    tables.set(tableOf(k.c), Date.now() + 40000);
    sayHere(w.round, k);
    if (busy || left < MIN_LEFT_MS) continue;
    if (w.tapped) { go(w, k, 'a player tapped'); continue; }
    // A PAGE THAT SAID NO TAP, OR A TAP THE DOOR LOST: the entry itself, read beside the loop so it never holds up a tap at another table. The first seat that holds it is enough
    if (k.asking) continue;
    k.asking = true;
    Promise.any(nodes.slice(0, 5).map(async (n) => { const r = await fetch(`${n}/api/round-result?round=${w.round}`, { signal: AbortSignal.timeout(2500) }); const j = await r.json(); const m = ((j && j.players) || []).length; if (!m) throw new Error('none'); return m; }))
      .then((m) => { if (m === 1 && !k.entered && !busy) go(w, k, 'a player paid'); }, () => {}).finally(() => { k.asking = false; });
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
const REFILL_BELOW = Number(env.REFILL_BELOW || 500), REFILL_SATS = Number(env.REFILL_SATS || 3000), refilling = new Set();
const refill = async () => {
  if (!env.REFILL_URL || !env.REFILL_TOKEN_FILE) return;
  const token = readFileSync(env.REFILL_TOKEN_FILE, 'utf8').trim();
  for (const [fed, w] of wallets) {
    if (refilling.has(fed)) continue;
    const have = BigInt(await w.lc.balanceMsat());
    if (have >= BigInt(REFILL_BELOW) * 1000n) continue;
    refilling.add(fed);
    try {
      const rcv = JSON.parse(await w.lc.receive(String(BigInt(REFILL_SATS) * 1000n), env.GATEWAY || ''));
      const r = await (await fetch(env.REFILL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoice: rcv.invoice, token }), signal: AbortSignal.timeout(90000) })).json();
      log({ step: 'top-up asked', federation: fed.slice(0, 8), haveMsat: String(have), ok: r.ok, why: r.why });
      if (r.ok) log({ step: 'topped up', federation: fed.slice(0, 8), final: await w.lc.awaitReceive(rcv.operation), balanceMsat: String(await w.lc.balanceMsat()) });
    } catch (e) { log({ step: 'top-up failed', federation: fed.slice(0, 8), why: String(e.message).slice(0, 160) }); }
    refilling.delete(fed);
  }
};
setInterval(() => { refill().catch(() => {}); }, 30000);
refill().catch(() => {});
ahead().catch(() => {});
log({ step: 'watching', wants: env.WANTS, seats: nodes.length });
for (;;) { await pass().catch((e) => log({ step: 'pass failed', why: String(e.message).slice(0, 120) })); await new Promise((r) => setTimeout(r, 200)); }
