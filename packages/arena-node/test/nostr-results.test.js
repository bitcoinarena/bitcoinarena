// RESULTS ON NOSTR (kanban #362 feature 2): a node signs one parameterized replaceable event (kind 30762, d = arena:result:<round>)
// with a settled round's public result. Built deterministically (same result, same bytes; the id NIP-01's hash; the signature
// BIP-340 by the node's key), published once per round to every relay named - retried with backoff, bounded per minute - kept by
// our relay newest per d, and served at /nostr-results by a real node exactly as it is published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket, { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildResultEvent, resultContent, nostrResults, publishRelays, RESULT_KIND, acceptedWithoutEvent } from '../src/nostr-results.js';
import { startRelay, eventId, eventRefusal, RELAY_KINDS } from '../src/nostr-relay.js';

const SECRET = new Uint8Array(32).fill(7);
const PUB = Buffer.from(schnorr.getPublicKey(SECRET)).toString('hex');
const h = (c) => c.repeat(64);
const resultFor = (round, extra = {}) => ({
  game: { name: 'rock-paper-scissors', id: h('a') }, round, federation: h('f'), stakeMsat: '100000', finalMs: 1760400000123,
  settlement: [{ federation: h('f'), txid: h('9') }], outcome: null,
  entries: [
    { entry: h('2'), player: h('c'), name: 'blue-otter-0042', federation: h('f'), outcome: 'DELIVERED', score: 3, pick: null, rank: 2, payoutMsat: '0' },
    { entry: h('1'), player: h('b'), name: 'alice', federation: h('f'), outcome: 'DELIVERED', score: 9, pick: null, rank: 1, payoutMsat: '95000' },
    { entry: h('3'), player: h('d'), name: 'red-fox-0001', federation: h('f'), outcome: 'VOID', score: null, pick: null, rank: null, payoutMsat: '0' },
  ],
  ...extra,
});

test('the event: canonical content, its tags, the id NIP-01\'s hash, a BIP-340 signature by the node, the same bytes every time', () => {
  const r = resultFor(h('e'));
  const e = buildResultEvent({ result: r, secret: SECRET });
  assert.equal(e.kind, RESULT_KIND);
  assert.equal(e.kind, 30762);
  assert.equal(e.pubkey, PUB);
  assert.equal(e.created_at, 1760400000, 'created_at is the FINAL time, in seconds');
  assert.deepEqual(e.tags.slice(0, 3), [['d', `arena:result:${h('e')}`], ['t', 'rock-paper-scissors'], ['g', h('a')]]);
  assert.equal(e.tags[3][0], 'alt');
  // the id is sha256 of [0, pubkey, created_at, kind, tags, content], computed here by hand
  const id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  assert.equal(e.id, id);
  assert.equal(eventId(e), id);
  assert.ok(schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex')), 'BIP-340 by the node');
  assert.equal(eventRefusal(e), null, 'our relay\'s own check passes it');
  // deterministic: the same result twice, and the entries handed in another order, give the same event byte for byte
  const again = buildResultEvent({ result: { ...r, entries: [...r.entries].reverse() }, secret: SECRET });
  assert.equal(JSON.stringify(again), JSON.stringify(e));
  // the content: fixed keys, ranked first in rank order, the unranked after, amounts as strings
  const c = JSON.parse(e.content);
  assert.deepEqual(Object.keys(c), ['v', 'game', 'round', 'federation', 'stakeMsat', 'finalAt', 'settlement', 'outcome', 'entries']);
  assert.equal(c.finalAt, '2025-10-14T00:00:00.123Z');
  assert.deepEqual(c.entries.map((x) => [x.name, x.rank, x.score, x.payoutMsat]),
    [['alice', 1, 9, '95000'], ['blue-otter-0042', 2, 3, '0'], ['red-fox-0001', null, null, '0']]);
  assert.deepEqual(Object.keys(c.entries[0]), ['entry', 'player', 'name', 'federation', 'outcome', 'score', 'pick', 'rank', 'payoutMsat']);
  assert.deepEqual(c.settlement, [{ federation: h('f'), txid: h('9') }]);
  // a changed result is a changed event; a market's pick and outcome are carried
  const m = JSON.parse(resultContent(resultFor(h('e'), { outcome: { index: 1, label: 'UP' },
    entries: [{ entry: h('1'), player: h('b'), name: 'alice', federation: null, outcome: 'WON', score: null, pick: 1, rank: null, payoutMsat: '5' }] })));
  assert.deepEqual(m.outcome, { index: 1, label: 'UP' });
  assert.equal(m.entries[0].pick, 1);
  assert.throws(() => resultContent({ ...r, round: 'xyz' }), /64 hex/);
  assert.deepEqual(publishRelays(' wss://relay.bitcoin-arena.io, https://no, ws://127.0.0.1:7777,wss://relay.bitcoin-arena.io'),
    ['wss://relay.bitcoin-arena.io', 'ws://127.0.0.1:7777']);
  assert.deepEqual(publishRelays(''), [], 'off by default');
});

// a relay that counts what it is sent and answers OK - or, while `silent`, answers nothing
async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const f = { got: [], silent: false, url: `ws://127.0.0.1:${wss.address().port}`,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] !== 'EVENT') return;
    f.got.push(m[1]);
    if (!f.silent) ws.send(JSON.stringify(['OK', m[1].id, true, '']));
  }));
  return f;
}

