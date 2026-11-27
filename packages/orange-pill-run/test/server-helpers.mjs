// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Test helpers for the round service (kanban #3248-#3250, #3256): a fake clock, a fake lnd, a fake chain, a Season 2 book in memory, signed
// NIP-98 sign-ins - and a STAND-IN SIMULATION for tests only (the real one is src/sim; the service takes whichever it is given).
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { eventId } from '../../arena-node/src/nostr-relay.js';
import { openBountySeason } from '../../arena-node/src/bounty-season.js';
import { createOpr } from '../server/opr-service.mjs';

export const MIN = 60000, DAY = 86400000;
export const at = (iso) => Date.parse(iso);

/** Stand-in sim: the score is 10 per press, the run lasts until the last release + 60 steps; deterministic, as runLog is. */
export const stubSim = {
  GAME_VERSION: 'opr-test-1',
  buildLevel: (candles, seed) => ({ seed, n: candles.length }),
  runLog: (L, log) => { const last = log.presses.length ? log.presses[log.presses.length - 1][1] : 0; const steps = last + 60;
    return { total: log.presses.length * 10, parts: { sats: log.presses.length * 10 }, clean: true, finished: true, steps, deaths: 0, timeS: steps / 60 }; },
};
export const candles48 = (day) => Array.from({ length: 48 }, (_, i) => [Date.parse(`${day}T00:00:00Z`) / 1000 + i * 1800, 100 + i, 101 + i, 99 + i, 100.5 + i]);

export function fakeLnd() {
  const inv = new Map();
  return {
    inv,
    async create({ sats, memo, expirySeconds }) { const hash = randomBytes(32).toString('hex'); inv.set(hash, { sats, memo, expirySeconds, state: 'OPEN', paidMsat: 0 }); return { hash, invoice: `lntb${sats}n1${hash.slice(0, 40)}` }; },
    async lookup(hash) { const x = inv.get(hash); if (!x) throw new Error('unknown'); return { state: x.state, paidMsat: x.paidMsat, settleMs: x.settleMs || null }; },
    pay(invoice, msat = null) { const h = [...inv.keys()].find((k) => invoice.endsWith(k.slice(0, 40))); const x = inv.get(h); x.state = 'SETTLED'; x.paidMsat = msat ?? x.sats * 1000; },
  };
}
export function fakeChain() {
  const posts = [];
  return { posts, confirm: () => { for (const p of posts) p.conf = 1; },
    async post(hex) { const txid = createHash('sha256').update(hex + posts.length).digest('hex'); posts.push({ txid, hex, conf: 0 }); return txid; },
    async status(txid) { const p = posts.find((x) => x.txid === txid); return { confirmations: p.conf, height: p.conf ? 162700 : null }; } };
}

