// wf1489 sm5 page-3: a lost round's record never closes. The round's own wallet was read empty while its stake still waited (index.html lookRound
// writes arena.tabempty.<round> = 1); from then on lookRound looks through the player wallet's lockStatus alone, and lookOwed - handed no
// balance read - answers inTabMsat null (#1265: "a wallet not read is not empty"). Once the round settles (payout none, stake forfeited: gone)
// the look is final with nothing owed, so lookRound never joins the round's wallet again, and the page's own close
// (`lo.final && lo.inTabMsat === 0n && markCollectDone`) never holds: the record stays open for good - looked at every <= 10 min, its
// lock wallet never tidied (tidyStorage removes only done records' wallets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const now = BigInt(Date.now());
// settlementSlots 2: the settlement's threshold is 2 of 2
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const seed = b32(0x51);
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
const mine = toHex(refundKeyOf(player.pubkey));
const CLAIM_SECRET = b32(0x77);
const CLAIM_PK = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SECRET)]);
const STORED = 'c0'.repeat(32);   // the contract id the guardians hold at the lock's outpoint
const fields = { paymentImage: { kind: 'point', bytes: Uint8Array.from([0x03, ...b32(0x5e)]) }, amountMsat: 980000n, claimPk: CLAIM_PK, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
const realForfeit = toHex(schnorr.sign(fromHex(STORED), CLAIM_SECRET));
const FAKE = 'ab'.repeat(64);

/**
 * Seats: `say[host]` is what that seat answers - `settled` (its settlement pays `payees`), `forfeit` (a signature, or a refusal text).
 * Every seat names the same lock (findLock).
 */
const seats = (say) => async (url) => {
  const host = new URL(url).host;
  const s = say[host] || {};
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify(s.settled === false ? { state: 'NONE' }
    : { state: 'ACCEPTED', txid: s.txid || 'ef'.repeat(32), moved: { payouts: (s.payees || []).map((pk) => ({ kind: 'qualifier', pk, msat: '978000' })) } }), { status: 200 });
  if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  if (url.includes('/forfeit')) return /^[0-9a-f]{128}$/.test(String(s.forfeit || '')) ? new Response(JSON.stringify({ signature: s.forfeit, contractId: STORED, claimPk: toHex(CLAIM_PK) }), { status: 200 })
    : new Response(s.forfeit || 'not a qualifier', { status: 409 });
  return new Response('no', { status: 404 });
};
/** The federation as the player wallet reads it: the lock at its outpoint, `blocksLeft` before its expiry; the payout contract held too. */
const wallet = (blocksLeft) => ({
  async lockStatus() { return JSON.stringify({ block_count: 464 - blocksLeft, stored: { contract_id: STORED, blocks_left: blocksLeft } }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
});

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf("    const TAB_EMPTY = 'arena.tabempty.';");
const SRC = HTML.slice(at, HTML.indexOf('\n    }\n', HTML.indexOf('async function lookRound', at)) + '\n    }\n'.length);

test('a round lost after its wallet was read empty is closed once settled (payout none, stake gone)', async () => {
  const m = new Map();
  const storage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const ridHex = toHex(rid);
  PL.saveCollect(storage, { roundIdHex: ridHex, round, invite: 'fed11x', nodes: ['http://a.test', 'http://b.test'], seed, stakeLock: null });
  // seats: settled, paying another player; the lock named; no forfeit for this loser
  const winner = 'aa'.repeat(32);
  const fetcher = async (url) => {
    if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: winner, msat: '1960000' }] } }), { status: 200 });
    if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
    return new Response('not a qualifier', { status: 409 });
  };
  // the federation: the loser's stake was claimed by the settlement - nothing at its outpoint
  const player = { lockStatus: async () => JSON.stringify({ block_count: 400, stored: null }), withdrawableMsat: async () => '5000000', balanceMsat: async () => '5000000' };
  const FED = toHex(round.federationId);
  // the round's own wallet was read 0 on an earlier look (lookRound wrote the note)
  m.set('arena.tabempty.' + ridHex, '1');
  const window = { ARENA_WALLET_WARM: Promise.resolve(player), ARENA_WALLET_FEDERATION: FED, ARENA_LOCK_WASM: async () => ({ LockClient: {} }) };
  const ARENACLIENT = { toHex, lookOwed: PL.lookOwed };
  const joined = [];
  const roundWallet = async () => { joined.push(1); return { LockClient: {}, client: { ...player, withdrawableMsat: async () => '0', balanceMsat: async () => '0' } }; };
  const roundAsk = (r) => ({ round: r.round, roundId: fromHex(r.roundIdHex), invite: r.invite, seed: r.seed, curve: pageCurve, storage, nodes: r.nodes, fetcher });
  const lookRound = pageFunction(PAGE, ['vault', 'window', 'ARENACLIENT', 'roundAsk', 'roundWallet', 'performance'], SRC, 'return lookRound;')(
    () => storage, window, ARENACLIENT, roundAsk, roundWallet, { now: () => 60000 });
  const rec = PL.savedCollects(storage, {})[0];
  // the collect's passes, as index.html runs them for this record
  let closed = false, passes = 0;
  for (; passes < 3 && !closed; passes++) {
    const { look: lo } = await lookRound(rec);
    if (lo && lo.final && lo.inTabMsat === 0n && PL.markCollectDone(storage, ridHex, { payout: PL.owedToLine(lo), stake: null }, rec.seed, 0, { look: lo })) closed = true;
    if (passes === 0) console.log('  FACTS look:', JSON.stringify({ payout: lo.payout.state, stake: lo.stake.state, final: lo.final, owed: String(lo.owedMsat), inTabMsat: lo.inTabMsat === null ? null : String(lo.inTabMsat), joinedRoundWallet: joined.length }));
  }
  const after = PL.savedCollects(storage, {})[0];
  assert.ok(closed && after.done, `the settled, lost round is closed (after ${passes} passes: done=${JSON.stringify(after.done)})`);
});
