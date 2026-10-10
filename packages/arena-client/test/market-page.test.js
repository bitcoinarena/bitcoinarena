// A MARKET IN THE PAGE (kanban #206 slice 2, §0A.7a; the owner 2026-10-07 decisions A and B, plan 777): the pick sheet, the
// pick handed to the seats, the join that ends 'picked', and an outcome the page believes only once it verifies.
//   - the sheet: one button per outcome from the page's PINNED list (not a node), the stake, the 5% fee and the 0-5% donation
//     lines; Cancel ends it and makes nothing; an unpinned market asks the second confirmation and stakes nothing without it;
//   - the pick: the entry carries it and every seat is handed the entry, the stake lock and the fee lock;
//   - picked: the lobby's join ends in state 'picked' before any of the session's globals are set - Unity adopts only
//     'joining'/'joined' (SplashScreen.cs AdoptNextJoin, DailyLobby.cs AfterJoin), so no run starts;
//   - the outcome: an attestation signed by the pinned attestors is verified; one by a key the page does not pin, or one this
//     browser cannot check, is shown UNVERIFIED and no win or loss is said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sign as edSign } from 'node:crypto';
import { pickSheet, marketForRound, submitPick, checkAttestation, marketLines } from '../src/market.js';
import { entryFor, playerFor } from '../src/join.js';
import { pageFunction } from './page-script.js';
import { MARKET, MARKET_OUTCOMES } from '../../arena-node/test/plugins/market/index.js';
import { testAttestedGame, testDevKey } from '../../arena-node/test/plugins/sign.js';
import { encodeAttestation, attestationBodyId, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const PAGE_URL = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const PAGE = readFileSync(PAGE_URL, 'utf8');
const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND_ID = b32(0x77);
const CONTRACT = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), networkId: NETWORK_ID_REGTEST, stakeMsat: 1_000_000n };
const signBody = (body, keys) => ({ ...body, signatures: keys.map((k) => ({ key: k.pubkey, signature: new Uint8Array(edSign(null, Buffer.from(attestationBodyId(body)), k.key)) })) });

