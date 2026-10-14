// TOP-N PRIZE SPLITS (kanban #362 feature 3): a payout rule a replayed game's manifest may pick - fixed shares of the pot over
// its top places ([10000] winner takes all, [5000, 3000, 2000]) - encoded so every existing manifest keeps its bytes and its
// game id, required to name protocol version 4 (#349), and computed by the one F every caller shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import {
  encodeManifestBody, encodeManifest, decodeManifest, manifestBodyId, gameIdOf, manifestStands, roundFitsManifest,
  payoutSharesOf, payoutRuleForRound, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, PAYOUT_SHARES_MARKER, REQUIRED_VERSION_MARKER,
} from '../src/manifest.js';
import {
  computePayoutTable, payoutSharesFit, remainderOrder, encodePayoutTable, payoutTableId, decodePayoutTable,
  PAYOUT_SHARES_MAX, PAYOUT_SHARES_TOTAL,
} from '../src/payout.js';
import { lockActions } from '../src/lock-action.js';
import { slashHoldsOnTable, payoutInputsId, TABLE_IS_NOT_F } from '../src/slash.js';
import { TOP_SPLIT_VERSION, speaksVersion } from '../src/constants.js';
import { toHex, fromHex } from '../src/hash.js';
import { KNOWN_GOOD_GAMES } from '../src/known-games.js';
import { NEXTBLOCK_MANIFEST_HEX } from '../../nextblock/plugin/nextblock-manifest.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { MANIFEST_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { RPS_MANIFEST_HEX } from '../../rock-paper-scissors/plugin/rps-manifest.js';
import { UPDOWN_TN4_MANIFEST_HEX } from '../../btc-updown/plugin/updown-tn4-manifest.js';
import { HELLO_WORLD_MANIFEST_HEX } from '../../hello-world/plugin/hello-world-manifest.js';

const b32 = (n) => new Uint8Array(32).fill(n);

// ---- every existing manifest keeps its bytes and its game id ----

// THE IDS AS MAIN COMPUTED THEM BEFORE THIS RULE (origin/main a3f31b4f), written out rather than recomputed: a decoder that
// moved a byte would agree with itself and not with these.
const LIVE = [
  ['nextblock v1', NEXTBLOCK_MANIFEST_HEX, '495516ae59539661062cd72fd8716afbb378bd386297ab09b20aba0a2cd44150'],
  ['nextblock v2 (requires 2026.0.2)', MANIFEST_V2_HEX, 'c693585b01cef147f311e39c304f7b40f99774afc032f58db35ef8094cfa78dc'],
  ['rock-paper-scissors', RPS_MANIFEST_HEX, '1e9ab4b7d402d51f46def727e6db58da0ad70c4afafc295c82357d612543cd50'],
  ['btc-updown-15m testnet4', UPDOWN_TN4_MANIFEST_HEX, '672415c814e61b47ce038cd7f9a9431be8b41123c59502c371d5cd6a79c7684f'],
  ['hello-world', HELLO_WORLD_MANIFEST_HEX, '32ee1aa45e485eb2bc6b35d118a79f9724ab8019a0ceeb71eda45a84200c130f'],
];

test('every live manifest decodes, re-encodes to its exact bytes and keeps its game id; none pays by a top split', () => {
  for (const [name, hex, id] of LIVE) {
    const m = decodeManifest(fromHex(hex));
    assert.equal(toHex(encodeManifest(m)), hex.toLowerCase(), `${name}: its bytes`);
    assert.equal(toHex(gameIdOf(m)), id, `${name}: its game id`);
    assert.equal(m.payoutShares, undefined, `${name}: names no shares`);
    assert.equal(payoutSharesOf(m), null, `${name}: pays by its own rule, not a split`);
  }
  assert.equal(toHex(NEXTBLOCK_GAME_ID), LIVE[0][2], 'NEXTBLOCK_GAME_ID unchanged');
  for (const id of [LIVE[0][2], LIVE[1][2]]) assert.ok(KNOWN_GOOD_GAMES[id], `${id.slice(0, 8)} still pinned`);
});

