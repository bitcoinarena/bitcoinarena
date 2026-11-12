// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1657 (the audit of 2026-11-12 found it again on f64efd1bb, which lacks the #1583 fix): this file is that run's test, kept beside wf1489-sm1-page-1.test.js.
// kanban #1489 state-machine audit, area page, finding 1: THE PAGE READS A SEAT'S 409 AS "THE SEAT TOOK NOTHING" EVEN FOR AN EXCHANGE THE SEAT
// ALREADY TOOK. The real seat (arena-node ecash-exchange.js) answers 409 "this seat holds no client of one of the two federations" for a row it
// already holds in TAKEN/SENDING while its client of the target federation is not open (a restart); the page (ecash-transfer.js
// advanceEcashExchange) moves its handed record to reclaiming(refusedBySeat), the federation answers Rejected (the seat reissued the notes), and
// the record goes to `refused` - terminal, never asked again. When the seat's client is back it would pay the same exchange; the page never asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEcashExchange } from '../../arena-node/src/ecash-exchange.js';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';
import { encodeEcash, A, B } from './ecash-1149-rig.js';

const NEED = 100000n;

test('wf1489-sm1-page-1: a seat that took the notes and answers a passing 409 is still asked for its answer - the exchange is never written off as refused', async () => {
  // ONE FEDERATION'S NOTES: bearer strings, whoever receives first gets them
  const live = new Map(); let salt = 100;
  const mint = (fed, msat) => { const e = encodeEcash(fed, msat, ++salt); live.set(e, { fed, msat: BigInt(msat) }); return e; };
  const bal = { player: new Map([[A, 500000n], [B, 0n]]), seat: new Map([[A, 0n], [B, 900000n]]) };
  const receiveInto = (who, fed) => async (e) => {
    const n = live.get(e);
    if (!n) return { state: 'Rejected' };
    if (n.fed !== fed) throw new Error('WrongFederation');
    live.delete(e); bal[who].set(fed, bal[who].get(fed) + n.msat);
    return { state: 'Success', msat: n.msat };
  };
  // THE PLAYER'S TWO WALLETS (the 1.9 lock client: no sentEcash, receive says no amount)
  const playerWallet = (fed) => ({
    sendEcash: async (m) => { const msat = BigInt(m); if (bal.player.get(fed) < msat) throw new Error('insufficient'); bal.player.set(fed, bal.player.get(fed) - msat); return JSON.stringify({ msat: Number(msat), ecash: mint(fed, msat) }); },
    receiveEcash: async (e) => { const r = await receiveInto('player', fed)(e); return JSON.stringify({ state: r.state }); },
  });
  const wallets = { [A]: playerWallet(A), [B]: playerWallet(B) };
  // THE REAL SEAT: its ports; the payout of B fails once (the federation did not answer), and after a restart its client of B is not open for a while
  const sent = new Map(); let payFails = 1; let bOpen = true;
  const port = (fed) => ({
    ecashReceive: async (e) => { const r = await receiveInto('seat', fed)(e); return r.state === 'Success' ? { state: 'Success', msat: r.msat } : r; },
    ecashBalance: async () => bal.seat.get(fed),
    ecashSend: async (pay, { key }) => {
      if (payFails > 0) { payFails--; throw new Error('federation 4d4d4d4d did not answer'); }
      bal.seat.set(fed, bal.seat.get(fed) - BigInt(pay)); const out = { ecash: mint(fed, pay), msat: BigInt(pay) }; sent.set(key, out); return out;
    },
    ecashSent: async (key) => (sent.has(key) ? { found: true, ...sent.get(key), msat: String(sent.get(key).msat) } : { found: false }),
  });
  const seat = createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => (f === B && !bOpen ? null : port(f)) });
  // server.js's door: 200 JSON, else text with the status
  const fetcher = async (url, o = {}) => {
    const u = new URL(url);
    const r = !o.method || o.method === 'GET' ? { ok: true, ...(await seat.offer(String(u.searchParams.get('federations') || '').split(','))) } : await seat.exchange(JSON.parse(o.body));
    return r.ok ? { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }
      : { ok: false, status: r.status || 409, json: async () => { throw new Error('text'); }, text: async () => r.why };
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const put = (s, k, v) => s.setItem(k, v);
  const total = () => bal.player.get(A) + bal.player.get(B);

  // 1. THE EXCHANGE: the seat takes the player's notes of A, its payout of B fails (503) - the record stays handed, the seat named
  const first = await exchangeEcashInto({ storage, from: A, to: B, needMsat: NEED, seats: ['http://s1'], walletFrom: wallets[A], walletTo: async () => wallets[B], fetcher, put, nowMs: 1000 });
  assert.equal(first.ok, false);
  const key = [...store.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  assert.equal(readEcashTransfer(storage, key).state, 'handed');
  assert.equal(total(), 400000n, 'the seat holds the player\'s 100 sat of A');

  // 2. THE SEAT RESTARTS; its client of B is not open yet. The page's next pass (a minute later) asks the same seat with the same notes.
  bOpen = false;
  await resumeEcashExchanges({ storage, keys: [...store.keys()], walletFor: async (f) => wallets[f], fetcher, seats: ['http://s1'], nowMs: 61000, put });
  const mid = readEcashTransfer(storage, key);

  // 3. THE SEAT'S CLIENT IS BACK; the page's next pass
  bOpen = true;
  await resumeEcashExchanges({ storage, keys: [...store.keys()], walletFor: async (f) => wallets[f], fetcher, seats: ['http://s1'], nowMs: 121000, put });
  const after = readEcashTransfer(storage, key);

  assert.notEqual(mid && mid.state, 'refused', `the seat holds the notes (the seat's row is still unpaid there); a passing 409 wrote the exchange off as refused: ${JSON.stringify(mid && { state: mid.state, seatSaid: mid.seatSaid })}`);
  assert.equal(after, null, `the exchange finished when the seat could pay: record ${JSON.stringify(after && { state: after.state, why: after.why })}`);
  assert.equal(total(), 500000n, `every sat back with the player (A ${bal.player.get(A)}, B ${bal.player.get(B)} msat)`);
});