// the two settlement tables as the round store has them, and n rounds ACCEPTED in them
function settledDb(n, atMs) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lock_settlements (round_id BLOB PRIMARY KEY, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER);
    CREATE TABLE fed_lock_settlements (round_id BLOB, federation_id TEXT, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER, PRIMARY KEY (round_id, federation_id));`);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const rid = (i + 1).toString(16).padStart(2, '0').repeat(32);
    ids.push(rid);
    db.prepare('INSERT INTO lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(rid, 'hex'), h('9'), Buffer.alloc(1), Buffer.alloc(64), 'ACCEPTED', '', atMs + i);
  }
  return { db, ids };
}

test('each settled round is published once: a silent relay is asked again after its backoff, a round already published never again, at most perMinute a minute', async () => {
  let now = 1760400000000;
  const { db, ids } = settledDb(3, now - 1000);
  // a round still SUBMITTING and a round of another federation's settlement are not candidates until ACCEPTED
  db.prepare('INSERT INTO lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(h('7'), 'hex'), h('9'), Buffer.alloc(1), Buffer.alloc(64), 'SUBMITTING', '', now);
  const relay = await fakeRelay();
  const asked = [];
  const book = nostrResults({ db, secret: SECRET, relays: [relay.url], perMinute: 2, timeoutMs: 300, now: () => now, log: () => {},
    resultOf: (rid) => { asked.push(rid); return { ok: true, result: resultFor(rid, { finalMs: now }) }; } });
  try {
    assert.deepEqual(acceptedWithoutEvent(db, 0), ids, 'the ACCEPTED rounds without an event, oldest first');
    relay.silent = true;
    let t = await book.tick();
    assert.equal(t.sent, 2, 'two of three: at most perMinute (2) in a minute');
    assert.equal(relay.got.length, 2);
    assert.deepEqual(acceptedWithoutEvent(db, 0), [], 'every settled round has its event kept, published or not');
    const r1 = book.row(ids[0]);
    assert.equal(r1.publishedMs, null);
    assert.equal(r1.attempts, 1);
    assert.equal(r1.nextMs, now + 30000, 'the first retry 30 s on');
    assert.match(r1.why, /no answer/);
    // the same minute: nothing more is sent (the bound), and the silent rounds are not due yet
    relay.silent = false;
    now += 10000;
    t = await book.tick();
    assert.equal(t.sent, 0);
    // a minute on: the third round and the two retried ones are due; the bound lets two through, oldest first
    now += 60000;
    t = await book.tick();
    assert.equal(t.sent, 2);
    assert.ok(book.row(ids[0]).publishedMs && book.row(ids[1]).publishedMs);
    assert.deepEqual(book.row(ids[0]).relays, { [relay.url]: 'ok' });
    now += 61000;
    t = await book.tick();
    assert.equal(t.sent, 1);
    assert.ok(book.row(ids[2]).publishedMs);
    // published: never sent again, however often the clock runs; and each round was built once
    for (let i = 0; i < 3; i++) { now += 3600000; assert.equal((await book.tick()).sent, 0); }
    const perRound = new Map();
    for (const e of relay.got) perRound.set(e.tags[0][1], (perRound.get(e.tags[0][1]) || 0) + 1);
    assert.deepEqual([...perRound.values()].sort(), [1, 2, 2], 'the two first sent to a silent relay twice, the third once');
    assert.deepEqual([...new Set(relay.got.map((e) => e.id))].length, 3, 'a retry sends the same event, not a new one');
    assert.deepEqual(asked.sort(), [...ids].sort(), 'each result built once');
    // the door's event is the one published
    const got = book.eventFor(ids[0]);
    assert.ok(got.ok);
    assert.equal(got.event.id, relay.got.find((e) => e.tags[0][1].endsWith(ids[0])).id);
  } finally { book.stop(); await relay.close(); }
});

test('a relay that refuses is not asked again; one that never answers is given up after maxAttempts; no relays: nothing is sent', async () => {
  let now = 1760400000000;
  const { db, ids } = settledDb(1, now);
  const relay = await fakeRelay();
  relay.silent = true;
  const refusing = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => refusing.on('listening', r));
  let refusals = 0;
  refusing.on('connection', (ws) => ws.on('message', (raw) => { const m = JSON.parse(String(raw)); refusals++; ws.send(JSON.stringify(['OK', m[1].id, false, 'blocked: not this kind'])); }));
  const refUrl = `ws://127.0.0.1:${refusing.address().port}`;
  const book = nostrResults({ db, secret: SECRET, relays: [relay.url, refUrl], maxAttempts: 3, timeoutMs: 200, now: () => now, log: () => {},
    resultOf: (rid) => ({ ok: true, result: resultFor(rid) }) });
  const off = nostrResults({ db: settledDb(1, now).db, secret: SECRET, relays: [], now: () => now, resultOf: (rid) => ({ ok: true, result: resultFor(rid) }) });
  try {
    for (let i = 0; i < 6; i++) { await book.tick(); now += 3600000; }
    const row = book.row(ids[0]);
    assert.equal(row.attempts, 3, 'given up after maxAttempts');
    assert.equal(row.publishedMs, null);
    assert.equal(relay.got.length, 3);
    assert.equal(refusals, 1, 'a refusal is that relay\'s answer, kept');
    assert.match(row.relays[refUrl], /^refused: blocked/);
    assert.equal((await off.tick()).sent, 0);
    off.start();   // no relays: no clock either
  } finally { book.stop(); off.stop(); await relay.close(); for (const c of refusing.clients) c.terminate(); await new Promise((r) => refusing.close(r)); }
});

