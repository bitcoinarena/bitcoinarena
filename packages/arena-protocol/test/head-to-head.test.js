// HEAD-TO-HEAD ROUNDS (kanban #233): the manifest's third result type, the entry's hidden move, its reveal, and every
// entry's result decided over all the reveals - mapped onto the engine's payout rule so settlement does not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  encodeManifestBody, encodeManifest, decodeManifest, manifestBodyId, roundFitsManifest, gameIdOf,
  RESULT_TYPE, PAYOUT_RULE, NO_PARENT, isHeadToHead, H2H_WIN_SCORE, H2H_DRAW_SCORE,
} from '../src/manifest.js';
import { encodeEntryContract, decodeEntryContract, entryId, COMMIT_MARKER } from '../src/contracts.js';
import { headToHeadCommit, revealStands, headToHeadResults, VERDICT, SALT_BYTES } from '../src/head-to-head.js';
import { computePayoutTable, DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const dev = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
};
const A = dev();
const signed = (body) => ({ ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), A.key)) });
const RPS = {
  gameName: 'rock-paper-scissors', gameDevPubkey: A.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.HEAD_TO_HEAD,
  cores: [{ hash: b32(0x21), configs: [b32(0x22)] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
  rankNumerator: 3, rankDenominator: 4, minScore: H2H_WIN_SCORE, clients: [b32(0xc1)], gameDonationSetId: b32(0xd0),
  players: 2, moveCount: 3, revealWindowMs: 60000n,
};

// ROCK 0, PAPER 1, SCISSORS 2: a beats b when a - b = 1 (mod 3)
const rps = (moves) => {
  const [a, b] = moves;
  if (a.move === b.move) return { [a.key]: VERDICT.DRAW, [b.key]: VERDICT.DRAW };
  const aWins = (a.move - b.move + 3) % 3 === 1;
  return { [a.key]: aWins ? VERDICT.WIN : VERDICT.LOSS, [b.key]: aWins ? VERDICT.LOSS : VERDICT.WIN };
};

test('a head-to-head manifest encodes, decodes to itself, and keeps its own terms', () => {
  const m = signed(RPS);
  const back = decodeManifest(encodeManifest(m));
  assert.equal(isHeadToHead(back), true);
  assert.deepEqual([back.players, back.moveCount, back.revealWindowMs], [2, 3, 60000n]);
  assert.deepEqual(encodeManifest(back), encodeManifest(m));
});

test('a head-to-head manifest names one decide adapter, no run, min_score 2, and bounded terms', () => {
  assert.throws(() => encodeManifestBody({ ...RPS, cores: [] }), /exactly one core/);
  assert.throws(() => encodeManifestBody({ ...RPS, runTicksMax: 10 }), /no run/);
  assert.throws(() => encodeManifestBody({ ...RPS, minScore: 1 }), /min_score is 2/);
  assert.throws(() => encodeManifestBody({ ...RPS, players: 1 }), /2 to 16 players/);
  assert.throws(() => encodeManifestBody({ ...RPS, moveCount: 1 }), /2 to 32 moves/);
  assert.throws(() => encodeManifestBody({ ...RPS, revealWindowMs: 5000n }), /reveal window/);
  assert.throws(() => encodeManifestBody({ ...RPS, payoutRule: PAYOUT_RULE.PARI_MUTUEL }), /rank curve/);
});

test('a round fits a head-to-head manifest by its adapter, config, curve and min_score - not by a run length', () => {
  const m = signed(RPS);
  const round = { gameId: gameIdOf(m), simCoreHash: b32(0x21), configHash: b32(0x22), blockTicks: 1, rankNumerator: 3, rankDenominator: 4, minScore: 2 };
  assert.deepEqual(roundFitsManifest(round, m), { ok: true, headToHead: true });
  assert.match(roundFitsManifest({ ...round, configHash: b32(0x99) }, m).why, /lists no config/);
  assert.match(roundFitsManifest({ ...round, minScore: 1 }, m).why, /below/);
});

test('the hidden move rides after the entry; an entry without one keeps its bytes and its id; never with a pick', () => {
  const base = {
    roundId: b32(9), playerPubkey: b32(1), sessionPubkey: b32(2), stakeCommitment: b32(3), stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(4), stakePoint: new Uint8Array(33).fill(2), feePreimage: b32(5),
    stakeLockOutpoint: { txid: b32(6), outIdx: 0n }, feeLockOutpoint: { txid: b32(7), outIdx: 1n }, claimKeyAttestationRef: b32(8),
  };
  const plain = encodeEntryContract(base);
  const commit = headToHeadCommit({ roundId: b32(9), entryKey: b32(2), move: 1, salt: new Uint8Array(SALT_BYTES).fill(7) });
  const hidden = encodeEntryContract({ ...base, commit });
  assert.deepEqual(hidden.subarray(0, plain.length), plain);
  assert.deepEqual([...hidden.subarray(plain.length, plain.length + 1)], [COMMIT_MARKER]);
  assert.deepEqual(decodeEntryContract(hidden).commit, commit);
  assert.equal(decodeEntryContract(plain).commit, undefined);
  assert.notDeepEqual(entryId({ ...base, commit }), entryId(base));
  // with donation outpoints too, the commitment still reads back
  const withDonations = { ...base, donationOutpoints: [{ txid: b32(0x0d), outIdx: 3n }], commit };
  assert.deepEqual(decodeEntryContract(encodeEntryContract(withDonations)).commit, commit);
  assert.throws(() => encodeEntryContract({ ...base, commit, pick: 1 }), /not both/);
});

test('a reveal stands only in its window, for a move the game offers, matching its own entry\'s commitment', () => {
  const salt = new Uint8Array(SALT_BYTES).fill(3);
  const at = { roundId: b32(9), entryKey: b32(2), moveCount: 3, entryCloseMs: 1000000n, revealWindowMs: 60000n };
  const commit = headToHeadCommit({ roundId: b32(9), entryKey: b32(2), move: 2, salt });
  assert.equal(revealStands({ ...at, commit, move: 2, salt, atMs: 1000001n }).ok, true);
  assert.match(revealStands({ ...at, commit, move: 2, salt, atMs: 999999n }).why, /only after entry close/);
  assert.match(revealStands({ ...at, commit, move: 2, salt, atMs: 1060001n }).why, /window closed/);
  assert.match(revealStands({ ...at, commit, move: 1, salt, atMs: 1000001n }).why, /not what this entry committed/);
  assert.match(revealStands({ ...at, commit, move: 3, salt, atMs: 1000001n }).why, /not one of the game's 3/);
  // another entry's commitment and reveal, copied, do not stand for this entry (the commitment names the session key)
  assert.match(revealStands({ ...at, entryKey: b32(5), commit, move: 2, salt, atMs: 1000001n }).why, /not what this entry committed/);
});

test('every pairing of rock, paper and scissors, a draw, a missing reveal and no reveals map onto the payout rule', () => {
  const names = ['rock', 'paper', 'scissors'];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const r = headToHeadResults([{ key: 'aa', move: a }, { key: 'bb', move: b }], rps);
    const want = a === b ? ['DRAW', 'DRAW'] : (a - b + 3) % 3 === 1 ? ['WIN', 'LOSS'] : ['LOSS', 'WIN'];
    const got = [r.aa, r.bb].map((x) => (x.outcome === DELIVERED && x.score === H2H_WIN_SCORE ? 'WIN'
      : x.outcome === DELIVERED && x.score === H2H_DRAW_SCORE ? 'DRAW' : x.outcome === FAILED ? 'LOSS' : x.outcome));
    assert.deepEqual(got, want, `${names[a]} vs ${names[b]}`);
  }
  assert.deepEqual(headToHeadResults([{ key: 'aa', move: 0 }, { key: 'bb', move: null }], rps),
    { aa: { outcome: DELIVERED, score: H2H_WIN_SCORE }, bb: { outcome: FORFEIT, score: 0 } });
  assert.deepEqual(headToHeadResults([{ key: 'aa', move: null }, { key: 'bb', move: null }], rps),
    { aa: { outcome: FORFEIT, score: 0 }, bb: { outcome: FORFEIT, score: 0 } });
});

test('the money: a win takes the loser\'s net stake, a draw keeps both stakes, a no-show pays the revealer', () => {
  const stake = { stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 50000n };      // net 900,000 each
  const table = (a, b) => {
    const r = headToHeadResults([{ key: 'aa', move: a }, { key: 'bb', move: b }], rps);
    const entries = [{ pubkey: b32(0xaa), ...stake, ...r.aa }, { pubkey: b32(0xbb), ...stake, ...r.bb }];
    const t = computePayoutTable({ roundId: b32(9), entries, minScore: H2H_WIN_SCORE });
    return { paid: t.table.map((x) => x.amountMsat), settling: t.settling.length };
  };
  assert.deepEqual(table(0, 2), { paid: [1800000n, 0n], settling: 2 }, 'rock beats scissors: the winner gets both net stakes');
  assert.deepEqual(table(1, 1), { paid: [0n, 0n], settling: 0 }, 'a draw: no stake moves - both locks return to their players');
  assert.deepEqual(table(2, null), { paid: [1800000n, 0n], settling: 2 }, 'a no-show forfeits to the revealer');
});

test('fewer entries than the game\'s players: the round is not played - every entry VOID, its stake back, no winner', () => {
  assert.deepEqual(headToHeadResults([{ key: 'aa', move: 0 }], rps, {}, { players: 2 }), { aa: { outcome: VOID, score: 0 } });
  assert.deepEqual(headToHeadResults([{ key: 'aa', move: null }], rps, {}, { players: 2 }), { aa: { outcome: VOID, score: 0 } });
  // the money: a VOID entry is a refund - outside the pot, paid nothing out of it
  const t = computePayoutTable({ roundId: b32(9), entries: [{ pubkey: b32(0xaa), stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 0n, outcome: VOID, score: 0 }], minScore: H2H_WIN_SCORE });
  assert.equal(t.activated.length, 0);
  assert.equal(t.settling.length, 0);
  // with both seated, a lone revealer still wins
  assert.equal(headToHeadResults([{ key: 'aa', move: 0 }, { key: 'bb', move: null }], rps, {}, { players: 2 }).aa.outcome, DELIVERED);
});
