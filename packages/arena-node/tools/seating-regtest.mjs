#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RESERVE SEATS ON A PRIVATE REGTEST, NINE SEATS (multiplayer_p2p.md §5A.7). Never testnet4, nothing paid:
// free rounds of nextblock on a census of exactly nine bonded seats, so each role draws all nine (9 for 7 seats) and every
// round's contract names the nine (decision A: the contract names the draw; the seating is the certificate).
//
//   BITCOIN_BIN=<dir with bitcoind, bitcoin-cli> WORK=<empty dir> node tools/seating-regtest.mjs     (from packages/arena-node)
//
// The cases, one round each (one JSON line per reading):
//   A  all nine up                    -> the first 7 of the draw seated, every one signed; an entry taken; the client's
//                                        own check of the certificate names the same committee
//   D  a second seating for round A   -> signed by the nodes it seats, handed to a seat: the proof of equivocation stands,
//                                        the round takes no entries, GET /seating-equivocation shows both
//   B  two drawn seats down           -> the seven present seated, the reserves (8th and 9th of the draw) among them; an
//                                        entry taken
//   C  five drawn seats down          -> four present: no certificate; an entry refused; the client refuses to enter
//   E  a certificate missing a signature, handed to the client -> refused
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bondSetFor } from '../src/curve.js';
import { feldmanGroup } from '../src/curve.js';
import { NEXTBLOCK, TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { RUN_82_TICKS } from './round-2of2.mjs';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { verifySeating, signSeating, encodeSeatingCertificate, decodeSeatingCertificate, seatingEquivocation, seatingCloseMs } from '../../arena-protocol/src/seating.js';
import { clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import * as pageCurve from '../../arena-client/src/page-curve.js';
import { rand, secretScalar } from '../test/window-fixture.js';

const env = process.env;
const B = env.BITCOIN_BIN, WORK = env.WORK;
if (!B || !WORK) throw new Error('BITCOIN_BIN=<bin dir> WORK=<dir>');
const RPC = Number(env.RPCPORT || 28441), P2P = RPC + 1;
const PORTS = Array.from({ length: 9 }, (_, i) => 28501 + 10 * i);
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
mkdirSync(join(WORK, 'btc'), { recursive: true });
mkdirSync(join(WORK, 'attach'), { recursive: true });

// ---- bitcoind, a wallet, coins
const bitcoind = spawn(`${B}/bitcoind`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-fallbackfee=0.0002', '-txindex=1'], { stdio: 'ignore' });
const cli = (...a) => execFileSync(`${B}/bitcoin-cli`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, ...a], { encoding: 'utf8' }).trim();
for (let n = 0; n < 60; n++) { try { cli('getblockcount'); break; } catch { await wait(500); } }
const rt = regtest((...a) => cli(...(a[0] === 'listwallets' || a[0] === 'createwallet' || a[0] === 'loadwallet' ? a : ['-rpcwallet=seat', ...a])), { wallet: 'seat', network: 'regtest' });
rt.mine(250);
say({ step: 'bitcoind', height: rt.height() });

// ---- nine seats, each its own store and identity
const stores = PORTS.map((_, i) => join(WORK, `node-${i + 1}.db`));
const ids = stores.map((p) => { const db = openStore(p); const id = nodeIdentity(db); db.close(); return id; });
const keyHex = ids.map((id) => toHex(id.pubkey));
const procs = new Array(9).fill(null);
const startSeat = (i) => {
  const e = { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${WORK}/btc/regtest/.cookie`, ARENA_FUND_FREE_ROUNDS: '1',
    ARENA_GAMES: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname, ARENA_DONATION_NETWORK: 'regtest',
    ARENA_SEATING: '1', ARENA_SEATING_TICK_MS: '1000',
    // GET /headers for the client's own committee: headers.bin from the regtest genesis, extended by each seat every 30 s
    ARENA_ATTACH_PROOF_DIR: join(WORK, 'attach') };
  delete e.ARENA_SERIES_FILE;
  const p = spawn(process.execPath, ['src/main.js', String(PORTS[i]), stores[i]], { cwd: new URL('..', import.meta.url).pathname, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; for (const s of [p.stdout, p.stderr]) s.on('data', (d) => { p.log += d; appendFileSync(join(WORK, `node-${i + 1}.log`), d); if (p.log.length > 400000) p.log = p.log.slice(-200000); });
  procs[i] = p;
};
const up = async (i) => { for (let n = 0; n < 80; n++) { try { if ((await fetch(`http://127.0.0.1:${PORTS[i]}/identity`)).ok) return; } catch { /* not yet */ } await wait(500); } throw new Error(`seat ${i + 1} did not come up`); };
const stopSeat = async (i) => { if (procs[i]) { procs[i].kill('SIGTERM'); procs[i] = null; await wait(800); } };
for (let i = 0; i < 9; i++) startSeat(i);
for (let i = 0; i < 9; i++) await up(i);
say({ step: 'nine seats', ports: PORTS });

// ---- their bonds, buried past the regtest bond maturity
// each bond mined right after it is posted: a template-2 bond's maturity is fixed at posting, against the next block
const posted = ids.map((id, i) => { const p = rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${PORTS[i]}`, hostedGames: [NEXTBLOCK.gameId] }); rt.include([p.hex]); return p; });
rt.mine(110);
const H = rt.height();
say({ step: 'bonds', bonds: posted.length, censusHeight: H });

// THE HEADERS THE SEATS SERVE, from the regtest genesis (the client's anchor for this run)
const headerHex = []; for (let h = 0; h <= H; h++) headerHex.push(cli('getblockheader', cli('getblockhash', String(h)), 'false'));
const headersBin = Buffer.from(headerHex.join(''), 'hex');
writeFileSync(join(WORK, 'attach', 'headers.bin'), headersBin);
const ANCHOR = { hash: blockHashOf(new Uint8Array(headersBin.subarray(0, 80))), height: 0 };
say({ step: 'headers', count: headerHex.length });

// a block every 2 s from here on: a round's beacon is the first block whose median time past is after its committee time
let mining = true;
(async () => { while (mining) { try { rt.mine(1); } catch { /* bitcoind busy */ } await wait(2000); } })();

const base = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK.gameId, simCoreHash: TRUCK_CORE_HASH, randomnessRule: 'bitcoin-block-hash',
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: H, censusRoot: b32(0), stakeMsat: 0n,
  bondMinSats: 50000n, blockTicks: RUN_82_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [...ids.map((id) => id.pubkey)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
};
// THE CENSUS AT H, as the seats derive it
{
  const view = rt.blocksFrom(Math.max(0, H - 130), H);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions || []) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ } }
  const now = BigInt(Date.now());
  const full = decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs: now, startTimeMs: now + 200000n, entryCloseMs: now + 200000n }));
  const census = deriveCensus(view, { contract: full, bond: bondSetFor('regtest'),
    verifyUpdate: verify, resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  if (!census.ok) throw new Error(`no census at ${H}: ${census.why}`);
  base.censusRoot = census.root;
  say({ step: 'census', entries: census.entries.length, keys: census.entries.map((e) => `seat ${keyHex.indexOf(toHex(e.pubkey)) + 1}`), excluded: (census.excluded || []).slice(0, 5), root: toHex(census.root).slice(0, 16) });
  if (env.STOP_AFTER_CENSUS) { for (let i = 0; i < 9; i++) await stopSeat(i); bitcoind.kill(); process.exit(0); }
}

const http = (i, path, init) => fetch(`http://127.0.0.1:${PORTS[i]}${path}`, init);
const postOnce = (i, c) => http(i, '/round', { method: 'POST', body: encodeRoundContract(c) }).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 90) }), (e) => ({ status: `error ${e.cause ? e.cause.code : e.message}` }));
const postRound = async (c) => Promise.all(PORTS.map(async (_, i) => {
  if (!procs[i]) return 'down';
  let r = await postOnce(i, c);
  if (String(r.status).startsWith('error')) { await wait(1500); r = await postOnce(i, c); }
  return String(r.status);
}));
/** A round whose seating closes CLOSE_S after now, committee time COMMITTEE_S after now. */
const newRound = (tag) => {
  const now = BigInt(Date.now());
  const committeeTimeMs = now + 20000n;
  const startTimeMs = committeeTimeMs + 320000n;          // seating closes at committee + 200 s, PRESENT from committee + 140 s
  // the contract as a seat reads it (decoded: protocolVersion and every default filled), as the client is handed it
  return decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs, startTimeMs, entryCloseMs: startTimeMs, publicationRelays: [`wss://r.example/${tag}`] }));
};
const listing = async (i, rid) => {
  const r = await http(i, '/rounds?next=64').catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json();
  return (j.rounds || []).find((x) => x.id === toHex(rid)) || null;
};
const drawnOf = async (rid) => {
  for (let n = 0; n < 120; n++) {
    for (let i = 0; i < 9; i++) {
      if (!procs[i]) continue;
      const row = await listing(i, rid);
      if (row && row.committee && row.committee.drawn) return row.committee.drawn;
    }
    await wait(1000);
  }
  throw new Error('no seat drew the round');
};
const certOf = async (i, rid, role) => {
  const r = await http(i, `/seating?round=${toHex(rid)}&role=${role}`).catch(() => null);
  return r && r.ok ? fromHex((await r.json()).cert) : null;
};
const untilClose = async (c, extraMs) => { const left = Number(seatingCloseMs(c)) - Date.now() + extraMs; if (left > 0) await wait(left); };
const enter = async (c, rid, seatedSettlement, live) => {
  const preimage = secretScalar(); const eph = rand(32); const player = schnorr.getPublicKey(rand(32));
  // a round with fewer than 5 seated has no committee to deal a 5-of handout to: the entry goes without one (the seat's
  // seating gate answers before any handout is read)
  let dealt;
  try {
    dealt = await dealHandout({ preimage, signerNodes: seatedSettlement.map(fromHex), roundId: rid, playerPubkey: player, ephemeralSecret: eph,
      ephemeralPubkey: feldmanGroup.pointX(eph), coefficients: Array.from({ length: 4 }, () => scalarFrom32(rand(32)) % FIELD), needed: 5, curve: feldmanGroup });
  } catch (e) { dealt = { ok: false, why: e.message, handout: { commitments: [new Uint8Array(33).fill(2)] } }; }
  const entry = { roundId: rid, playerPubkey: player, sessionPubkey: b32(4), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0,
    stakeCommitment: sha256(preimage), vssSharesRef: dealt.ok ? handoutId(dealt.handout) : b32(0),
    worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? b32(0) : b32(9), stakePoint: dealt.handout.commitments[0],
    feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
  const out = [];
  for (const i of live) {
    if (dealt.ok) await http(i, '/handout', { method: 'POST', body: encodeHandout(dealt.handout) }).catch(() => null);
    const r = await http(i, '/entry', { method: 'POST', body: encodeEntryContract(entry) }).catch(() => null);
    out.push({ seat: i + 1, status: r ? r.status : 'down', said: r ? (await r.text()).slice(0, 120) : '' });
  }
  return out;
};
const clientCheck = async (rid, c, live) => {
  try {
    const got = await clientSettlementSignerNodes(toHex(rid), c, live.map((i) => `http://127.0.0.1:${PORTS[i]}`), { curve: pageCurve, anchorAt: ANCHOR });
    return { ok: true, signerNodes: got.signerNodes.map((k) => toHex(k).slice(0, 8)), seating: got.derived.seating && got.derived.seating.settlement && got.derived.seating.settlement.seated ? 'checked' : String(JSON.stringify(got.derived.seating)) };
  } catch (e) { return { ok: false, why: e.message.slice(0, 700) }; }
};
const readCerts = async (rid, c, drawn, live) => {
  const out = {};
  for (const role of ['game', 'settlement']) {
    const per = [];
    for (const i of live) {
      const cert = await certOf(i, rid, role);
      if (!cert) { per.push({ seat: i + 1, cert: null }); continue; }
      const v = verifySeating(cert, { roundId: rid, role, drawn: drawn[role].map(fromHex), slots: 7, verify });
      per.push({ seat: i + 1, ok: v.ok, why: v.why, seated: v.ok ? v.seating.seated.map((k) => drawn[role].indexOf(toHex(k)) + 1) : null, signers: v.ok ? v.seating.signatures.length : 0 });
    }
    out[role] = per;
  }
  return out;
};
const all = [...Array(9).keys()];

// ======== G: AT GRID DENSITY - GRID=1 runs only this: GRID_ROUNDS rounds, two per GRID_SLOT_MS slot as the
// RPS grid posts them (one census, one committee time), posted at once; at each round's start every seat is asked for both
// roles' certificates. Measured on testnet4 2026-10-11: 349 game seatings signed and 35 certificates built at seat 3.
if (env.GRID) {
  const N = Number(env.GRID_ROUNDS || 30), SLOT = BigInt(env.GRID_SLOT_MS || 8000);
  const committee = BigInt(Date.now()) + 20000n;
  const first = committee + BigInt(env.GRID_FIRST_MS || 320000);
  const rounds = [];
  for (let k = 0; k < N; k++) {
    const start = first + BigInt(Math.floor(k / 2)) * SLOT;
    const c = decodeRoundContract(encodeRoundContract({ ...base, committeeTimeMs: committee, startTimeMs: start, entryCloseMs: start, publicationRelays: [`wss://r.example/G${k}`] }));
    rounds.push({ k, c, rid: roundId(c) });
  }
  const t0 = Date.now();
  for (const r of rounds) r.posted = await postRound(r.c);
  say({ case: 'G', step: 'posted', rounds: N, slotMs: Number(SLOT), postSeconds: Math.round((Date.now() - t0) / 1000), firstStart: new Date(Number(first)).toISOString(),
    seatingCloseOfFirst: new Date(Number(seatingCloseMs(rounds[0].c))).toISOString(), refused: rounds.filter((r) => r.posted.some((x) => !x.startsWith('2'))).length });
  const at = async (r) => {
    const per = [];
    for (const i of all) per.push((await certOf(i, r.rid, 'game')) && (await certOf(i, r.rid, 'settlement')) ? 1 : 0);
    return per.reduce((a, b) => a + b, 0);
  };
  const rows = [];
  for (const r of rounds) {
    const left = Number(r.c.startTimeMs) - Date.now(); if (left > 0) await wait(left);
    r.atStart = await at(r);
    rows.push(r);
  }
  await wait(30000);
  for (const r of rounds) r.after30 = await at(r);
  const full = (x) => x === 9;
  say({ case: 'G', step: 'certificates', perRound: rounds.map((r) => `${r.k}:${r.atStart}/${r.after30}`).join(' '),
    fullAtStart: rounds.filter((r) => full(r.atStart)).length, fullAfter30s: rounds.filter((r) => full(r.after30)).length, of: N });
  for (let i = 0; i < 9; i++) await stopSeat(i); bitcoind.kill(); process.exit(0);
}

// ======== A: all nine up
const cA = newRound('A'); const ridA = roundId(cA);
say({ case: 'A', step: 'round', id: toHex(ridA).slice(0, 16), posted: await postRound(cA), seatingClose: new Date(Number(seatingCloseMs(cA))).toISOString() });
const drawnA = await drawnOf(ridA);
say({ case: 'A', step: 'drawn', game: drawnA.game.map((k) => `seat ${keyHex.indexOf(k) + 1}`), settlement: drawnA.settlement.map((k) => `seat ${keyHex.indexOf(k) + 1}`) });
await untilClose(cA, 15000);
const certsA = await readCerts(ridA, cA, drawnA, all);
say({ case: 'A', step: 'certificates (draw positions seated)', game: certsA.game, settlement: certsA.settlement });
const seatedA = certsA.settlement.find((x) => x.ok);
const seatedAKeys = seatedA ? seatedA.seated.map((p) => drawnA.settlement[p - 1]) : [];
say({ case: 'A', step: 'entry', at: await enter(cA, ridA, seatedAKeys, all) });
say({ case: 'A', step: 'client', ...(await clientCheck(ridA, cA, all)) });

// ======== D: a second seating for round A, signed by the nodes it seats
{
  const role = 'game';
  const pos = [0, 1, 2, 3, 4, 7, 8];                                     // the first five of the draw and the two reserves
  const seated = pos.map((p) => fromHex(drawnA[role][p]));
  const sigs = seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: ridA, role, seated }, (m) => schnorr.sign(m, ids[keyHex.indexOf(toHex(k))].secret)) }));
  const second = encodeSeatingCertificate({ roundId: ridA, role, seated, signatures: sigs });
  const r = await http(0, '/seating', { method: 'POST', body: second });
  const said = await r.text();
  const first = await certOf(1, ridA, role);
  const e = first ? seatingEquivocation(first, second, { roundId: ridA, role, drawn: drawnA[role].map(fromHex), slots: 7, verify }) : { ok: false, why: 'no first' };
  const eq = await (await http(0, `/seating-equivocation?round=${toHex(ridA)}`)).json();
  say({ case: 'D', step: 'second seating handed to seat 1', status: r.status, said: said.slice(0, 200), proofStands: e.ok, equivocators: e.ok ? e.signers.map((k) => `seat ${keyHex.indexOf(toHex(k)) + 1}`) : e.why,
    servedProofs: eq.equivocations.length, entryAfter: await enter(cA, ridA, seatedAKeys, [0]) });
}

