// kanban #1489 round 3 (gossip): ONE PEER'S GET /book-certificates ANSWER PUTS A MADE-UP ENTRY INTO AN HONEST SEAT'S ROUND. For a batch k the
// reader already holds certified, order-batch.js #take replays every order the peer's record lists (cert.record.orders) without checking
// that record against the certificate held here - the peer's list is unsigned. replayOrder (server.js) then imports the peer's entry bytes
// (round.importEntry: only the hash to the id and the round are checked, no door, no entry close, no lock) before its locks are looked at,
// and a refused lock leaves the entry in the round. The safe behaviour: an order is replayed only when a certificate that verifies names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } from './plugins/updown/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { YES } from '../../arena-protocol/src/order-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeEntryContract, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const P = Number(UPDOWN_PERIOD_MS);
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0x90 + n), worldSecret: b32(0) });
const B = 500;

test('one peer\'s unsigned order list for a held batch does not import a made-up entry into the round', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks,
    endMs: testNow() + 1800000, serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  const nextK = async () => { const k = Math.floor(testNow() / B); while (testNow() < (k + 1) * B + 20) await wait(5); return k; };
  const realFetch = globalThis.fetch;
  try {
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w.c.entryCloseMs) - P) + 100);
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 60000n } });
    const kA = await nextK();
    const a = await w.nodes.find((d) => d.orderBook.leads(w.rid, kA)).orderBook.lead(w.rid, kA);
    assert.deepEqual([a.ok, a.certified], [true, true], a.why);
    const reader = w.nodes.find((d) => !d.orderBook.leads(w.rid, kA));
    const evil = w.nodes.find((d) => d !== reader);
    // a made-up entry of this round: the real one with another session key, so its id is new
    const [{ entryId: realId }] = reader.round.entriesOf(w.rid);
    const forged = decodeEntryContract(new Uint8Array(reader.round.entry(realId)));
    forged.sessionPubkey = b32(0xee);
    const forgedBytes = encodeEntryContract(forged);
    const forgedHex = toHex(entryId(forged));
    // THE BAD SEAT: its /book-certificates lists the held batch kA with the made-up order, its /entry hands the made-up bytes
    const was = reader.orderBook.fetcher;
    reader.orderBook.fetcher = async (u, opt) => {
      if (String(u).startsWith(base(evil)) && /\/book-certificates/.test(u))
        return new Response(JSON.stringify({ certificates: [{ record: { k: kA, orders: [forgedHex] }, signatures: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return was(u, opt);
    };
    globalThis.fetch = async (u, opt) => {
      if (String(u).startsWith(base(evil)) && String(u).includes(`/entry?id=${forgedHex}`)) return new Response(forgedBytes, { status: 200 });
      return realFetch(u, opt);
    };
    await reader.orderBook.sync(w.rid, { force: true });
    await wait(300);
    const imported = reader.round.entry(Buffer.from(forgedHex, 'hex'));
    console.log(`made-up entry ${forgedHex.slice(0, 16)} in the honest reader's round after one peer's answer: ${!!imported}; entries now ${reader.round.entriesOf(w.rid).length}`);
    assert.ok(!imported, 'an entry no certificate names was imported into the round from one peer\'s unsigned order list');
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