// ---- the manifest ----

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd25519 = (sig, msg, key) => verify(null, Buffer.from(msg),
  createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const { privateKey: DEV_KEY, publicKey } = generateKeyPairSync('ed25519');
const DEV_PUB = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const signed = (body) => ({ ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV_KEY)) });

const CURVE = {
  gameName: 'derby', gameDevPubkey: DEV_PUB, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY,
  cores: [{ hash: b32(1), configs: [b32(0x10)] }], runTicksMax: 600, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
  rankNumerator: 3, rankDenominator: 4, minScore: 5, clients: [b32(0xc1)], gameDonationSetId: b32(0xd0),
};
const SPLIT = { ...CURVE, payoutRule: PAYOUT_RULE.TOP_SPLIT, payoutShares: [5000, 3000, 2000], requiredProtocolVersion: TOP_SPLIT_VERSION };

test('a top split encodes after its marker, before the required version, and decodes to itself', () => {
  assert.equal(PAYOUT_RULE.TOP_SPLIT, 3);
  assert.equal(TOP_SPLIT_VERSION, 4);
  assert.equal(speaksVersion(TOP_SPLIT_VERSION), true);
  const m = signed(SPLIT);
  const bytes = encodeManifest(m);
  const curveBody = encodeManifestBody(CURVE);
  const body = encodeManifestBody(SPLIT);
  // the curve's body, its rule byte moved to 3, then: marker, u16 count, three u16 shares, then the version's marker and u16
  assert.equal(body.length, curveBody.length + 1 + 2 + 3 * 2 + 3);
  const at = curveBody.length;
  assert.equal(body[at], PAYOUT_SHARES_MARKER);
  assert.deepEqual([...body.subarray(at + 1, at + 9)], [0, 3, 0x13, 0x88, 0x0b, 0xb8, 0x07, 0xd0]);
  assert.equal(body[at + 9], REQUIRED_VERSION_MARKER);
  const back = decodeManifest(bytes);
  assert.deepEqual(back.payoutShares, [5000, 3000, 2000]);
  assert.equal(back.payoutRule, PAYOUT_RULE.TOP_SPLIT);
  assert.equal(back.requiredProtocolVersion, TOP_SPLIT_VERSION);
  assert.equal(toHex(encodeManifest(back)), toHex(bytes));
  assert.equal(toHex(gameIdOf(back)), toHex(gameIdOf(m)));
  assert.deepEqual(payoutSharesOf(back), [5000, 3000, 2000]);
  // winner takes all is one share
  const wta = decodeManifest(encodeManifest(signed({ ...SPLIT, payoutShares: [10000] })));
  assert.deepEqual(wta.payoutShares, [10000]);
  const stands = manifestStands(m, { verify: verifyEd25519 });
  assert.equal(stands.ok, true, stands.why);
});

test('a top split\'s bytes must carry their marker: stripped, the manifest does not read', () => {
  const bytes = encodeManifest(signed(SPLIT));
  const at = encodeManifestBody(CURVE).length;
  const stripped = new Uint8Array([...bytes.subarray(0, at), ...bytes.subarray(at + 9)]);
  assert.throws(() => decodeManifest(stripped));
  // and a marker that is not the shares' is refused by name
  const wrong = bytes.slice(); wrong[at] = 0x07;
  assert.throws(() => decodeManifest(wrong), /carries its shares after their marker/);
});

