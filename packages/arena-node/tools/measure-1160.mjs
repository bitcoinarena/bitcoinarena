// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1160 MEASURE: the e-cash exchange when an answer is lost - after the reissue of the player's notes, or after the seat's notes
// left. A fake federation pair as the stake-lock tool answers it (keyed sends in an operation log). Run with the module to measure:
//   node packages/arena-node/tools/measure-1160.mjs [path/to/ecash-exchange.js]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const mod = await import(pathToFileURL(resolve(process.argv[2] || new URL('../src/ecash-exchange.js', import.meta.url).pathname)).href);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32), NOTES = 'fedimintA'.padEnd(40, 'x');
const say = (k, v) => console.log(`#1160 ${k.padEnd(56)} ${v}`);
console.log(`#1160 module ${process.argv[2] || 'src/ecash-exchange.js'}`);

function seat({ lostReceive = 0, lostSend = 0 }) {
  const received = new Set(), log = new Map();
  let holds = 500_000n, n = 0;
  const ports = {
    [A]: { ecashBalance: async () => 0n, ecashReceive: async (e) => {
      if (received.has(e)) return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: 100_000n };
      received.add(e); if (lostReceive-- > 0) throw new Error('timed out'); return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n }; } },
    [B]: { ecashBalance: async () => holds, ecashSent: async (k) => (log.has(k) ? { found: true, ...log.get(k) } : { found: false }),
      ecashSend: async (m, { key = null } = {}) => { if (key && log.has(key)) return log.get(key);
        holds -= m; const out = { ecash: `fedimintB-${++n}`, msat: m }; if (key) log.set(key, out); if (lostSend-- > 0) throw new Error('timed out'); return out; } },
  };
  const x = mod.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
  const ask = () => x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' }).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
  return { ask, out: () => 500_000n - holds, received };
}
{
  const s = seat({ lostReceive: 1 });
  const a = await s.ask(), b = await s.ask();
  say('answer lost after the reissue: first ask', a.ok ? 'paid' : a.why);
  say('answer lost after the reissue: the retry', b.ok ? `paid ${b.msat} msat` : b.why);
  say('answer lost after the reissue: notes taken / paid out msat', `${s.received.size} / ${s.out()}`);
}
{
  const s = seat({ lostSend: 1 });
  const a = await s.ask(), b = await s.ask(), c = await s.ask();
  say('answer lost after the payout: first ask', a.ok ? 'paid' : a.why);
  say('answer lost after the payout: two retries', `${b.ok ? b.ecash : b.why}; ${c.ok ? c.ecash : c.why}`);
  say('answer lost after the payout: paid out msat', String(s.out()));
}
