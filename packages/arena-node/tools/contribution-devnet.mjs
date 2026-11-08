#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE REGTEST RUN OF A CONTRIBUTION AGREEMENT (kanban #1346, spec §27A.4.2 at regtest's scale, ruling #1349: T1 3 identities, T2 2 of them back
 * after 6 blocks, read lag 6). On a devnet that is up (devnet.mjs up with ARENA_GRID_REGTEST=1, ARENA_REGTEST_EXTRA_DONATION_SET=<KEYS>/set.hex,
 * ARENA_CONTRIBUTION_READ_MS short, DEVNET_KEEPER=0) and has its liquidity:
 *
 *   1  grid 1: a paid grid of series rounds (the rounds that count, #1218) naming the set that carries the agreement; three fresh identities
 *      enter its first round through his referral (site) key, each naming itself with its own consent (#1276)
 *   2  grid 2, its census at least 6 blocks above grid 1's: two of them enter again
 *   3  the seats' books read the counted rounds: GET /contribution-shares?height= on two seats until T1 and T2 have vested - the same answer
 *   4  his leave (his own key): the vested share pays through the tail and then ends; a termination by the cold admin key: it ends at once
 *
 *   KEYS=<dir of contribution-devnet-keys.mjs> DEVNET_DIR DEVNET_BASE_PORT PAYER_DIR PAYER_RPC INVITE_FILE WASM_PKG LNCLI node tools/contribution-devnet.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { devnetPorts } from './devnet-plan.mjs';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { encodeContributionLeave, contributionLeaveDigest } from '../../arena-protocol/src/contribution.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const D = resolve(env.DEVNET_DIR || 'devnet-data');
const K = resolve(env.KEYS);
const PLAN = devnetPorts(Number(env.DEVNET_BASE_PORT || 24000));
const SEATS = PLAN.nodes.map((p) => `http://127.0.0.1:${p}`);
const CONTROL = `http://127.0.0.1:${PLAN.control}`;
const say = (o) => console.log(`#1346 ${JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o })}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url, ms = 10000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`); return r.json(); };
const tip = async () => (await getJson(`${SEATS[0]}/chain-tip`)).height;
const who = JSON.parse(readFileSync(join(K, 'contributor.json'), 'utf8'));
const setBytes = fromHex(readFileSync(join(K, 'set.hex'), 'utf8').trim());
const SET_ID = toHex(donationSetId(decodeDonationSetBody(setBytes.slice(0, -64)).recipients));
const STAKE = env.STAKE_MSAT || '10000000';
const LIMIT_MS = Number(env.LIMIT_S || 10800) * 1000, T0 = Date.now();
const timeLeft = () => LIMIT_MS - (Date.now() - T0);

// THE IDENTITIES: three fresh ones, their secrets in files the players read
mkdirSync(join(D, 'c1346'), { recursive: true });
const ids = [0, 1, 2].map((i) => { const s = randomBytes(32); const f = join(D, 'c1346', `identity-${i}.hex`); writeFileSync(f, toHex(s)); return { i, file: f, key: toHex(schnorr.getPublicKey(s)) }; });
say({ step: 'start', agreement: who.agreementId.slice(0, 16), set: SET_ID.slice(0, 16), siteKey: who.siteKey.slice(0, 16), identities: ids.map((x) => x.key.slice(0, 16)) });

async function openGrid(censusHeight = null) {
  const q = new URLSearchParams({ stakeMsat: STAKE, slots: '2', windowMs: String(env.WINDOW_MS || 240000), leadMs: String(env.LEAD_MS || 60000), donationSetId: SET_ID,
    ...(censusHeight !== null ? { censusHeight: String(censusHeight) } : {}) });
  const r = await fetch(`${CONTROL}/open-grid?${q}`, { method: 'POST' });
  const j = await r.json();
  if (!j.ok || !j.rounds || !j.rounds.length) throw new Error(`no grid: ${JSON.stringify(j).slice(0, 300)}`);
  say({ step: 'grid', txid: String(j.txid).slice(0, 16), census: j.rounds[0].censusHeight, rounds: j.rounds.map((x) => ({ id: x.id.slice(0, 8), start: new Date(x.start).toISOString().slice(11, 19), close: new Date(x.close).toISOString().slice(11, 19) })) });
  return j.rounds;
}

function play(round, who_) {
  const log = join(D, `c1346-player-${round.id.slice(0, 8)}-${who_.i}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [join(HERE, 'tn4-live-run.mjs')], { detached: true, stdio: ['ignore', fd, fd],
    env: { ...env, ARENA_TN4_NETWORK: 'regtest', ARENA_REGTEST_CENSUS_KEY_0: join(D, 'census', 'key0.json'), ROUND: round.id, PORTS: PLAN.nodes.join(','),
      KEYS_FILE: join(D, 'c1346', 'keys.jsonl'), COLLECT_MS: String(env.COLLECT_MS || 1200000), IDENTITY_SECRET_FILE: who_.file, PLAYER_NAME: `c1346-${who_.i}`,
      FRONTEND_PK: who.siteKey, SEARCH: '1' } });
  return { log, child, done: new Promise((ok) => child.on('exit', (code) => ok(code))) };
}
const stepOf = (p, step) => { try { return readFileSync(p.log, 'utf8').split('\n').filter((l) => l.includes(`"step":"${step}"`)); } catch { return []; } };

async function sharesAt(seat, h) {
  const j = await getJson(`${seat}/contribution-shares?height=${h}`, 20000);
  const s = (j.shares || []).find((x) => x.recipient === who.recipientPk) || null;
  return { height: j.height, shareBps: s ? s.shareBps : null, state: s ? s.state : null, tranches: s ? s.tranches : [], book: j.book };
}

try {
  // 1 GRID 1, and GRID 2 with its census 6+ blocks above grid 1's (a grid starts 45 min after its committee time, the grid rule: both are
  // published now and their rounds come about 46 min on)
  const g1 = await openGrid();
  const c1 = Number(g1[0].censusHeight);
  for (; (await tip()) < c1 + 14; await wait(10000));
  const g2 = await openGrid((await tip()) - 7);
  const held = async (rid) => { for (; timeLeft() > 0; await wait(20000)) { try { if ((await fetch(`${SEATS[0]}/round?id=${rid}`, { signal: AbortSignal.timeout(10000) })).ok) return true; } catch { /* not yet */ } } return false; };
  // THREE NEWCOMERS through his link, once the seats hold grid 1's round
  if (!(await held(g1[0].id))) throw new Error('grid 1\'s round was never posted to the seats');
  const players1 = ids.map((x) => play(g1[0], x));
  for (const stop = Date.now() + 15 * 60000; Date.now() < stop && !players1.every((p) => stepOf(p, 'published').length || p.child.exitCode !== null); await wait(5000));
  say({ step: 'grid 1 played', round: g1[0].id.slice(0, 8), census: c1, named: players1.map((p) => (stepOf(p, 'identity named')[0] || '').slice(0, 140)), published: players1.map((p) => stepOf(p, 'published').length > 0) });
  // 2 TWO OF THEM BACK in grid 2's round
  if (!(await held(g2[0].id))) throw new Error('grid 2\'s round was never posted to the seats');
  const players2 = ids.slice(0, 2).map((x) => play(g2[0], x));
  for (const stop = Date.now() + 15 * 60000; Date.now() < stop && !players2.every((p) => stepOf(p, 'published').length || p.child.exitCode !== null); await wait(5000));
  say({ step: 'grid 2 played', round: g2[0].id.slice(0, 8), census: g2[0].censusHeight, published: players2.map((p) => stepOf(p, 'published').length > 0) });

  // 3 THE BOOKS: T1 and T2 vested, two seats answering the same
  let vested = null;
  while (timeLeft() > 0) {
    const h = (await tip()) + 1;
    const [a, b] = await Promise.all([sharesAt(SEATS[0], h), sharesAt(SEATS[3], h)]);
    const t = (x) => x.tranches.map((y) => `${y.milestone}:${y.vestedAt}`).join(' ');
    say({ step: 'shares', height: h, seat1: { share: a.shareBps, tranches: t(a), book: a.book }, seat4: { share: b.shareBps, tranches: t(b), book: b.book } });
    if (a.tranches[0] && a.tranches[0].vestedAt !== null && a.tranches[1] && a.tranches[1].vestedAt !== null && a.shareBps === b.shareBps && JSON.stringify(a.tranches) === JSON.stringify(b.tranches)) { vested = { h, a }; break; }
    await wait(30000);
  }
  if (!vested) throw new Error('T1 and T2 did not vest before the limit');
  const V = vested.h, share = vested.a.shareBps;
  say({ step: 'T1 and T2 vested', t1: vested.a.tranches[0].vestedAt, t2: vested.a.tranches[1].vestedAt, shareBps: share, readAt: V,
    sameAtSeats: [1, 4] });
  // and every seat the same
  const all = await Promise.all(SEATS.map((s) => sharesAt(s, V).then((x) => x.shareBps, (e) => e.message)));
  say({ step: 'every seat at that height', shares: all });

  // 4 HIS LEAVE: signed by his own key at the tip
  const L = await tip();
  const leave = { agreementId: fromHex(who.agreementId), atHeight: L };
  const leaveHex = toHex(encodeContributionLeave(leave)) + toHex(secp256k1.sign(contributionLeaveDigest(leave), fromHex(who.secret)));
  const posted = await Promise.all(SEATS.map((s) => fetch(`${s}/contribution-end`, { method: 'POST', body: leaveHex }).then((r) => r.status, (e) => e.message)));
  say({ step: 'leave posted', atHeight: L, seats: posted });
  const tail = Number(who.tailBlocks);
  const at = async (h) => { const x = await sharesAt(SEATS[0], h); const y = await sharesAt(SEATS[5], h); return { h, seat1: [x.shareBps, x.state], seat6: [y.shareBps, y.state] }; };
  say({ step: 'through the tail', before: await at(L - 1), atLeave: await at(L), inTail: await at(L + tail - 1), afterTail: await at(L + tail) });
  // A TERMINATION BY THE COLD ADMIN KEY inside the tail: the share ends at once
  const T = L + 3;
  const termHex = JSON.parse(readFileSync(join(K, 'terminations.json'), 'utf8'))[String(T)];
  const tposted = await Promise.all(SEATS.map((s) => fetch(`${s}/contribution-end`, { method: 'POST', body: termHex }).then((r) => r.status, (e) => e.message)));
  // and a termination signed by another key is refused
  const forged = termHex.slice(0, -128) + toHex(randomBytes(64));
  const refused = await fetch(`${SEATS[0]}/contribution-end`, { method: 'POST', body: forged }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 80)}`, (e) => e.message);
  say({ step: 'termination posted', atHeight: T, seats: tposted, forged: refused });
  say({ step: 'after the termination', before: await at(T - 1), at: await at(T), later: await at(T + 5) });
  say({ step: 'done', ok: true });
} catch (e) {
  say({ step: 'failed', why: e.message });
  process.exitCode = 1;
}