test('the shares are 1 to 10 basis-point shares, non-increasing, summing to 10000', () => {
  assert.equal(PAYOUT_SHARES_MAX, 10);
  assert.equal(PAYOUT_SHARES_TOTAL, 10000);
  assert.equal(payoutSharesFit([10000]).ok, true);
  assert.equal(payoutSharesFit([5000, 3000, 2000]).ok, true);
  assert.equal(payoutSharesFit(Array(10).fill(1000)).ok, true, 'ten equal places');
  assert.equal(payoutSharesFit([4000, 3000, 3000]).ok, true, 'equal neighbours are not an increase');
  const bad = [
    [[], /1 to 10 shares/], [Array(11).fill(909).concat([]), /1 to 10 shares/], [null, /1 to 10 shares/],
    [[3000, 5000, 2000], /never pays a lower place more/], [[5000, 3000, 1999], /come to 10000 bps .* 9999/],
    [[5000, 3000, 2001], /10001/], [[10000, 0], /1 to 10000/], [[5000.5, 4999.5], /whole number/],
    [[10001, -1], /1 to 10000/], [['10000'], /whole number/],
  ];
  for (const [s, why] of bad) {
    const f = payoutSharesFit(s);
    assert.equal(f.ok, false, JSON.stringify(s));
    assert.match(f.why, why);
    // the encoder refuses each, and manifestStands answers with the same reason
    assert.throws(() => encodeManifestBody({ ...SPLIT, payoutShares: s }), why);
    const st = manifestStands({ ...SPLIT, payoutShares: s, signature: new Uint8Array(64) }, { verify: verifyEd25519 });
    assert.equal(st.ok, false);
    assert.match(st.why, why);
  }
});

test('a top split requires protocol version 4 or later, one this build speaks; no other rule names shares', () => {
  for (const v of [undefined, null, 1, 3])
    assert.throws(() => encodeManifestBody({ ...SPLIT, requiredProtocolVersion: v }), /requires protocol version 2026\.0\.4 or later/);
  assert.ok(encodeManifestBody({ ...SPLIT, requiredProtocolVersion: 7 }));
  const tooNew = signed({ ...SPLIT, requiredProtocolVersion: 7 });
  const st = manifestStands(tooNew, { verify: verifyEd25519 });
  assert.equal(st.ok, false);
  assert.match(st.why, /top split under protocol version \?\.\?\.7, which this build does not speak/);
  // shares on the curve, and the split on a market or a head-to-head game, are refused
  assert.throws(() => encodeManifestBody({ ...CURVE, payoutShares: [10000] }), /only a game paid by a top split/);
  assert.throws(() => encodeManifestBody({ ...CURVE, payoutShares: [] }), /only a game paid by a top split/);
  const rps = decodeManifest(fromHex(RPS_MANIFEST_HEX));
  assert.throws(() => encodeManifestBody({ ...rps, payoutRule: PAYOUT_RULE.TOP_SPLIT, payoutShares: [10000], requiredProtocolVersion: 4 }),
    /head-to-head game pays by the rank curve/);
  const updown = decodeManifest(fromHex(UPDOWN_TN4_MANIFEST_HEX));
  assert.throws(() => encodeManifestBody({ ...updown, payoutRule: PAYOUT_RULE.TOP_SPLIT, payoutShares: [10000], requiredProtocolVersion: 4 }),
    /attested game pays by the pari-mutuel rule/);
  // and a split still names a curve the round must match (the contract carries it), held to the curve's rule
  assert.throws(() => encodeManifestBody({ ...SPLIT, rankNumerator: 4 }), /rank curve/);
});

test('a round fits a top-split game only at protocol version 4 or later', () => {
  const m = signed(SPLIT);
  const id = gameIdOf(m);
  const round = (v) => ({ gameId: id, protocolVersion: v, simCoreHash: b32(1), configHash: b32(0x10), blockTicks: 600,
    rankNumerator: 3, rankDenominator: 4, minScore: 5 });
  const v3 = roundFitsManifest(round(3), m, id);
  assert.equal(v3.ok, false);
  assert.match(v3.why, /requires protocol version 2026\.0\.4; that round runs 2026\.0\.3/);
  assert.equal(roundFitsManifest(round(4), m, id).ok, true);
});