test('the sheet: the pinned market\'s outcomes, the stake, the market\'s fees (0.5 % + 0.5 % by default, due at resolution); an unpinned market needs the second confirmation', () => {
  const market = marketForRound(CONTRACT);
  assert.ok(market && market.known, 'the regtest market is not pinned');
  assert.deepEqual(market.outcomes, MARKET_OUTCOMES);
  const sheet = pickSheet({ market, stakeMsat: CONTRACT.stakeMsat });
  console.log('  SHEET:', JSON.stringify({ title: sheet.title, outcomes: sheet.outcomes.map((o) => o.label), lines: sheet.lines, confirm: sheet.confirm }));
  assert.deepEqual(sheet.outcomes.map((o) => o.label), ['above 100k', 'between', 'below 90k']);
  assert.equal(sheet.lines.stake, 'stake 1,000 sats');
  // THE MARKET'S OWN RATES (kanban #235, the owner 2026-10-09: 0.5 % + 0.5 % by default), BOTH DUE AT RESOLUTION: one fee of 1 %,
  // in the fee lock, nothing donated at entry
  assert.equal(sheet.lines.fee, 'fees 1%: 10 sats - 0.5% nodes + 0.5% donation (half to the protocol devs, half to btc-close\'s dev), '
    + 'due once your pick is in at entry close - cancel before that costs nothing; back in full if the market is void or nobody picked right');
  assert.equal(sheet.lines.donation, undefined);
  assert.equal(sheet.lines.net, 'at risk on your pick: 990 sats');
  assert.equal(sheet.feeMsat, entryFeeMsat(CONTRACT.stakeMsat, 100));
  assert.equal(sheet.donationMsat, 0n);
  assert.equal(sheet.confirm, null);
  // pinned for regtest only: a testnet4 round of it is refused by the entry, as a game the page does not know
  assert.throws(() => entryFor({ ...CONTRACT, networkId: NETWORK_ID_TESTNET4, id: ROUND_ID, custody: 'FEDERATION', federationId: b32(9) },
    { seed: b32(1), curve: null, random: () => b32(2) }), /pinned only for network 9855e6790b51f0a6: refused on this one/);
  // AN UNPINNED MARKET: read from the manifest a seat serves, only when it is the round's game, and it needs the confirmation
  const other = testAttestedGame({ name: 'eth-close', outcomes: ['up', 'down'] }).registration;
  const round2 = { ...CONTRACT, gameId: other.gameId };
  assert.equal(marketForRound(round2), null, 'an unpinned market without its manifest');
  assert.equal(marketForRound(round2, { manifestBytes: encodeManifest(MARKET.registration.manifest) }), null, 'another game\'s manifest was taken');
  const unpinned = marketForRound(round2, { manifestBytes: encodeManifest(other.manifest) });
  assert.equal(unpinned.needsConfirm, true);
  assert.match(pickSheet({ market: unpinned, stakeMsat: 1_000_000n }).confirm, /^eth-close is not on this page's list of known markets\. Its developer key is [0-9a-f]{16}… and its manifest [0-9a-f]{16}…/);
});

/** A fake DOM enough for the page's sheet: elements with children, classes, text, data and click handlers. */
function fakeDocument() {
  const make = (tag) => {
    const el = { tag, children: [], className: '', dataset: {}, handlers: {}, _text: '', type: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      append(...xs) { this.children.push(...xs); },
      addEventListener(ev, f) { this.handlers[ev] = f; },
      click() { if (this.handlers.click) this.handlers.click(); },
      querySelector(sel) { return sel === '.sheet' ? sheet : null; },
      get textContent() { return this._text || this.children.map((c) => c.textContent).join(' '); },
      set textContent(t) { this._text = t; this.children = []; },
    };
    return el;
  };
  const sheet = make('div');
  const root = make('div');
  return { document: { getElementById: (id) => (id === 'blwp-pick' ? root : null), createElement: make }, root, sheet };
}
function liftSheet(window, document) {
  const at = PAGE.indexOf('    async function openPickSheet(');
  assert.ok(at > 0, 'index.html has no openPickSheet');
  const end = PAGE.indexOf('\n    }\n', at);
  const BLWPCLIENT = { marketForRound, pickSheet, roundPays: (c) => c.stakeMsat > 0n, toHex };
  return pageFunction(PAGE_URL, ['window', 'document', 'BLWPCLIENT', 'donationBps', 'fetch', 'AbortSignal'], PAGE.slice(at, end + 6), 'return openPickSheet;')(
    window, document, BLWPCLIENT, () => 500, window.fetch, { timeout: () => undefined });
}
const buttons = (el) => el.children.flatMap((c) => (c.tag === 'button' ? [c] : buttons(c)));

test('the page\'s sheet: drawn from the pinned list, Cancel makes nothing, a choice is the pick the join takes; an unpinned one waits for the confirmation', async () => {
  const id = toHex(ROUND_ID);
  // PINNED
  let picked = [];
  const window = { confirm: () => { throw new Error('a pinned market asked a confirmation'); }, fetch: async () => { throw new Error('a pinned market fetched a manifest'); } };
  let dom = fakeDocument();
  const open = liftSheet(window, dom.document);
  await open(CONTRACT, id, ['http://seat-a'], (i) => picked.push(i));
  const shown = buttons(dom.sheet);
  console.log('  PAGE SHEET:', JSON.stringify({ shown: dom.root.classList.contains('show'), buttons: shown.map((b) => b.textContent), said: window.BLWP_PICK_SHEET.lines }));
  assert.equal(dom.root.classList.contains('show'), true);
  assert.deepEqual(shown.map((b) => b.textContent), [...MARKET_OUTCOMES, 'Cancel']);
  shown.at(-1).click();                                                         // Cancel
  assert.equal(dom.root.classList.contains('show'), false);
  assert.equal(window.BLWP_PICK_CHOSEN, null, 'Cancel made a pick');
  assert.deepEqual(picked, []);
  await open(CONTRACT, id, ['http://seat-a'], (i) => picked.push(i));
  buttons(dom.sheet)[1].click();                                                // "between"
  assert.deepEqual(picked, [1]);
  assert.deepEqual({ ...window.BLWP_PICK_CHOSEN, manifestHex: undefined }, { round: id, pick: 1, label: 'between', gameId: toHex(MARKET.registration.gameId), confirmed: false, manifestHex: undefined });

  // UNPINNED: the manifest from a seat; no confirmation, no pick; confirmed, the pick and the confirmed game
  const other = testAttestedGame({ name: 'eth-close', outcomes: ['up', 'down'] }).registration;
  const asked = [];
  let yes = false;
  const w2 = { confirm: (text) => { asked.push(text); return yes; },
    fetch: async (url) => ({ ok: /\/game-manifest\?round=/.test(url), arrayBuffer: async () => encodeManifest(other.manifest).buffer.slice(0) }) };
  dom = fakeDocument();
  picked = [];
  const open2 = liftSheet(w2, dom.document);
  await open2({ ...CONTRACT, gameId: other.gameId }, id, ['http://seat-a'], (i) => picked.push(i));
  buttons(dom.sheet)[0].click();
  assert.equal(asked.length, 1);
  assert.deepEqual(picked, [], 'an unpinned market was picked without the second confirmation');
  assert.equal(w2.BLWP_PICK_CHOSEN, undefined);
  yes = true;
  buttons(dom.sheet)[0].click();
  assert.deepEqual(picked, [0]);
  assert.equal(w2.BLWP_PICK_CHOSEN.confirmed, true);
  assert.equal(w2.BLWP_PICK_CHOSEN.gameId, toHex(other.gameId));
  assert.ok(w2.BLWP_PICK_CHOSEN.manifestHex.length > 100, 'the confirmed manifest is not kept with the pick');
});

test('the pick: the entry carries it, every seat is handed the entry, the stake lock and the fee lock', async () => {
  const seed = b32(3);
  const round = { ...CONTRACT, id: ROUND_ID, custody: 'FEDERATION', federationId: b32(9), stakeMsat: 0n };
  // completed as the page completes a pick's entry (index.html: its round id and a session key of its own)
  const entry = { ...entryFor(round, { seed, curve: (await import('../src/page-curve.js')).pageCurve, random: () => b32(5), pick: 2 }), roundId: ROUND_ID, sessionPubkey: b32(6) };
  assert.equal(decodeEntryContract((await import('../../arena-protocol/src/contracts.js')).encodeEntryContract(entry)).pick, 2);
  const posts = [];
  const fetcher = async (url, init) => { posts.push(`${new URL(url).host}${new URL(url).pathname}`); return { status: 201, ok: true, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }; };
  const lock = { fields: { paymentImage: { kind: 'point', bytes: new Uint8Array(33).fill(2) }, amountMsat: 900000n, claimPk: new Uint8Array(33).fill(2), refundPk: new Uint8Array(33).fill(2), expiration: 300 },
    feeLock: { fields: { paymentImage: { kind: 'hash', bytes: b32(8) }, amountMsat: 50000n, claimPk: new Uint8Array(33).fill(2), refundPk: new Uint8Array(33).fill(2), expiration: 300 } } };
  const sent = await submitPick({ entry, stakeLock: lock, nodes: ['http://seat-a', 'http://seat-b'], fetcher });
  console.log('  SUBMIT:', JSON.stringify({ ok: sent.ok, posts: [...new Set(posts)].sort() }));
  assert.equal(sent.ok, true);
  for (const s of ['seat-a', 'seat-b']) for (const door of ['/entry', '/lock', '/fee-lock']) assert.ok(posts.includes(`${s}${door}`), `${s}${door} not handed`);
});

test('a hidden move is the tab\'s once the seats took its entry: onEntries before the guardians accept, the locks after (kanban #293)', async () => {
  const seed = b32(3);
  const round = { ...CONTRACT, id: ROUND_ID, custody: 'FEDERATION', federationId: b32(9), stakeMsat: 0n };
  const entry = { ...entryFor(round, { seed, curve: (await import('../src/page-curve.js')).pageCurve, random: () => b32(5), pick: 1 }), roundId: ROUND_ID, sessionPubkey: b32(6) };
  const order = [];
  const fetcher = async (url) => { order.push(new URL(url).pathname); return { status: 201, ok: true, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }; };
  let accept;
  const lock = { fields: { paymentImage: { kind: 'point', bytes: new Uint8Array(33).fill(2) }, amountMsat: 900000n, claimPk: new Uint8Array(33).fill(2), refundPk: new Uint8Array(33).fill(2), expiration: 300 },
    accepted: new Promise((r) => { accept = r; }) };
  const p = submitPick({ entry, stakeLock: lock, nodes: ['http://seat-a', 'http://seat-b'], fetcher, onEntries: (x) => order.push('onEntries:' + x.entries.filter((e) => e.status === 201).length) });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['/entry', '/entry', 'onEntries:2'], 'the entries out and counted, and no lock handed before the guardians accepted it');
  accept({});
  const sent = await p;
  assert.equal(sent.ok, true);
  assert.equal(order.filter((x) => x === '/lock').length, 2, 'the lock handed to both seats after acceptance');
});

