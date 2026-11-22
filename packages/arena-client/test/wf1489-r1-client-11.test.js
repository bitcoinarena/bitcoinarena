// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r1 client-11 (kanban #1489, bypass of #2108/#2123): the owed scan takes the FIRST signed /settled answer of a node key, from
// whatever URL served it, and never checks the answer's `since` against the one it asked. A stranger's URL listed before the honest
// seat (a lobby link's node=, or a seat whose key sorts first) replays that seat's own signed answer to `since=<far future>` - an empty
// list, signed by the honest key - and the honest seat's real list, which holds the round owed to this player, is never read.
// Safe behaviour: the owed round the honest seat lists is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signedSeats } from './settled-signed.js';

const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const contract = decodeRoundContract(fromHex(CONTRACT_HEX));
const id = toHex(roundId(contract));
const seed = new Uint8Array(32).fill(7);
const owedTo = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey));

test('wf1489-r1-client-11: a replayed signed empty /settled answer at another URL does not hide the honest seat\'s owed round', async () => {
  PL.forgetOwedRounds();
  const now = Date.now();
  const honest = 'https://tn4.bitcoin-arena.io/guardian-1';
  const evil = 'https://evil.example/x';
  const base = async (url) => {
    if (!url.startsWith(honest + '/')) return { ok: false, status: 404 };
    if (url.includes('/settled?')) {
      const since = Number(new URL(url).searchParams.get('since'));
      // the seat's own rule: rounds settled since max(asked, now - 7 d)
      const s = Math.max(since, now - 7 * 24 * 3600 * 1000);
      const rounds = [{ id, state: 'SETTLED', madeMs: String(now - 3600 * 1000), payouts: [owedTo], refunds: [] }].filter((r) => Number(r.madeMs) >= s);
      return { ok: true, status: 200, json: async () => ({ since: String(s), rounds }) };
    }
    if (url.includes('/round?id=')) return { ok: true, status: 200, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
    return { ok: false, status: 404 };
  };
  const signed = signedSeats(base, [honest]);
  // the attacker asks the honest seat once, publicly, for a time no round is settled after, and keeps its signed (empty) answer
  const replay = await (await signed.fetcher(`${honest}/settled?since=${now + 10 ** 12}`)).json();
  assert.equal(replay.rounds.length, 0);
  const fetcher = async (url, o) => (url.startsWith(evil + '/') && url.includes('/settled?')
    ? { ok: true, status: 200, json: async () => replay } : signed.fetcher(url, o));
  const control = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [honest], fetcher, bonded: signed.bonded, sinceMs: 0 });
  assert.equal(control.length, 1, 'control: the honest seat alone shows the owed round');
  PL.forgetOwedRounds();
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [evil, honest], fetcher, bonded: signed.bonded, sinceMs: 0 });
  console.log('  FACTS evil first, replayed signed empty answer: found', found.length);
  assert.deepEqual(found.map((f) => f.roundIdHex), [id], 'the honest seat\'s owed round was hidden by its own replayed empty answer');
});