// ======== B: two drawn seats down before the PRESENT window
const cB = newRound('B'); const ridB = roundId(cB);
say({ case: 'B', step: 'round', id: toHex(ridB).slice(0, 16), posted: await postRound(cB) });
const drawnB = await drawnOf(ridB);
const downB = [1, 4].map((p) => keyHex.indexOf(drawnB.settlement[p]));          // the 2nd and 5th of the settlement draw
for (const i of downB) await stopSeat(i);
say({ case: 'B', step: 'down', seats: downB.map((i) => i + 1), drawPositions: [2, 5], secondsToClose: Math.round((Number(seatingCloseMs(cB)) - Date.now()) / 1000) });
await untilClose(cB, 15000);
const liveB = all.filter((i) => !downB.includes(i));
const certsB = await readCerts(ridB, cB, drawnB, liveB);
say({ case: 'B', step: 'certificates (draw positions seated)', game: certsB.game, settlement: certsB.settlement });
const seatedB = certsB.settlement.find((x) => x.ok);
say({ case: 'B', step: 'entry', at: await enter(cB, ridB, seatedB ? seatedB.seated.map((p) => drawnB.settlement[p - 1]) : [], liveB) });
say({ case: 'B', step: 'client', ...(await clientCheck(ridB, cB, liveB)) });
for (const i of downB) startSeat(i);
for (const i of downB) await up(i);

