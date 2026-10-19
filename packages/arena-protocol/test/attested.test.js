// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RESULT THAT IS NOT A REPLAY (§0A.7a; 2026-10-07: attestors named in the manifest, k of n,
// chosen by the game dev; the pari-mutuel rule): an attested game's manifest, the entry's pick, the outcome attestation and
// its refusals, the standing of a round on its attestations, and the pari-mutuel table to the msat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import {
  encodeManifest, decodeManifest, manifestBodyId, gameIdOf, manifestStands, roundFitsManifest, isAttested,
  RESULT_TYPE, PAYOUT_RULE, NO_PARENT,
} from '../src/manifest.js';
import {
  encodeAttestation, decodeAttestation, attestationBodyId, attestationStands, outcomeStanding, pariMutuelTable,
} from '../src/attested.js';
import { encodeEntryContract, decodeEntryContract, entryId, PICK_MARKER } from '../src/contracts.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd25519 = (sig, msg, key) => verify(null, Buffer.from(msg),
  createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
};
const DEV = keyPair();
// the manifest lists its attestors in key order (one encoding)
const ATTESTORS = [keyPair(), keyPair(), keyPair()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const OUTCOMES = ['above 100k', 'between', 'below 90k'];
const BODY = {
  gameName: 'btc-close', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: OUTCOMES, attestors: ATTESTORS.map((a) => a.pub), attestThreshold: 2,
};
const MARKET = { ...BODY, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(BODY)), DEV.key)) };
const ROUND = b32(0x77);
const attest = (body, by) => ({ ...body, signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) })) });
const stands = (a, roundIdBytes = ROUND) => attestationStands(decodeAttestation(encodeAttestation(a)), { manifest: MARKET, roundIdBytes, verify: verifyEd25519 });

test('an attested game\'s manifest: no core, no run, its outcomes, attestors and threshold, the pari-mutuel rule - and a replayed game\'s bytes unchanged', () => {
  const bytes = encodeManifest(MARKET);
  const back = decodeManifest(bytes);
  assert.deepEqual(encodeManifest(back), bytes);
  assert.deepEqual(back.outcomes, OUTCOMES);
  assert.equal(back.attestThreshold, 2);
  assert.equal(isAttested(back), true);
  assert.equal(manifestStands(back, { verify: verifyEd25519 }).ok, true);
  // a round of it names no core and no config
  const round = { gameId: gameIdOf(MARKET), simCoreHash: b32(0), configHash: b32(0) };
  assert.deepEqual(roundFitsManifest(round, MARKET), { ok: true, attested: true });
  assert.match(roundFitsManifest({ ...round, simCoreHash: b32(1) }, MARKET).why, /its rounds name no core and no config/);
  // its terms are held to what an attested game is
  const bad = (over) => () => encodeManifest({ ...MARKET, ...over });
  assert.throws(bad({ cores: [{ hash: b32(1), configs: [b32(2)] }] }), /names no core/);
  assert.throws(bad({ runTicksMax: 600 }), /no run/);
  assert.throws(bad({ payoutRule: PAYOUT_RULE.RANK_CURVE }), /pari-mutuel/);
  assert.throws(bad({ outcomes: ['only'] }), /2 to 16 outcomes/);
  assert.throws(bad({ outcomes: ['a', 'a'] }), /each outcome once/);
  assert.throws(bad({ attestThreshold: 4 }), /threshold is 1 to its 3/);
  assert.throws(bad({ attestors: [] }), /1 to 16 attestor keys/);
  // and a replayed game may not pick the pari-mutuel rule
  assert.throws(() => encodeManifest({ ...MARKET, resultType: RESULT_TYPE.REPLAY, cores: [{ hash: b32(1), configs: [b32(2)] }], runTicksMax: 600,
    rankNumerator: 3, rankDenominator: 4 }), /pays by the rank curve/);
});