test('payoutRuleForRound: the manifest the round names gives the rule; a v4 round with none is refused, an older one is the curve', () => {
  const m = signed(SPLIT);
  const c = { gameId: gameIdOf(m), protocolVersion: 4, minScore: 5 };
  assert.deepEqual(payoutRuleForRound(c, m), { ok: true, payoutShares: [5000, 3000, 2000] });
  const curve = signed(CURVE);
  assert.match(payoutRuleForRound(c, curve).why, /the manifest handed in is/);
  assert.match(payoutRuleForRound(c, null).why, /may pay by its game's top split, and no manifest/);
  assert.deepEqual(payoutRuleForRound({ ...c, protocolVersion: 3 }, null), { ok: true, payoutShares: null });
  assert.deepEqual(payoutRuleForRound({ gameId: gameIdOf(curve), protocolVersion: 4 }, curve), { ok: true, payoutShares: null });
});

// ---- the table ----

const ROUND = b32(0x01);
const entry = (n, outcome, score, { stake = 100000n, donation = 0n } = {}) =>
  ({ pubkey: b32(n), outcome, score, stakeMsat: stake, feeMsat: 0n, donationMsat: donation });
const winners = (k) => Array.from({ length: k }, (_, i) => entry(0x10 + i, 'DELIVERED', 1000 - i * 10));
const losers = (k, stake = 100000n) => Array.from({ length: k }, (_, i) => entry(0x80 + i, i % 2 ? 'FORFEIT' : 'FAILED', 0, { stake }));
const rowOf = (t, e) => t.table.find((r) => toHex(r.pubkey) === toHex(e.pubkey)).amountMsat;
const sum = (t) => t.table.reduce((s, r) => s + r.amountMsat, 0n);
const staked = (es) => es.reduce((s, e) => s + e.stakeMsat - e.feeMsat - e.donationMsat, 0n);

test('[10000]: the winner takes the whole pot with 1, 2, 3 and 10 qualifiers; every other qualifier gets its stake back', () => {
  for (const k of [1, 2, 3, 10]) {
    const w = winners(k);
    const es = [...w, ...losers(4)];
    const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [10000] });
    assert.equal(t.pool, 400000n);
    assert.equal(t.payingRanks, 1);
    assert.equal(rowOf(t, w[0]), 100000n + 400000n, `${k} qualifiers: first takes the pot`);
    for (const e of w.slice(1)) assert.equal(rowOf(t, e), 100000n, `${k} qualifiers: stake back only`);
    assert.equal(sum(t), staked(es));
  }
});

test('[5000, 3000, 2000]: 3 qualifiers split exactly 50/30/20; 10 pay the top 3; 2 and 1 take the unused shares pro rata', () => {
  const S = [5000, 3000, 2000];
  // three qualifiers, a pot of 1,000,000: exactly 500k / 300k / 200k on top of their stakes
  { const w = winners(3); const es = [...w, ...losers(10)];
    const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: S });
    assert.equal(t.pool, 1000000n);
    assert.deepEqual(w.map((e) => rowOf(t, e) - 100000n), [500000n, 300000n, 200000n]);
    assert.equal(sum(t), staked(es)); }
  // ten qualifiers: places 4 to 10 keep their stakes and no more
  { const w = winners(10); const es = [...w, ...losers(10)];
    const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: S });
    assert.equal(t.payingRanks, 3);
    assert.deepEqual(w.map((e) => rowOf(t, e) - 100000n), [500000n, 300000n, 200000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
    assert.equal(sum(t), staked(es)); }
  // two qualifiers: 5000/8000 and 3000/8000 of the pot - 62.5 % and 37.5 %
  { const w = winners(2); const es = [...w, ...losers(8)];
    const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: S });
    assert.equal(t.payingRanks, 2);
    assert.deepEqual(w.map((e) => rowOf(t, e) - 100000n), [500000n, 300000n]);
    assert.equal(sum(t), staked(es)); }
  // one qualifier: the whole pot
  { const w = winners(1); const es = [...w, ...losers(3)];
    const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: S });
    assert.equal(rowOf(t, w[0]), 100000n + 300000n); }
});