// ======== C: five drawn seats down
const cC = newRound('C'); const ridC = roundId(cC);
say({ case: 'C', step: 'round', id: toHex(ridC).slice(0, 16), posted: await postRound(cC) });
const drawnC = await drawnOf(ridC);
const downC = [0, 1, 2, 3, 4].map((p) => keyHex.indexOf(drawnC.settlement[p]));
for (const i of downC) await stopSeat(i);
say({ case: 'C', step: 'down', seats: downC.map((i) => i + 1), present: 4 });
await untilClose(cC, 15000);
const liveC = all.filter((i) => !downC.includes(i));
say({ case: 'C', step: 'certificates', ...(await readCerts(ridC, cC, drawnC, liveC)) });
say({ case: 'C', step: 'entry', at: await enter(cC, ridC, drawnC.settlement.slice(5, 9), liveC) });
say({ case: 'C', step: 'client', ...(await clientCheck(ridC, cC, liveC)) });
for (const i of downC) startSeat(i);
for (const i of downC) await up(i);

// ======== E: the client handed a certificate missing a signature
{
  const real = await certOf(1, ridB, 'settlement');
  const c = decodeSeatingCertificate(real);
  const cut = encodeSeatingCertificate({ ...c, signatures: c.signatures.slice(1) });
  const stub = createServer(async (q, res) => {
    // the settlement role's certificate with one signature cut; the game role's as the seats hold it
    if (q.url.startsWith('/seating?') && q.url.includes('role=settlement')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ cert: toHex(cut) })); }
    const r = await fetch(`http://127.0.0.1:${PORTS[1]}${q.url}`, { method: q.method }).catch(() => null);
    if (!r) { res.writeHead(502); return res.end(); }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' }); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => stub.listen(28499, '127.0.0.1', ok));
  let got;
  try { got = await clientSettlementSignerNodes(toHex(ridB), cB, ['http://127.0.0.1:28499'], { curve: pageCurve, anchorAt: ANCHOR }); got = { ok: true, signerNodes: got.signerNodes.length }; }
  catch (e) { got = { ok: false, why: e.message.slice(0, 700) }; }
  stub.close();
  say({ case: 'E', step: 'client handed a certificate missing one signature', ...got });
}

// the seats' own words on it
for (const i of [0, 1]) say({ step: `seat ${i + 1} log`, seating: (procs[i].log.match(/\[seating\][^\n]*/g) || []).slice(-12) });
mining = false;
for (let i = 0; i < 9; i++) await stopSeat(i);
bitcoind.kill('SIGTERM');
say({ step: 'stopped', work: WORK });
process.exit(0);
