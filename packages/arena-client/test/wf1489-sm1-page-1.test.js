// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1583 (#1489 sm1-page-2, state-machine audit, SM-C1 x SM-C2: the page's e-cash exchange against the seat's): A SEAT'S 409 IS NOT ALWAYS "TOOK NOTHING".
// The page reads every 400/404/409/429 of POST /exchange as the seat's refusal before it took anything (ecash-transfer.js SEAT_NOT_TAKEN):
// handed -> reclaiming(refusedBySeat) -> the notes received back -> Rejected -> `refused`, terminal, never asked again. But the seat answers
// 409 regardless of its row for some doors: "this seat holds no client of one of the two federations" (portOf null - a seat just restarted
// whose federation client is not up, a home federation whose guardians did not answer at boot), checked BEFORE the row's state. So an exchange
// the seat already TOOK (row SENDING: the player's notes reissued into the seat, its payout failed once - 503, asked again) meets that 409 on
// the page's retry after a seat restart: the page tries to take its notes back (Rejected - the seat holds them), marks the record refused and
// never asks again. The seat owes the payout for good; the player's sats are gone. Driven here: the page's own exchange code (ecash-transfer.js)
// against the seat's own (arena-node ecash-exchange.js) over one database across the seat's restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEcashExchange } from '../../arena-node/src/ecash-exchange.js';
import { exchangeEcashInto, resumeEcashExchanges, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';
import { encodeEcash, A, B } from './ecash-1149-rig.js';

const SEAT = 'https://seat-1.example';

test('wf1489-sm1-page-2: an exchange the seat took is not given up as refused when the restarted seat answers 409 "no client" on the retry', async () => {
  const live = new Map();   // bearer string -> { fed, msat } while nobody has received it
  let salt = 0;
  const mint = (fed, msat) => { const e = encodeEcash(fed, msat, ++salt); live.set(e, { fed, msat: BigInt(msat) }); return e; };
  // THE PLAYER'S WALLETS (the lock client: a send tagged by the record's key, its log read back by sentEcash)
  const bal = { [A]: 100000n, [B]: 0n }, sent = new Map();
  const wallet = (fed) => ({
    sendEcash: async (m, key) => { const msat = BigInt(m); if (bal[fed] < msat) throw new Error('insufficient balance'); bal[fed] -= msat; const ecash = mint(fed, msat); sent.set(key, { ecash, msat: String(msat) }); return JSON.stringify({ ecash, msat: Number(msat) }); },
    sentEcash: async (key) => JSON.stringify(sent.get(key) || null),
    receiveEcash: async (e) => { const n = live.get(e); if (!n) return JSON.stringify({ state: 'Rejected' }); if (n.fed !== fed) throw new Error('WrongFederation'); live.delete(e); bal[fed] += n.msat; return JSON.stringify({ state: 'Success', msat: Number(n.msat) }); },
  });
  const wallets = { [A]: wallet(A), [B]: wallet(B) };
  // THE SEAT'S TWO FEDERATION CLIENTS (the stake-lock tool): A reissues the player's notes, B pays its own out, keyed
  let seatA = 0n, seatB = 500000n, bAnswers = false, bPortUp = true;
  const received = new Map(), sendLog = new Map();
  const ports = {
    [A]: { ecashBalance: async () => seatA,
      ecashReceive: async (e) => { if (received.has(e)) return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: received.get(e) };
        const n = live.get(e); if (!n) return { state: 'Rejected' }; live.delete(e); seatA += n.msat; received.set(e, n.msat); return { state: 'Success', msat: n.msat }; } },
    [B]: { ecashBalance: async () => seatB,
      ecashSend: async (m, { key }) => { if (!bAnswers) throw new Error('federation B did not answer the send'); if (sendLog.has(key)) return sendLog.get(key);
        seatB -= m; const out = { ecash: mint(B, m), msat: m }; sendLog.set(key, out); return out; },
      ecashSent: async (key) => (sendLog.has(key) ? { found: true, ...sendLog.get(key) } : { found: false }) },
  };
  const db = new DatabaseSync(':memory:');
  const portOf = async (f) => (f === B && !bPortUp ? null : ports[f] || null);
  let seat = createEcashExchange({ db, portOf });
  const fetcher = async (url, o = {}) => {
    if (!o.method || o.method === 'GET') return { ok: true, status: 200, json: async () => ({ maxMsat: '1000000', holds: { [B]: String(seatB) } }) };
    const r = await seat.exchange(JSON.parse(o.body));
    return { ok: !!r.ok, status: r.ok ? 200 : r.status, json: async () => r, text: async () => String(r.why || '') };
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const T0 = 1_800_000_000_000;

  // 1. THE JOIN'S EXCHANGE: the seat takes the notes; its payout in B fails this once (503) - the page keeps the record handed
  const first = await exchangeEcashInto({ storage, from: A, to: B, needMsat: 100000n, seats: [SEAT], walletFrom: wallets[A], walletTo: async () => wallets[B], fetcher, nowMs: T0 });
  const key = [...store.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  const afterFirst = JSON.parse(store.get(key)).state;
  // 2. THE SEAT RESTARTS: same database; its client of B is not up yet (portOf null) - its federation B answers again
  seat = createEcashExchange({ db, portOf });
  bPortUp = false; bAnswers = true;
  // 3. THE PAGE IS RELOADED and resumes the exchange it keeps
  const resumed = await resumeEcashExchanges({ storage, keys: [...store.keys()], walletFor: async (f) => wallets[f], fetcher, seats: [SEAT], nowMs: T0 + 60000 });
  const afterRestart = JSON.parse(store.get(key) || 'null');
  // 4. THE SEAT'S CLIENT OF B IS UP; the page's next passes resume what it keeps
  bPortUp = true;
  for (const dt of [120000, 900000]) await resumeEcashExchanges({ storage, keys: [...store.keys()], walletFor: async (f) => wallets[f], fetcher, seats: [SEAT], nowMs: T0 + dt });
  const row = db.prepare('SELECT state FROM ecash_exchanges').get();
  const facts = { firstPass: { ok: first.ok, pending: !!first.pending, record: afterFirst }, retryAnswer: resumed[0] && resumed[0].why, recordAfterRetry: afterRestart && afterRestart.state,
    seatRow: row && row.state, seatHoldsPlayersNotesMsat: String(seatA), playerA: String(bal[A]), playerB: String(bal[B]), recordNow: (JSON.parse(store.get(key) || 'null') || {}).state || 'gone' };
  console.log('  FACTS sm1-page-2:', JSON.stringify(facts));
  assert.equal(seatA, 100000n, 'the seat took the player\'s 100 sat of A');
  assert.equal(bal[B] + bal[A], 100000n, `the seat took the player's 100 sat and the player holds ${bal[A] + bal[B]} msat of it in either federation: the page gave the exchange up as "refused" on a 409 the seat answered for a row it had taken, and never asks again (${JSON.stringify(facts)})`);
});