test('the pick rides after the entry, and an entry without one keeps its bytes and its id', () => {
  const base = {
    roundId: ROUND, playerPubkey: b32(1), sessionPubkey: b32(2), stakeCommitment: b32(3), stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(4), stakePoint: new Uint8Array(33).fill(2), feePreimage: b32(5),
    stakeLockOutpoint: { txid: b32(6), outIdx: 0n }, feeLockOutpoint: { txid: b32(7), outIdx: 1n }, claimKeyAttestationRef: b32(8),
  };
  const plain = encodeEntryContract(base);
  const picked = encodeEntryContract({ ...base, pick: 2 });
  assert.deepEqual(picked.subarray(0, plain.length), plain, 'the pick is written after everything an entry already writes');
  assert.deepEqual([...picked.subarray(plain.length)], [PICK_MARKER, 2]);
  assert.equal(decodeEntryContract(picked).pick, 2);
  assert.equal(decodeEntryContract(plain).pick, undefined);
  assert.notDeepEqual(entryId({ ...base, pick: 1 }), entryId({ ...base, pick: 2 }), 'two picks are two entries');
  // with donation outpoints, the pick comes after them
  const both = { ...base, donationOutpoints: [{ txid: b32(9), outIdx: 2n }], pick: 0 };
  assert.deepEqual(decodeEntryContract(encodeEntryContract(both)).donationOutpoints, both.donationOutpoints);
  assert.equal(decodeEntryContract(encodeEntryContract(both)).pick, 0);
  assert.throws(() => encodeEntryContract({ ...base, pick: 256 }), /0 to 255/);
});

test('an attestation stands with k distinct named attestors; one short, a stranger, another round, an outcome out of range, a bad signature are each refused by name', () => {
  const body = { roundId: ROUND, outcome: 1, observedAtMs: 1791400000000n };
  const two = stands(attest(body, [ATTESTORS[0], ATTESTORS[2]]));
  assert.equal(two.ok, true, two.why);
  assert.equal(two.label, 'between');
  const said = {
    oneShort: stands(attest(body, [ATTESTORS[1]])).why,
    sameTwice: stands(attest(body, [ATTESTORS[1], ATTESTORS[1]])).why,
    stranger: stands(attest(body, [ATTESTORS[0], keyPair()])).why,
    otherRound: stands(attest(body, [ATTESTORS[0], ATTESTORS[1]]), b32(0x78)).why,
    outOfRange: stands(attest({ ...body, outcome: 3 }, [ATTESTORS[0], ATTESTORS[1]])).why,
    badSignature: stands({ ...attest(body, [ATTESTORS[0], ATTESTORS[1]]),
      signatures: [attest(body, [ATTESTORS[0]]).signatures[0], attest({ ...body, outcome: 0 }, [ATTESTORS[1]]).signatures[0]] }).why,
  };
  console.log('  REFUSALS:', JSON.stringify(said));
  assert.match(said.oneShort, /carries 1 attestor signature\(s\), and game "btc-close" asks 2 of its 3/);
  assert.match(said.sameTwice, /carries 1 attestor signature/);
  assert.match(said.stranger, /signed by key [0-9a-f]{16}, which game "btc-close" does not name as an attestor/);
  assert.match(said.otherRound, /is for round 7777777777777777, not this round 7878787878787878/);
  assert.match(said.outOfRange, /names outcome 3, out of range: game "btc-close" has 3 outcomes \(0 to 2\)/);
  assert.match(said.badSignature, /signature on that attestation does not verify/);
});

test('a round\'s standing: OPEN, ATTESTED on one outcome, DISPUTED on two - the pair is the proof', () => {
  const a = (outcome) => ({ roundId: ROUND, outcome, observedAtMs: 1n, signatures: [] });
  assert.deepEqual(outcomeStanding([]), { state: 'OPEN' });
  assert.deepEqual(outcomeStanding([a(1), a(1)]), { state: 'ATTESTED', outcome: 1 });
  const d = outcomeStanding([a(1), a(2)]);
  assert.equal(d.state, 'DISPUTED');
  assert.deepEqual(d.outcomes, [1, 2]);
  assert.match(d.why, /settles on neither/);
});

// THE RULE, WRITTEN OUT A SECOND TIME HERE (not read from attested.js): fee 5% (entryFeeMsat), donation as the entry says,
// net = stake - fee - donation; a winner gets its net plus floor(losing pool x its net / winning net), the leftover msats one
// each to the winners in entry-id order; nobody right: each net back.
function expected(entries, outcome) {
  const net = (e) => e.stakeMsat - e.feeMsat - e.donationMsat;
  const sorted = [...entries].sort((x, y) => (x.entryId < y.entryId ? -1 : 1));
  const win = sorted.filter((e) => e.pick === outcome);
  if (!win.length) return Object.fromEntries(sorted.map((e) => [e.entryId, net(e)]));
  const pool = sorted.filter((e) => e.pick !== outcome).reduce((t, e) => t + net(e), 0n);
  const wnet = win.reduce((t, e) => t + net(e), 0n);
  const out = Object.fromEntries(sorted.map((e) => [e.entryId, 0n]));
  let given = 0n;
  for (const e of win) { const share = (pool * net(e)) / wnet; out[e.entryId] = net(e) + share; given += share; }
  for (let i = 0, left = pool - given; left > 0n; i++, left--) out[win[i % win.length].entryId] += 1n;
  return out;
}
const entry = (n, stakeMsat, pick, donationBps = 500) => ({ entryId: n.toString(16).padStart(64, '0'), stakeMsat, feeMsat: entryFeeMsat(stakeMsat),
  donationMsat: (stakeMsat * BigInt(donationBps)) / 10000n, pick });

