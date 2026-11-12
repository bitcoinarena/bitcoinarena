// #1489 a44 refute 91-s2-1 (kanban #1844/#2186 variant, game developer role): A LEGAL DRAWN MARKET WITH A 3 H PERIOD IS NEVER SIGNED.
// manifest.js seriesPeriodFits takes any market period a day divides (3 h: 8 a day) and attestDrawFits puts no bound on it, so a game
// developer may publish "BTC Up or Down 3h" with drawn attestors. drawn-attestor.js read() prunes to KEEP_MS (2 h) unless a round is
// DUE - and server.js due() lists a round only once its window has ENDED. During a 3 h window nothing is due, so the reading a minute
// before its start is pruned (memory and drawn_samples) 2 h in; at the end no seat can read the price to beat, none signs, and the
// market goes VOID although all seven read the whole window. The same holds for every period above 2 h - 60 s (4 h, 6 h, 12 h, 1 day).
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DrawnAttestor, DUE_AFTER_END_MS } from '../src/drawn-attestor.js';
import { decodeAttestation, attestationStands, marketWindowOf } from '../../arena-protocol/src/attested.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, seriesPeriodFits, attestDrawFits } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const PERIOD = 3n * 3600000n;
const ROUND = new Uint8Array(32).fill(0x52);
const secretOf = (i) => { const s = new Uint8Array(32); s[31] = i + 1; return s; };
const KEYS = Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(secretOf(i))));
const MANIFEST = {
  gameName: 'up-down-3h-drawn', gameDevPubkey: new Uint8Array(32).fill(9), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: PERIOD, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: new Uint8Array(32), outcomes: ['Up', 'Down'], attestors: [], attestThreshold: 0,
  attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: 2,
};
const verify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };

test('#1489 a44 refute 91-s2-1: seven drawn seats that read a whole 3 h window (a legal period) sign it', async () => {
  assert.ok(seriesPeriodFits(MANIFEST).ok, 'a 3 h market period is legal');
  assert.ok(attestDrawFits(MANIFEST.attestDraw, MANIFEST).ok, 'drawn attestors on it are legal');
  const W = marketWindowOf({ entryCloseMs: 2n * PERIOD }, MANIFEST).window;      // [3 h, 6 h)
  const dir = mkdtempSync(join(tmpdir(), 'a44r91s2-'));
  let clock = 0; const held = new Map(); const list = [];
  // server.js due(): a round is due once its window ended, until DUE_AFTER_END_MS after
  const due = () => (Number(W.endMs) <= clock && Number(W.endMs) > clock - DUE_AFTER_END_MS ? [{ roundId: ROUND, window: W }] : []);
  for (let i = 0; i < 7; i++) list.push(new DrawnAttestor({
    db: new DatabaseSync(join(dir, `seat-${i}.sqlite`)), selfKey: KEYS[i], sign: (d) => schnorr.sign(d, secretOf(i)), verify,
    attestorsFor: () => KEYS, peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due,
    readPrice: () => ({ cents: clock < Number(W.startMs) ? 8000000 : 8001234, atMs: clock }), now: () => clock,
    hold: async (bytes) => { const s = attestationStands(decodeAttestation(bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS }); if (s.ok) held.set(i, s); return s.ok; },
    fetcher: async (url) => { const j = Number(new URL(url).host.split('-')[1]); const w = list[j].served(ROUND); return w ? { status: 200, json: async () => w } : { status: 404, json: async () => null }; },
  }));
  // every seat reads every 10 s from 5 min before the window to 2 min after its end, passing as server.js does
  for (clock = Number(W.startMs) - 300000; clock <= Number(W.endMs) + 120000; clock += 10000) { for (const a of list) await a.read(); for (const a of list) await a.pass(); }
  console.log('  MEASURED: words', list.map((a) => (a.served(ROUND) ? 'S' : '-')).join(''), '| held at', held.size, '| seat 0 earliest kept reading', String(list[0].samples[0]?.atMs), 'ms (needed: in force at', String(W.startMs - 60000n), ')');
  for (let i = 0; i < 7; i++) assert.ok(list[i].served(ROUND), `seat ${i} read the whole 3 h window and signs no word: the reading a minute before its start was pruned at KEEP_MS while the round was not yet due`);
  assert.ok(held.size >= 5, `held at ${held.size} seats: the market is VOID`);
});