test('picked: the join of a pick ends \'picked\' before the session\'s globals - and Unity adopts only joining/joined', () => {
  const then = PAGE.indexOf("if (window.BLWP_PICKED && window.BLWP_PICKED.round === id) {");
  const entryBranch = PAGE.indexOf("if (window.BLWP_ENTRY && Number(window.BLWP_ENTRY.joinTick) > 0", then);
  assert.ok(then > 0 && entryBranch > then, 'the picked branch does not come before the run\'s');
  const branch = PAGE.slice(then, PAGE.indexOf('\n                return;\n', then));
  assert.match(branch, /join\.state = 'picked'/);
  assert.doesNotMatch(branch, /BLWP_ENTRY =|BLWP_CHAIN =|BLWP_ADVERT =/);
  // the join of a pick never sets the session's globals: it returns before window.BLWP_ENTRY is written
  const pickJoin = PAGE.indexOf('const chosen = pickFor(named.roundIdHex);');
  const pickReturn = PAGE.indexOf('\n        return;\n      }\n      if (keptEntry) window.BLWP_ENTRY = keptEntry;', pickJoin);
  assert.ok(pickJoin > 0 && pickReturn > pickJoin, 'the pick does not return before the entry the session opens');
  assert.doesNotMatch(PAGE.slice(pickJoin, pickReturn), /window\.BLWP_ENTRY =|warmTheSession\(/);
  // and Unity: unchanged, it waits on "joined" and adopts only "joining"/"joined" (no C# change in slice 2)
  const lobbyCs = readFileSync(new URL('../../../unity-proto/Assets/Scripts/Blwp/DailyLobby.cs', import.meta.url), 'utf8');
  const splash = readFileSync(new URL('../../../unity-proto/Assets/Scripts/SplashScreen.cs', import.meta.url), 'utf8');
  assert.match(lobbyCs, /if \(s\.join\.state != "joined"\) return "wait";/);
  assert.match(splash, /\(_lobby\.join\.state == "joining" \|\| _lobby\.join\.state == "joined"\)/);
});

test('the outcome: verified when the pinned attestors signed it, UNVERIFIED for a key the page does not pin or a browser that cannot check - and the lines say so', async () => {
  const market = marketForRound(CONTRACT);
  const rid = toHex(ROUND_ID);
  const body = { roundId: ROUND_ID, outcome: 0, observedAtMs: 1n };
  const [A0, , A2] = MARKET.attestors;
  const good = toHex(encodeAttestation(signBody(body, [A0, A2])));
  const stranger = toHex(encodeAttestation(signBody(body, [A0, testDevKey('not a btc-close attestor')])));
  const verified = await checkAttestation({ attestationHex: good, market, roundIdHex: rid });
  const foreign = await checkAttestation({ attestationHex: stranger, market, roundIdHex: rid });
  const blind = await checkAttestation({ attestationHex: good, market, roundIdHex: rid, verify: async () => null });
  console.log('  CHECK:', JSON.stringify({ verified, foreign, blind }));
  assert.equal(verified.verified, true);
  assert.equal(verified.label, 'above 100k');
  assert.equal(foreign.verified, false);
  assert.match(foreign.why, /does not name as an attestor/);
  assert.equal(blind.verified, false);
  assert.equal(blind.unverifiable, true);
  // THE LINES: a winner, a loser, an unverified outcome (nothing concluded), a dispute
  const entries = [{ entryId: 'aa'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 0 },
    { entryId: 'bb'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 1 }];
  const table = JSON.parse(JSON.stringify(pariMutuelTable({ entries, outcome: 0 }), (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  const pick = (entryIdHex, p, roundIdHex = rid) => ({ roundIdHex, entryIdHex, market, pick: p, stakeMsat: 1_000_000n, entryCloseMs: 0 });
  const outcomes = new Map([[rid, { state: 'ATTESTED', label: 'above 100k', final: true, table, check: verified }],
    ['cc'.repeat(32), { state: 'ATTESTED', label: 'above 100k', final: true, table, check: foreign }],
    ['dd'.repeat(32), { state: 'DISPUTED' }]]);
  const lines = marketLines({ picks: [pick('aa'.repeat(32), 0), pick('bb'.repeat(32), 1), pick('aa'.repeat(32), 0, 'cc'.repeat(32)), pick('aa'.repeat(32), 0, 'dd'.repeat(32)),
    { ...pick('ee'.repeat(32), 2, 'ee'.repeat(32)), entryCloseMs: Date.now() + 3600000 }], outcomes }).map((l) => l.text);
  console.log('  LINES:\n   ' + lines.join('\n   '));
  assert.match(lines[0], /^btc-close 77777777: 'above 100k' \(2 of 3 attestors, verified\) · you won 900 sats$/);
  assert.match(lines[1], /you lost 900 sats$/);
  assert.match(lines[2], /UNVERIFIED/);
  assert.doesNotMatch(lines[2], /won|lost/);
  assert.match(lines[3], /contradicted themselves, nothing is paid/);
  assert.match(lines[4], /^btc-close: you picked 'below 90k' · 1,000 sats · closes in (0:59:5\d|1:00:00)$/);
  // A FREE ROUND (measured live on the test host: the right pick read "nobody picked it"): right or wrong, no refund said
  const free = [{ entryId: 'aa'.repeat(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, pick: 0 }, { entryId: 'bb'.repeat(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, pick: 2 }];
  const freeTable = JSON.parse(JSON.stringify(pariMutuelTable({ entries: free, outcome: 0 }), (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(freeTable.refunded, false);
  const freeLines = marketLines({ picks: [{ ...pick('aa'.repeat(32), 0), stakeMsat: 0n }, { ...pick('bb'.repeat(32), 2), stakeMsat: 0n }],
    outcomes: new Map([[rid, { state: 'ATTESTED', label: 'above 100k', final: true, table: freeTable, check: verified }]]) }).map((l) => l.text);
  console.log('  FREE LINES:\n   ' + freeLines.join('\n   '));
  assert.match(freeLines[0], /verified\) · your pick was right \(free round\)$/);
  assert.match(freeLines[1], /verified\) · your pick was wrong \(free round\)$/);
});

test('the order (kanban #237): the entry carries its pick, limit price and expiry; an order without a pick or a whole price is refused', async () => {
  const seed = b32(3);
  const round = { ...CONTRACT, id: ROUND_ID, custody: 'FEDERATION', federationId: b32(9), stakeMsat: 0n };
  const curve = (await import('../src/page-curve.js')).pageCurve;
  const { encodeEntryContract } = await import('../../arena-protocol/src/contracts.js');
  const entry = { ...entryFor(round, { seed, curve, random: () => b32(5), pick: 1, limitPrice: 62000, orderExpiryMs: 1791600000000n }), roundId: ROUND_ID, sessionPubkey: b32(6) };
  const back = decodeEntryContract(encodeEntryContract(entry));
  console.log('  ORDER:', JSON.stringify({ pick: back.pick, limitPrice: back.limitPrice, orderExpiryMs: String(back.orderExpiryMs) }));
  assert.deepEqual([back.pick, back.limitPrice, back.orderExpiryMs], [1, 62000, 1791600000000n]);
  const plain = decodeEntryContract(encodeEntryContract({ ...entryFor(round, { seed, curve, random: () => b32(5), pick: 1 }), roundId: ROUND_ID, sessionPubkey: b32(6) }));
  assert.equal(plain.limitPrice, undefined, 'a pick without a price stays a pick: its bytes are unchanged');
  assert.throws(() => entryFor(round, { seed, curve, random: () => b32(5), limitPrice: 62000 }), /an order backs an outcome: it needs a pick/);
  assert.throws(() => entryFor(round, { seed, curve, random: () => b32(5), pick: 0, limitPrice: 0 }), /a limit price is a whole number/);
  assert.throws(() => entryFor(round, { seed, curve, random: () => b32(5), pick: 0, limitPrice: 1.5 }), /a limit price is a whole number/);
});

test('an order brings its own amount (kanban #237): orderStakeMsat beside the contract is what the entry stakes and pays its fee on', async () => {
  const { stakeOf } = await import('../src/join.js');
  const round = { ...CONTRACT, id: ROUND_ID, stakeMsat: 0n };
  assert.equal(stakeOf(round), 0n);
  assert.equal(stakeOf({ ...round, orderStakeMsat: 2500000n }), 2500000n);
  const curve = (await import('../src/page-curve.js')).pageCurve;
  const e = entryFor({ ...round, orderStakeMsat: 2500000n }, { seed: b32(3), curve, random: () => b32(5), pick: 0, limitPrice: 52000 });
  assert.equal(e.stakeMsat, 2500000n);
  assert.equal(e.feeMsat, 25000n, '1 % of the order\'s own amount');
});