test('our relay keeps kind 30762 newest per node and d, checks it like any kind, and names it in NIP-11', async () => {
  assert.ok(RELAY_KINDS.includes(RESULT_KIND));
  const r = await startRelay({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
  await new Promise((x) => ws.on('open', x));
  const inbox = [];
  ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  const next = async (pred) => { for (const t = Date.now(); Date.now() - t < 2000; await new Promise((x) => setTimeout(x, 10))) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; } return null; };
  try {
    const first = buildResultEvent({ result: resultFor(h('e'), { finalMs: 1760400000000 }), secret: SECRET });
    const corrected = buildResultEvent({ result: resultFor(h('e'), { finalMs: 1760400060000, stakeMsat: '200000' }), secret: SECRET });
    const other = buildResultEvent({ result: resultFor(h('d')), secret: SECRET });
    for (const e of [first, corrected, other]) { ws.send(JSON.stringify(['EVENT', e])); assert.equal((await next((m) => m[0] === 'OK' && m[1] === e.id))[2], true); }
    ws.send(JSON.stringify(['EVENT', first]));
    assert.match((await next((m) => m[0] === 'OK' && m[1] === first.id))[3], /newer one is kept/);
    const forged = { ...other, content: other.content.replace('alice', 'mallory') };
    ws.send(JSON.stringify(['EVENT', forged]));
    assert.match((await next((m) => m[0] === 'OK' && m[1] === forged.id))[3], /hash/);
    ws.send(JSON.stringify(['REQ', 's', { kinds: [RESULT_KIND], authors: [PUB], '#d': [`arena:result:${h('e')}`] }]));
    const got = await next((m) => m[0] === 'EVENT' && m[1] === 's');
    assert.equal(got[2].id, corrected.id, 'the newer of the same d replaced the older');
    assert.ok(await next((m) => m[0] === 'EOSE'));
    assert.equal(inbox.filter((m) => m[0] === 'EVENT').length, 0);
    ws.send(JSON.stringify(['REQ', 'g', { kinds: [RESULT_KIND], '#t': ['rock-paper-scissors'] }]));
    await next((m) => m[0] === 'EOSE' && m[1] === 'g');
    assert.equal(r.events().filter((e) => e.kind === RESULT_KIND).length, 2, 'one per d: the other round\'s stays');
    const info = await (await fetch(`http://127.0.0.1:${r.port}/`, { headers: { accept: 'application/nostr+json' } })).json();
    assert.ok(info.kinds.includes(30762));
    assert.match(info.description, /round results \(kind 30762\)/);
  } finally { ws.close(); await r.close(); }
});

// A REAL NODE: its door says 409 before the settlement is ACCEPTED, then serves the signed event of the round it holds - the
// game it hosts, the entry's signed outcome and score, the share the settlement paid - the same event on every ask, and the one
// its publisher sends to the relay named, once.
test('a real node: /nostr-results serves the event it publishes once its settlement is ACCEPTED', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { Client } = await import('../../arena-client/src/client.js');
  const { HOSTED } = await import('./plugins/hosted.js');
  const { NEXTBLOCK_GAME_ID, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } = await import('../../nextblock/plugin/nextblock.js');
  const { TEST_FEDERATION_ID } = await import('../../arena-protocol/src/test-federation.js');
  const { BLOCK_TICKS } = await import('../../nextblock/src/rules/gate.js');
  const { TEST_DONATION_SET_REGTEST } = await import('../../arena-protocol/src/test-donation-sets.js');
  const { donationSetId } = await import('../../arena-protocol/src/donation.js');
  const { toHex } = await import('../../arena-protocol/src/hash.js');
  const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { createRequire } = await import('node:module');
  const core = createRequire(import.meta.url)('../../nextblock/dist/blwp-core.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const session = ed25519.utils.randomSecretKey();
  const relay = await fakeRelay();
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, funded: () => true, nostrPublish: [relay.url], nostrTickMs: 100 });
  try {
    const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign: (id) => ed25519.sign(id, session), verify: () => true });
    const rid = await client.openRound({
      networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n,
      blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
    });
    const eid = await client.join({
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    });
    const door = () => fetch(`http://127.0.0.1:${node.port}/nostr-results?round=${toHex(rid)}`);
    let res = await door();
    assert.equal(res.status, 409, 'no event before the settlement is ACCEPTED');
    assert.match(await res.text(), /not ACCEPTED/);
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/nostr-results?round=zz`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/nostr-results?round=${h('0')}`)).status, 404);
    // the entry's result as its signer node signed it, and the settlement ACCEPTED with its share paid
    const signed = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 42, transcriptHash: b32(3), simCoreHash: TRUCK_CORE_HASH, nodePubkey: node.round.pubkey };
    const body = encodePlayerResult(signed);
    node.round.putResult(Buffer.from(rid), Buffer.from(eid), Buffer.from(node.round.pubkey), Buffer.from(resultId(signed)), Buffer.from(joinSignedResult(body, new Uint8Array(64))));
    node.round.putLockSettlement({ roundId: rid, txid: h('9'), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
    node.round.putLockSettlementShares(rid, [{ pubkey: b32(5), msat: 12345n }]);
    res = await door();
    assert.equal(res.status, 200);
    const e = await res.json();
    assert.equal(eventRefusal(e), null, 'id and signature check out');
    assert.equal(e.pubkey, toHex(node.round.pubkey), 'signed by the node\'s own key');
    assert.deepEqual(e.tags.slice(0, 3), [['d', `arena:result:${toHex(rid)}`], ['t', 'nextblock'], ['g', toHex(NEXTBLOCK_GAME_ID)]]);
    const c = JSON.parse(e.content);
    assert.equal(c.round, toHex(rid));
    assert.equal(c.federation, toHex(TEST_FEDERATION_ID));
    assert.deepEqual(c.settlement, [{ federation: toHex(TEST_FEDERATION_ID), txid: h('9') }]);
    assert.equal(c.entries.length, 1);
    assert.deepEqual({ ...c.entries[0], name: undefined }, { entry: toHex(eid), player: toHex(b32(5)), name: undefined, federation: toHex(TEST_FEDERATION_ID),
      outcome: 'DELIVERED', score: 42, pick: null, rank: 1, payoutMsat: '12345' });
    assert.ok(c.entries[0].name.length > 0, 'a display name');
    // the same event on every ask, and the publisher sends it to the relay once
    const again = await (await door()).json();
    assert.equal(JSON.stringify(again), JSON.stringify(e));
    for (let i = 0; i < 100 && !relay.got.length; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(relay.got.length, 1, 'published once');
    assert.equal(relay.got[0].id, e.id);
    res = await door();
    assert.notEqual(res.headers.get('x-nostr-published'), 'no');
  } finally { await node.close(); await relay.close(); }
});
