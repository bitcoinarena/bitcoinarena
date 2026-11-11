// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RIG OF kanban #1149 (e-cash in flight): the page's own ARENA_EXCHANGE_INTO lifted out of an index.html by its text and run against
// fake wallets that hold msat and hand out e-cash strings in the mintv2 format (each string a distinct bearer: whoever presents it first
// receives it, a second receive is Rejected), and fake seats with an offer (GET /exchange) and an exchange (POST /exchange). Shared by
// ecash-in-flight-1149.test.js and the old-vs-new measurement (tools/measure-1149.mjs), which runs the same scenarios on an older page.
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as TRANSFER from '../src/ecash-transfer.js';

// A MINTV2 E-CASH STRING, as fedimint encodes it: BigSize count, then each field a BigSize variant and a BigSize-length payload;
// variant 0 the federation id, variant 1 a note (denomination byte, 32-byte secret key, 48-byte compressed G1 signature)
const G1 = '97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb';
const B32 = '0123456789abcdefghijklmnopqrstuv';
const bigsize = (n) => (n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n >> 8, n & 0xff] : [0xfe, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const bytesOf = (hex) => hex.match(/../g).map((x) => parseInt(x, 16));
export function encodeEcash(fedHex, msat, salt = 1) {
  const denoms = [];
  for (let d = 0, m = BigInt(msat); m > 0n; d++, m >>= 1n) if (m & 1n) denoms.push(d);
  const fields = [[0, bytesOf(fedHex)], ...denoms.map((d, i) => [1, [d, ...new Array(31).fill(1), ((salt * 7 + i) % 250) + 1, ...bytesOf(G1)]])];
  const out = [...bigsize(fields.length)];
  for (const [v, body] of fields) out.push(...bigsize(v), ...bigsize(body.length), ...body);
  let s = '', buf = 0, bits = 0;
  for (const b of out) { buf |= b << bits; bits += 8; while (bits >= 5) { s += B32[buf & 31]; buf >>= 5; bits -= 5; } }
  if (bits > 0) s += B32[buf & 31];
  return 'fedimint' + s;
}

export const A = '33'.repeat(32), B = '4d'.repeat(32);

/**
 * One browser and its seats. `failWrite(key, value)` makes the browser refuse a write (QuotaExceededError); `seats` maps an origin to
 * { holds: { fed: msat }, post(body, mint) } - `mint(fed, msat)` hands the seat new e-cash of its own. `msatInReceive` answers the
 * face value in the receive (the 2.0 lock client) or not (the 1.9 one).
 */
export function exchangeRig({ html, seats, failWrite = null, msatInReceive = false, balances = { [A]: 1000000n, [B]: 0n }, sentLog = true }) {
  const store = new Map();
  const vault = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (failWrite && failWrite(k, String(v))) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); },
    removeItem: (k) => store.delete(k),
  };
  const proxy = new Proxy(vault, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
  const bal = new Map(Object.entries(balances).map(([f, m]) => [f, BigInt(m)]));
  const live = new Map();   // e-cash string -> { fed, msat } while nobody has received it
  const log = [], sendsByIntent = new Map();
  let salt = 0;
  const mint = (fed, msat) => { const e = encodeEcash(fed, msat, ++salt); live.set(e, { fed, msat: BigInt(msat) }); return e; };
  const wallet = (fed) => ({
    sendEcash: async (m, intent) => {
      const msat = BigInt(m);
      if ((bal.get(fed) || 0n) < msat) throw new Error('insufficient balance');
      bal.set(fed, bal.get(fed) - msat);
      const ecash = mint(fed, msat);
      if (intent) sendsByIntent.set(intent, { ecash, msat: String(msat) });
      log.push(['send', fed.slice(0, 2), String(msat)]);
      return JSON.stringify({ msat: Number(msat), ecash });
    },
    receiveEcash: async (e) => {
      const n = live.get(e);
      if (!n) { log.push(['receive', fed.slice(0, 2), 'Rejected']); return JSON.stringify({ state: 'Rejected' }); }
      if (n.fed !== fed) throw new Error('WrongFederation');
      live.delete(e); bal.set(fed, (bal.get(fed) || 0n) + n.msat);
      log.push(['receive', fed.slice(0, 2), 'Success', String(n.msat)]);
      return JSON.stringify(msatInReceive ? { state: 'Success', msat: Number(n.msat) } : { state: 'Success' });
    },
    ...(sentLog ? { sentEcash: async (intent) => JSON.stringify(sendsByIntent.get(intent) || null) } : {}),
  });
  const wallets = new Map([[A, wallet(A)], [B, wallet(B)]]);
  const seen = new Map();   // e-cash string -> the seats it was posted to
  const fetch = async (url, o = {}) => {
    const u = new URL(url);
    const seat = seats[u.origin];
    if (!seat) throw new Error('fetch failed');
    if (!o.method || o.method === 'GET') return { ok: true, status: 200, json: async () => ({ maxMsat: '1000000', holds: seat.holds || {} }), text: async () => '' };
    const body = JSON.parse(o.body);
    seen.set(body.ecash, [...(seen.get(body.ecash) || []), u.origin]);
    const said = await seat.post(body, { mint, take: (e) => { const n = live.get(e); if (!n) return null; live.delete(e); return n; } });
    if (said.throw) throw new Error(said.throw);
    return { ok: said.status === 200, status: said.status, json: async () => said.body, text: async () => String(said.body) };
  };
  const window = { ARENA_BROWSER_STORE: () => proxy, ARENA_WALLET_BALANCE: { parts: [{ federation: A, sats: Number((bal.get(A) || 0n) / 1000n), merging: 0, arriving: 0 }] }, ARENA_WALLETS: wallets };
  const text = html || readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const a = text.indexOf('    window.ARENA_EXCHANGE_INTO = async');
  const code = text.slice(a, text.indexOf('\n    };\n', a) + 7);
  const page = html ? null : new URL('../../../src/arena-ui/index.html', import.meta.url);
  const ARENACLIENT = { ...TRANSFER, fromHex: (h) => Buffer.from(h, 'hex'), rememberedInvite: () => 'inv' };
  const run = (page ? pageFunction(page, ['window', 'ARENACLIENT', 'fetch', 'AbortSignal', 'console'], [code], '')
    : new Function('window', 'ARENACLIENT', 'fetch', 'AbortSignal', 'console', code))(window, ARENACLIENT, fetch, { timeout: () => undefined }, { log: () => {} });
  void run;
  const kept = () => [...store.keys()].filter((k) => k.startsWith('arena.ecash.exchange.')).map((k) => ({ key: k, ...JSON.parse(store.get(k)) }));
  // EVERY MSAT ACCOUNTED FOR: in the two wallets, in strings nobody received yet (each counted once), never created or lost
  const unreceived = () => [...live.values()].reduce((t, n) => t + n.msat, 0n);
  return { window, log, seen, store, kept, bal, unreceived, live, exchange: (o) => window.ARENA_EXCHANGE_INTO({ toInvite: 'inv', seed: null, LockClient: null, ...o }) };
}

/** A seat that pays what it took (`short` msat less, if given), from its own notes of the round's federation. */
export const payingSeat = (holds, short = 0n) => ({ holds, post: async (b, { mint, take }) => {
  const n = take(b.ecash);
  if (!n) return { status: 409, body: 'that e-cash was spent before' };
  return { status: 200, body: { ok: true, msat: String(n.msat - short), ecash: mint(b.to, n.msat - short), federation: b.to } };
} });
/** A seat that refuses by its words (409) and takes nothing. */
export const refusingSeat = (holds) => ({ holds, post: async () => ({ status: 409, body: 'this seat holds 0 sat in federation 4d4d4d4d: too little' }) });