export function keypair() { const sk = randomBytes(32); return { sk, pk: Buffer.from(schnorr.getPublicKey(sk)).toString('hex') }; }
export const BASE = 'https://testnet-stage.bitcoinarena.io/api/opr';
export function signIn(kp, { path, method = 'GET', body = '', createdAt, base = BASE }) {
  const tags = [['u', base + path], ['method', method]];
  if (method === 'POST') tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
  const e = { pubkey: kp.pk, created_at: createdAt, kind: 27235, tags, content: '' };
  e.id = eventId(e);
  e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), kp.sk)).toString('hex');
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`;
}

/** THE GAME'S OWN X LINK (kanban #3331, #3381): a row in the service's x_links, as POST /x saves it after the X lookup - the only link the game counts. */
export function gameLink(opr, pk, { userId, username = null, nowMs, follows = true }) {
  // kanban #3534: a saved link follows @bitcoinarena_io unless follows: false
  try { opr.db.prepare('INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms, follows, follows_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(String(pk), String(userId), String(username || userId), nowMs, nowMs, follows ? 1 : 0, nowMs); }
  catch (e) { return { ok: false, why: e.message }; }
  return { ok: true };
}

/** An X account proven for a key in a Season 2 book: a link code made for the key and posted from the account (proof 'code', kanban #3279). */
export function proveX(s2, pk, { userId, username = null, nowMs }) {
  const c = s2.makeCode(pk, { nowMs });
  if (!c.ok) return c;
  return s2.redeem(c.code, { platform: 'x', userId, username, nowMs });
}

/** A service on a fake clock: link(pk, linked) gives the key the game's own X link (kanban #3381: the only one that counts; linked false: none).
 *  A Season 2 book in memory is handed to the service as well (w.s2) - the service must ignore it (kanban #3381). */
export function world({ start = '2026-11-23T00:00:00Z', cfg = {}, chain = fakeChain(), s2On = true, lnCheck = null, xAccounts = null } = {}) {
  let t = at(start);
  const clock = { now: () => t, set: (ms) => { t = ms; }, add: (ms) => { t += ms; } };
  const lnd = fakeLnd();
  const s2 = s2On ? openBountySeason(':memory:') : null;
  const alerts = [], lines = [];
  let xn = 0;
  // the wallets' answers to a Lightning address check (#3250): every address is a good one unless set here ({ ok: false, why })
  const wallets = new Map(), lnAsked = [];
  const lnFake = async (a) => { lnAsked.push(a); return wallets.get(a) || { ok: true, address: a }; };
  // X on a fake (kanban #3331): xAccounts maps a lower-case handle to its userId; a handle not in it does not exist; 'down' answers no read
  // kanban #3534: every account follows @bitcoinarena_io unless its lower-case handle is in w.xNot
  const xs = xAccounts || new Map(), xAsked = [], xNot = new Set();
  const xLookup = async (name) => { xAsked.push(name); if (xs.get('*') === 'down') return { userId: null, member: null, why: 'x 503' };
    const id = xs.get(String(name).toLowerCase()); return id ? (xNot.has(String(name).toLowerCase()) ? { userId: id, username: name, member: false, why: 'does not follow' } : { userId: id, username: name, member: true, why: 'follows' }) : { userId: null, username: name, member: false, why: 'no such X account' }; };
  const opr = createOpr({ xLookup, botXHandles: () => new Set([...xs.keys()].filter((k) => k.startsWith('bot'))), lnCheck: lnCheck || lnFake, now: clock.now, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    invoices: lnd, chain, s2, alert: (x) => alerts.push(x), log: (m) => lines.push(m), cfg: { adminSha: createHash('sha256').update('letmein').digest('hex'), showTest: true, entrySats: 100, ...cfg } });   // the paid tests keep 100; free: cfg.entrySats 0 (#3273)
  const link = (pk, verified = true, username = null) => {
    xn++; if (!verified) return;
    const r = gameLink(opr, pk, { userId: `x${xn}`, username: username || `user${xn}`, nowMs: t });
    if (r.ok && !xs.has(String(username || `user${xn}`).toLowerCase())) xs.set(String(username || `user${xn}`).toLowerCase(), `x${xn}`);   // #3534: the account is on X (a re-check finds it)
    if (!r.ok) throw new Error(r.why);
  };
  return { opr, clock, lnd, chain, s2, alerts, lines, link, wallets, lnAsked, xs, xAsked, xNot };
}

/** Make the round ready: level, post, confirmation. */
export async function openRound(w, id = null) {
  await w.opr.tick(); await w.opr.tick();
  if (w.chain) { w.chain.confirm(); await w.opr.tick(); }
  return w.opr.roundRow(id || w.opr.currentRound().id);
}
/** A paid, started attempt: { attempt, token }. */
export async function paidAttempt(w, pk, round) {
  const s = await w.opr.startAttempt(pk, { round });
  if (!s.ok) return s;
  w.lnd.pay(s.invoice);
  const c = await w.opr.checkAttempt(pk, s.attempt);
  return { ...c, attempt: s.attempt };
}
export const logOf = (n, v = stubSim.GAME_VERSION, gap = 37) => ({ v, presses: Array.from({ length: n }, (_, i) => { const d = i * gap + 5 + ((i * 7) % 11); return [d, d + 5 + (i % 5)]; }) });