test('odd msat: each share floored, the leftover handed one msat at a time in ascending H(round_id || pubkey), the pot spent exactly', () => {
  const S = [5000, 3000, 2000];
  // a pot of 1001 msat: 500.5 / 300.3 / 200.2 -> floors 500 / 300 / 200, one msat left
  const w = [entry(0x31, 'DELIVERED', 900, { stake: 1000n }), entry(0x32, 'DELIVERED', 800, { stake: 1000n }), entry(0x33, 'DELIVERED', 700, { stake: 1000n })];
  const es = [...w, entry(0x90, 'FAILED', 0, { stake: 1001n })];
  const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: S });
  assert.equal(t.pool, 1001n);
  const first = remainderOrder(ROUND, w)[0];
  const want = new Map([[w[0], 500n], [w[1], 300n], [w[2], 200n]]);
  want.set(first, want.get(first) + 1n);
  for (const e of w) assert.equal(rowOf(t, e) - 1000n, want.get(e), `place of ${toHex(e.pubkey).slice(0, 4)}`);
  assert.equal(sum(t), staked(es));
  // two qualifiers on [5000, 3000, 2000], a pot of 7 msat: 7*5/8 = 4.375 -> 4, 7*3/8 = 2.625 -> 2, one msat left
  const two = w.slice(0, 2);
  const es2 = [...two, entry(0x90, 'FAILED', 0, { stake: 7n })];
  const t2 = computePayoutTable({ roundId: ROUND, entries: es2, minScore: 1, payoutShares: S });
  const first2 = remainderOrder(ROUND, two)[0];
  const got = two.map((e) => rowOf(t2, e) - 1000n);
  assert.deepEqual(got, two.map((e, i) => [4n, 2n][i] + (e === first2 ? 1n : 0n)));
  assert.equal(sum(t2), staked(es2));
  // ten equal places and a pot of 13 msat: 1 each, three msat left, to the first three of the remainder order
  const ten = Array.from({ length: 10 }, (_, i) => entry(0x40 + i, 'DELIVERED', 500, { stake: 10n }));
  const es3 = [...ten, entry(0x91, 'FORFEIT', 0, { stake: 13n })];
  const t3 = computePayoutTable({ roundId: ROUND, entries: es3, minScore: 1, payoutShares: Array(10).fill(1000) });
  const extra = new Set(remainderOrder(ROUND, ten).slice(0, 3));
  for (const e of ten) assert.equal(rowOf(t3, e) - 10n, extra.has(e) ? 2n : 1n);
  assert.equal(sum(t3), staked(es3));
});

test('ties are broken as the curve breaks them: equal scores by pubkey, ascending', () => {
  const a = entry(0x52, 'DELIVERED', 700), b = entry(0x51, 'DELIVERED', 700);
  const es = [a, b, ...losers(2)];
  const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [7000, 3000] });
  assert.equal(rowOf(t, b) - 100000n, 140000n, '0x51 sorts first and takes 1st place');
  assert.equal(rowOf(t, a) - 100000n, 60000n);
});

test('the net stake weights each place as it does the curve (22A pick A); equal nets cancel exactly', () => {
  // a 2 % donor in 1st place: its weight is 5000 * 98000 against 3000 * 100000 and 2000 * 100000
  const w = [entry(0x61, 'DELIVERED', 900, { donation: 2000n }), entry(0x62, 'DELIVERED', 800), entry(0x63, 'DELIVERED', 700)];
  const es = [...w, ...losers(10)];
  const t = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [5000, 3000, 2000] });
  const total = 5000n * 98000n + 3000n * 100000n + 2000n * 100000n;
  assert.equal(rowOf(t, w[0]) - 98000n >= (1000000n * 5000n * 98000n) / total, true);
  assert.equal(rowOf(t, w[0]) - 98000n <= (1000000n * 5000n * 98000n) / total + 1n, true);
  assert.equal(sum(t), staked(es));
});

