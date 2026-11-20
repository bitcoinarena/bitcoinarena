// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 4) of #3069 / #3094 / #3096 / #3109 / #3110 / #3118-#3121 (146cee004) - THE HONEST PATH.
// 146cee004 reads a market round's service ONLY from the attestation bytes a trusted census seat keeps. A seat keeps ONE copy per body
// (round.putOutcomeAttestation: INSERT OR IGNORE by body id) - the first that stood. The drawn seats combine on a fixed 10 s pass
// (server.js setInterval 10000, phase fixed at process start) and the market windows end on the grid, so in every round the FIRST seat
// to hold 5 words is the 5th drawn seat in pass phase, and it combines exactly those 5 words (arena-attestor combine) and pushes them to
// every seat. The 6th and 7th drawn seats sign the same body a few seconds later; their 7-signature copy has the same body id and is
// ignored everywhere. So an honest drawn attestor whose pass phase is late signs EVERY round it is drawn for, its signature stands over
// the very body the round settled on - and the check reads "0 signed rounds" forever (the bounty never pays it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { attestationBodyId } from '../../arena-protocol/src/attested.js';
import { combine } from '../../arena-attestor/src/attestor.js';

const sec = (b) => new Uint8Array(32).fill(b);
const SECRET = sec(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET));
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000, RID = toHex(new Uint8Array(32).fill(0x41));
const SEAT1K = 'cc'.repeat(32);
const MATES = ['5a', '5b', '5c'].map((x) => x.repeat(32)), MU = ['https://m1.example', 'https://m2.example', 'https://m3.example'];
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '50000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  ...MATES.map((k, i) => ({ node: k, endpoint: MU[i], bondSats: '50000' }))];
const COMMITTEE = [NODE, SEAT1K, ...MATES];
// the 7 drawn attestors: six others and the node; in pass-phase order the node comes last
const DS = [0x61, 0x62, 0x63, 0x64, 0x65, 0x66].map(sec), DK = DS.map((s) => toHex(schnorr.getPublicKey(s)));
const DRAWN = [...DK, NODE];
const body = { roundId: fromHex(RID), outcome: 1, observedAtMs: BigInt(NOW - DAY - 60000) };
const id = attestationBodyId(body);
const wordOf = (s) => ({ body, key: toHex(schnorr.getPublicKey(s)), signature: toHex(schnorr.sign(id, s)) });
const verify = (sg, m, k) => schnorr.verify(sg, m, k);
const RECEIVED = NOW - DAY + 3600000;   // inside day 1 of the window

// what one seat keeps: the 5th-phase seat's copy arrives first, the 6th and 7th seats' fuller copies after it
const keptBy = () => {
  const round = new Round(openStore(':memory:'));
  const first = combine(DS.slice(0, 5).map(wordOf), { attestors: DRAWN, threshold: 5, verify });
  const later = combine([...DS.map(wordOf), wordOf(SECRET)], { attestors: DRAWN, threshold: 5, verify });
  assert.ok(first && later && later.signers === 7, 'both copies stand (5 and 7 drawn signatures over the same body)');
  const put = (bytes, at) => round.putOutcomeAttestation({ bodyId: id, roundId: fromHex(RID), outcome: 1, observedAtMs: body.observedAtMs, bytes, receivedMs: at });
  assert.equal(put(first.bytes, RECEIVED), true);
  put(later.bytes, RECEIVED + 4000);   // the node's own signature arrives in the 7-signature copy
  return round.attestationsBetween(NOW - DAY - (NOW % DAY), NOW - (NOW % DAY)).flatMap((r) => r.attestations.map(toHex));
};

test('#1489 r1120-4-s4-1: an honest drawn attestor that signed the standing body, late in pass phase, reads 0 signed', async () => {
  const trustedKept = keptBy(), mateKept = keptBy();
  const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);
  const r = await nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, nowMs: NOW,
    seats: ['https://seat1.example', 'https://node.example', ...MU],
    fetchJson: async (url) => {
      if (url.endsWith('/owner')) return { node: NODE, claimed: false };
      if (!url.includes('/served') || dayOf(url) !== 1) return { held: [] };
      const i = MU.findIndex((s) => url.startsWith(s));
      if (i >= 0) return { node: MATES[i], held: [{ roundId: RID, committee: COMMITTEE, finals: [], attestors: DRAWN, attestations: mateKept }] };
      if (url.startsWith('https://node.example')) return { node: NODE, held: [{ roundId: RID, committee: COMMITTEE, finals: [], attestors: DRAWN, attestations: mateKept }] };
      return { node: SEAT1K, held: [{ roundId: RID, committee: COMMITTEE, finals: [], attestors: DRAWN, attestations: trustedKept }] };
    } });
  const says = r.checks.find((x) => x.key === 'committees').says;
  console.log('  MEASURED r1120-4-s4-1:', says, 'passes:', r.passes);
  assert.match(says, /^1 committees/);
  assert.match(says, /1 signed/, `the node signed the body the round settled on (a drawn attestor), yet: ${says}`);
});
