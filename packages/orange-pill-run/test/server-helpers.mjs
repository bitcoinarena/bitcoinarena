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
    async lookup(hash) { const x = inv.get(hash); if (!x) throw new Error('unknown'); return { state: x.state, paidMsat: x.paidMsat }; },
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

/** A service on a fake clock, with a Season 2 book in memory: link(pk, verified) gives the key a linked X account. */
export function world({ start = '2026-11-23T00:00:00Z', cfg = {}, chain = fakeChain(), s2On = true } = {}) {
  let t = at(start);
  const clock = { now: () => t, set: (ms) => { t = ms; }, add: (ms) => { t += ms; } };
  const lnd = fakeLnd();
  const s2 = s2On ? openBountySeason(':memory:') : null;
  const alerts = [], lines = [];
  let xn = 0;
  const opr = createOpr({ now: clock.now, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    invoices: lnd, chain, s2, alert: (x) => alerts.push(x), log: (m) => lines.push(m), cfg: { adminSha: createHash('sha256').update('letmein').digest('hex'), showTest: true, ...cfg } });
  const link = (pk, verified = true, username = null) => {
    xn++; const r = s2.claimName(pk, 'x', { userId: `x${xn}`, username: username || `user${xn}` });
    if (!r.ok) throw new Error(r.why);
    if (verified) s2.record(pk, 'x', { member: true, nowMs: t });
  };
  return { opr, clock, lnd, chain, s2, alerts, lines, link };
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