test('the pari-mutuel table balances to the msat: losers\' net stakes to the winners pro rata, everyone\'s net back when nobody is right, fee and donation as ', () => {
  const runs = [];
  // A THREE-OUTCOME MARKET: 6 entries, odd stakes, donations 0-5%
  const six = [entry(1, 1000000n, 0), entry(2, 3000000n, 1), entry(3, 2000000n, 0, 0), entry(4, 1333333n, 2, 300), entry(5, 777777n, 1, 100), entry(6, 5000000n, 2)];
  for (const outcome of [0, 1, 2]) runs.push({ name: `six, outcome ${outcome}`, entries: six, outcome });
  // nobody picked the outcome
  runs.push({ name: 'nobody right', entries: [entry(1, 1000000n, 0), entry(2, 2000000n, 0)], outcome: 1 });
  // one winner takes the whole losing pool; a free round (stake 0) pays nothing to anybody
  runs.push({ name: 'one winner', entries: [entry(1, 1000000n, 1), entry(2, 2000000n, 0), entry(3, 3000000n, 2)], outcome: 1 });
  runs.push({ name: 'odd msats', entries: [entry(1, 333333n, 0), entry(2, 333334n, 0), entry(3, 333335n, 0), entry(4, 1000001n, 1)], outcome: 0 });
  const rows = [];
  for (const r of runs) {
    const t = pariMutuelTable({ entries: r.entries, outcome: r.outcome });
    const want = expected(r.entries, r.outcome);
    for (const row of t.rows) assert.equal(row.payoutMsat, want[row.entryId], `${r.name}: entry ${row.entryId.slice(-1)}`);
    assert.equal(t.feesMsat + t.donationsMsat + t.payoutsMsat, t.grossMsat, `${r.name}: a msat of the gross went to nobody`);
    for (const row of t.rows) assert.equal(row.feeMsat, row.stakeMsat * 500n / 10000n, `${r.name}: the fee is 's 5%`);
    rows.push(`| ${r.name} | ${t.grossMsat} | ${t.feesMsat} | ${t.donationsMsat} | ${t.losingPoolMsat} | ${t.winningNetMsat} | ${t.refunded} | ${t.rows.map((x) => `${x.pick}:${x.payoutMsat}`).join(' ')} |`);
  }
  console.log(['  TABLES:', '| case | gross | fees | donations | losing pool | winning net | refunded | pick:payout |', ...rows].join('\n'));
  // the worked numbers of the six-entry market, outcome 2: losers 1, 2, 3, 5 pay entries 4 and 6
  const t = pariMutuelTable({ entries: six, outcome: 2 });
  // nets: 1 000 000 - 50 000 - 50 000; 3 000 000 - 150 000 - 150 000; 2 000 000 - 100 000; 777 777 - 38 888 - 7 777;
  // 1 333 333 - 66 666 - 39 999; 5 000 000 - 250 000 - 250 000
  assert.equal(t.losingPoolMsat, 900000n + 2700000n + 1900000n + 731112n);
  assert.equal(t.winningNetMsat, 1226668n + 4500000n);
  // floor(6 231 112 x 1 226 668 / 5 726 668) = 1 334 721, floor(6 231 112 x 4 500 000 / 5 726 668) = 4 896 390, 1 msat left
  // to the first winner by entry id (entry 4)
  assert.deepEqual(t.rows.filter((x) => x.won).map((x) => x.payoutMsat), [1226668n + 1334721n + 1n, 4500000n + 4896390n]);
  assert.equal(pariMutuelTable({ entries: [entry(1, 1000000n, 0), entry(2, 2000000n, 0)], outcome: 1 }).refunded, true);
  assert.throws(() => pariMutuelTable({ entries: [{ ...entry(1, 1000n, 0), feeMsat: 2000n }], outcome: 0 }), /more in fee and donation than it stakes/);
});
