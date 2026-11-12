// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 2 for fix:attest:1 (9e48b1b24): the fix makes priceAttestationStands and game-market collect safe against a
// seat's malformed signature string. The SAME seat-supplied malformed signature still travels another way: one committee seat answers
// the honest leader's POST /price-sign with a junk truthy signature ('a'). The leader's #ask takes any truthy signature, hold() counts it
// nothing (the threshold stands on the others) but KEEPS body.sigs raw - in memory, and in price_ends for an end (k 0 / close), so it
// survives a restart - and #handOut gives the junk to every seat. GET /price-samples then serves it to every page, whose sigsOf/hex2u8
// (src/arena-ui/index.html) runs String(h).match(/../g).map(...) - null for 'a' - and throws inside the wrapped core.step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
// the page's own two functions, exactly as it ships them
const pageSigsOf = new Function(`${PAGE.match(/function hex2u8\(h\) \{[^\n]*\}/)[0]}\n${PAGE.match(/function sigsOf\(list\) \{[^\n]*\}/)[0]}\nreturn sigsOf;`)();
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

function network({ now, dbs, junkSeat }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seats = [];
  const fetcher = async (url, o) => {
    const m = /^seat(\d)\/(price-sign|price-attested)$/.exec(url);
    const i = Number(m[1]), s = seats[i];
    let got = m[2] === 'price-sign' ? s.sign(JSON.parse(o.body)) : s.hold(JSON.parse(o.body));
    // THE ATTACKER: one committee seat answers the leader's ask with its key and a junk signature
    if (m[2] === 'price-sign' && i === junkSeat) got = { ok: true, key: toHex(keys[i].pubkey), signature: 'a' };
    return { ok: got.ok, status: got.ok ? 200 : got.status, json: async () => got };
  };
  const make = (i) => new PriceFeed({ identity: keys[i], get pubkey() { return keys[i].pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
    openRounds: () => [{ roundId: rid, contract: bytes }], db: dbs[i] }, { priceRound: () => true, readPrice: async () => 8297000, now, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`), log: () => {} });
  keys.forEach((_, i) => seats.push(make(i)));
  const order = decodeRoundContract(bytes).nodes.map(toHex);
  const seatOf = (i) => seats[keys.findIndex((k) => toHex(k.pubkey) === order[i])];
  return { seats, rid, keys, seatOf, restart: (i) => { seats[i] = make(i); return seats[i]; } };
}

test('wf1489-v1-refute-13-s2-1: one committee seat\'s junk /price-sign signature is not kept and served to every page (it throws there)', async () => {
  const t = START + 1 * 5000 + 300;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const probe = network({ now: () => t, dbs: dbs.map(() => new DatabaseSync(':memory:')), junkSeat: -1 });
  const leaderIdx = probe.seats.indexOf(probe.seatOf(2));
  const junkSeat = (leaderIdx + 1) % 7;
  const net = network({ now: () => t, dbs, junkSeat });
  for (const s of net.seats) await s.read();
  const rh = toHex(net.rid);
  const lead = await net.seatOf(2).leadSample(net.rid, 2);
  assert.equal(lead.ok, true, lead.why);
  const served = net.seats.filter((_, i) => i !== junkSeat).map((s) => (s.list(rh, 0).samples.find((x) => x.k === 2) || {}).sigs || []);
  const junk = served.flat().filter((x) => typeof x.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(x.signature));
  let pageThrew = null;
  for (const sigs of served) { try { pageSigsOf(sigs); } catch (e) { pageThrew = e.message; } }
  console.log('  wf1489-v1-refute-13-s2-1:', JSON.stringify({ leadSigned: lead.signed, seatsServing: served.filter((x) => x.length).length, junkServed: junk.length, pageThrew }));
  assert.equal(junk.length, 0, `honest seats serve ${junk.length} malformed signature(s) a committee seat handed the leader`);
  assert.equal(pageThrew, null, `the page's sigsOf threw on a served sample: ${pageThrew}`);
});