test('no qualifier: the same table the curve computes', () => {
  const es = [entry(0x71, 'DELIVERED', 0), ...losers(3)];          // delivered below the floor keeps its stake
  const curve = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1 });
  const split = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [5000, 3000, 2000] });
  assert.equal(split.qualifiers, 0);
  assert.deepEqual(split.table, curve.table);
  assert.equal(split.pool, curve.pool);
  assert.deepEqual(split.settling, curve.settling);
  // and the lock verdict is the curve's too: losers and nobody to pay
  assert.throws(() => lockActions({ roundId: ROUND, entries: es.slice(1), minScore: 1, payoutShares: [10000] }), /operator would keep/);
});

test('the curve is untouched: no shares named is the curve, and a split is a different table', () => {
  const es = [...winners(8), ...losers(8)];
  const a = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1 });
  const b = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: null });
  assert.deepEqual(a.table, b.table);
  assert.equal(a.payingRanks, 2, '§18A: K = ceil(8 / 4)');
  const c = computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [5000, 3000, 2000] });
  assert.notDeepEqual(c.table, a.table);
  assert.throws(() => computePayoutTable({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [6000, 3000] }), /come to 10000/);
});

test('lockActions settles a split round by the split table: the losers\' locks are the pot', () => {
  const w = winners(3);
  const es = [...w, ...losers(4)];
  const h = lockActions({ roundId: ROUND, entries: es, minScore: 1, payoutShares: [5000, 3000, 2000] });
  assert.deepEqual(w.map((e) => rowOf(h.table, e) - 100000n), [200000n, 120000n, 80000n]);
  assert.equal(h.actions.filter((a) => a.action === 'CLAIM').length, 4);
});

// ---- F in a slash proof is the game's rule ----

test('slash row 3 recomputes F by the manifest\'s split: the honest split table stands, a curve table for it is slashed, no manifest is refused', () => {
  const m = signed(SPLIT);
  const NODE = b32(0x11), BOND = b32(0x55);
  const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
  const es = [...winners(3), ...losers(5)];
  const contract = { gameId: gameIdOf(m), protocolVersion: 4, minScore: 5 };
  const S = payoutSharesOf(m);
  const tableBytes = (shares) => encodePayoutTable({ roundId: ROUND,
    table: computePayoutTable({ roundId: ROUND, entries: es, minScore: 5, payoutShares: shares }).table });
  const ask = (bytes, over = {}) => slashHoldsOnTable({
    proof: { roundId: ROUND, playerPubkey: es[0].pubkey, nodePubkey: NODE, transcriptHash: payoutInputsId({ roundId: ROUND, entries: es, minScore: 5 }),
      signedResultId: payoutTableId(decodePayoutTable(bytes)), bondTxid: BOND, bondVout: 3 },
    signedTable: bytes, advert: { nodePubkey: NODE, bondTxid: BOND, bondVout: 3 }, committee, entries: es, contract, manifest: m, ...over });
  const honest = ask(tableBytes(S));
  assert.equal(honest.slashed, false, honest.why);
  assert.match(honest.why, /exactly F/);
  const curve = ask(tableBytes(null));
  assert.equal(curve.slashed, true, 'a curve table signed for a split round is not F');
  assert.equal(curve.offence, TABLE_IS_NOT_F);
  const blind = ask(tableBytes(S), { manifest: null });
  assert.equal(blind.slashed, false);
  assert.match(blind.why, /payout rule cannot be read/);
  const other = ask(tableBytes(S), { manifest: signed(CURVE) });
  assert.equal(other.slashed, false);
  assert.match(other.why, /the manifest handed in is/);
});
