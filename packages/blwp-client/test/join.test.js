// A PAGE CAN BE SENT TO A ROUND THAT ALREADY EXISTS.
//
// The shipped page refuses to invent `BLWP_ROUND` and that refusal is right.
// It also had no way to be GIVEN one, so two people could not join the same
// round from the daily however correct everything under it was. This is that
// way in, and it is the same family as `?practice=0`: the URL NAMES things -
// a round id, the daemons holding it, where headers and the bond are asked
// for - and nothing here mints any of them.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';
import { joinQuery, joinFromQuery, fetchRound, tabSeed, playerFor, entryFor, stakeFor, fetchSettlementSeats, roundPays } from '../src/join.js';
import { playerSecretFor, refundFingerprint } from '../../protocol/src/player-key.js';
import { coreHashHex } from '../../core/tools/hash-core.js';
import { entryFeeMsat, feeMatchesEntry } from '../../protocol/src/fee.js';
import { NO_SHARES } from '../../protocol/src/handout.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const CORE = fromHex(coreHashHex());
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FUNDED = {
  funded: () => true,
  randomnessFor: () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n }),
};
const ADVERT = 'ab'.repeat(64);

const contractOn = (a, b, seed = 0x43) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(seed), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [a, b],
});

test('a page nobody sent anywhere is the single-player daily', () => {
  assert.equal(joinQuery(''), null);
  assert.equal(joinQuery('?practice=0'), null);
  assert.equal(joinQuery('?node=http://127.0.0.1:1&bond=http://127.0.0.1:2'), null,
    'a URL with no round still opened a session');
});

test('every way of naming a round badly is refused by name', () => {
  const why = (q) => { try { joinQuery(q); return 'accepted'; } catch (e) { return e.message; } };
  const id = 'aa'.repeat(32);
  assert.match(why('?round=nonsense'), /not a 32-byte id/);
  assert.match(why(`?round=${id}`), /no node holding it/);
  assert.match(why(`?round=${id}&node=not-a-url`), /not a node address/);
  assert.match(why(`?round=${id}&node=http://a.test&bond=http://b.test&advert=${ADVERT}`),
    /two independent sources/);
  assert.match(why(`?round=${id}&node=http://a.test,http://b.test&advert=${ADVERT}`),
    /nowhere to ask for the bond/);
  assert.match(why(`?round=${id}&node=http://a.test,http://b.test&bond=http://c.test`),
    /no signed advertisement/);
  assert.match(why(`?round=${id}&node=http://a.test,http://b.test&bond=http://c.test&advert=xy`),
    /64 signed bytes or a place/);
  const twoPaths = joinQuery(`?round=${id}&node=https://h.test/blwp-a,https://h.test/blwp-b`
    + `&bond=https://h.test/blwp-a/bond&advert=${ADVERT}`);
  assert.equal(twoPaths.nodes.length, 2);
});

test('two daemons hold the round, and the page joins the one the URL names', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  const b = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const contract = contractOn(a.round.pubkey, b.round.pubkey);
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, sign, verify });
    const rid = await client.openRound(contract);
    // the SAME round on the second daemon, which is what a 2-of-2 is
    await fetch(`http://127.0.0.1:${b.port}/round`,
      { method: 'POST', body: encodeRoundContract(contract) });

    const url = `?round=${toHex(rid)}`
      + `&node=http://127.0.0.1:${a.port},http://127.0.0.1:${b.port}`
      + `&bond=http://127.0.0.1:${a.port}/bond&advert=${ADVERT}`;
    const joined = await joinFromQuery(url);

    assert.ok(joined, 'the URL named a round and the page stayed single-player');
    assert.equal(toHex(roundId(joined.round)), toHex(rid),
      'the page joined a round that is not the one the URL named');
    // SORTED, because the encoding puts a committee in canonical order and
    // that is the round's own ordering, not the one an author typed.
    assert.deepEqual(joined.round.nodes.map(toHex).sort(), contract.nodes.map(toHex).sort(),
      'the committee the page carries is not the round\'s');
    assert.equal(joined.chain.headers.length, 2, 'a chain is read from two sources');
    assert.equal(new Set(joined.chain.headers.map((h) => h.tag)).size, 2,
      'two providers on one address are one source');
    assert.equal(joined.chain.bonds.length, 1);
    assert.equal(joined.advert.signedAdvert, ADVERT);
  } finally { await a.close(); await b.close(); }
});

test('a node answering with a different round is refused, not played', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const wanted = contractOn(a.round.pubkey, b32(9));
    const other = contractOn(a.round.pubkey, b32(9), 0x44);
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, sign, verify });
    const rid = await client.openRound(wanted);
    assert.notEqual(toHex(roundId(other)), toHex(rid), 'the two rounds are the same round');

    // A LIAR AND THEN THE TRUTH. The first node answers 200 with a perfectly
    // well-formed contract that is not the one asked for - a different config,
    // so a different stake and a different committee could ride in the same
    // way - and the second answers with the round itself.
    const swap = async (at) => (String(at).includes('liar')
      ? new Response(encodeRoundContract(other), { status: 200 })
      : fetch(at));
    const got = await fetchRound(toHex(rid), ['http://liar.test', `http://127.0.0.1:${a.port}`],
      { fetcher: swap });
    assert.equal(toHex(roundId(got.contract)), toHex(rid));
    assert.equal(got.from, `http://127.0.0.1:${a.port}`, 'the page took the substituted round');
    assert.match(got.refused[0], /answered with round/);

    // AND WITH NOBODY ELSE TO ASK, IT IS A REFUSAL AND NOT A GUESS.
    await assert.rejects(
      fetchRound(toHex(rid), ['http://liar.test'], { fetcher: swap }),
      /no node holds the round this URL names/);
  } finally { await a.close(); }
});

test('two tabs are two players, and one tab is one player twice', () => {
  // sessionStorage is per tab, which is why the key lives there: two tabs are
  // two of these, and each keeps its own player across a reload.
  const tab = () => {
    const held = new Map();
    return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
  };
  let n = 0;
  const random = (len) => new Uint8Array(len).fill(++n);

  const one = tab(), two = tab();
  // THE TAB KEEPS A SEED (§24, v4.6.2, F2); each round's key comes from it.
  const round = { id: b32(0x0a) };
  const a = playerFor(round, { seed: tabSeed({ storage: one, random }), curve: feldmanGroup });
  const again = playerFor(round, { seed: tabSeed({ storage: one, random }), curve: feldmanGroup });
  const b = playerFor(round, { seed: tabSeed({ storage: two, random }), curve: feldmanGroup });

  assert.equal(toHex(a.pubkey), toHex(again.pubkey), 'a reload made the tab a different player');
  assert.equal(toHex(a.seed), toHex(again.seed), 'a reload drew a new seed');
  assert.notEqual(toHex(a.pubkey), toHex(b.pubkey), 'two tabs are the same player, so each drops the other');

  // AND IT IS A KEY ON THE CURVE, which is the whole point: a payout is an
  // output and an output pays to a key.
  assert.equal(a.pubkey.length, 32);
  assert.deepEqual(a.pubkey, schnorr.getPublicKey(a.secret));
  assert.notDeepEqual(a.pubkey, a.seed, 'the seed was handed out as the public key');

  // FRESH PER ROUND: the same seed, another round, another key - so two
  // rounds' locks do not link.
  const next = playerFor({ id: b32(0x0b) }, { seed: a.seed, curve: feldmanGroup });
  assert.notEqual(toHex(next.pubkey), toHex(a.pubkey), 'one key for two rounds');

  // A TAB CARRYING RUBBISH GETS A NEW SEED rather than a seat nobody can pay.
  const junk = tab(); junk.setItem('blwp.player.seed', 'not-a-seed');
  assert.equal(tabSeed({ storage: junk, random }).length, 32);

  // AND A PAGE WITH NO CURVE IS REFUSED, rather than handed random bytes.
  assert.throws(() => playerFor(round, { seed: a.seed }), /a player identity is a key on a curve/);
});

/**
 * THE REFUND AND PAYOUT KEY IS THE SEED'S, AND THE PAGE WILL NOT SEAT ANOTHER
 * (§24, v4.6.2, F2). Before: `entryFor` took any 32 bytes as `playerPubkey` -
 * a key from one random secret per tab, never backed up, the same for every
 * round - and a stake dealt under any key. A payout and a refund go to that
 * key, and the player had nothing to check it against.
 */
test('a seat carries the seed\'s key for the round, its fingerprint is the player\'s to check, and any other key is refused', async () => {
  const seed = b32(0x5e);
  const round = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 7, simCoreHash: CORE };
  const random = (n) => new Uint8Array(n).fill(9);
  const player = playerFor(round, { seed, curve: feldmanGroup });

  // DERIVABLE WITHOUT THE PAGE: the rule is protocol's, the curve is BIP-340.
  assert.deepEqual(player.pubkey, schnorr.getPublicKey(playerSecretFor(seed, round.id)));
  assert.equal(player.fingerprint, refundFingerprint(player.pubkey));
  assert.match(player.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);

  const seat = entryFor(round, { seed, curve: feldmanGroup, random });
  assert.deepEqual(seat.playerPubkey, player.pubkey, 'the seat is not the seed\'s key');
  assert.deepEqual(entryFor(round, { seed, curve: feldmanGroup, playerPubkey: player.pubkey, random }).playerPubkey,
    player.pubkey);

  // ANOTHER KEY IS REFUSED: a stranger's, and this seed's key for another round.
  const otherRound = playerFor({ id: b32(0x12) }, { seed, curve: feldmanGroup }).pubkey;
  for (const wrong of [schnorr.getPublicKey(b32(0x77)), otherRound])
    assert.throws(() => entryFor(round, { seed, curve: feldmanGroup, playerPubkey: wrong, random }),
      /not the one this seed makes for this round/);

  // AND SO IS A STAKE DEALT UNDER ANOTHER KEY.
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));
  const seats = Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
  const theirs = await stakeFor(round, { seats, curve: feldmanGroup, random: rand, playerPubkey: otherRound });
  assert.throws(() => entryFor(round, { seed, curve: feldmanGroup, random, stake: theirs }),
    /dealt under another player key/);

  assert.throws(() => entryFor(round, { curve: feldmanGroup, random }), /32-byte seed/);
});

test('the seat a page takes carries the round\'s own amounts', () => {
  const round = { id: b32(0x0c), stakeMsat: 100000n, blockTicks: 9000, simCoreHash: CORE };
  let n = 0;
  const random = (len) => new Uint8Array(len).fill(++n);
  const me = { seed: b32(5), curve: feldmanGroup };
  const seat = entryFor(round, { ...me, random });

  assert.equal(seat.stakeMsat, 100000n, 'the page asked for a stake the round does not name');

  // THE FEE IS 2% OF THE ROUND'S OWN STAKE, and this line used to read
  // `feeMsat === 0n` with "M2 asks for no money" beside it. That was true of
  // M2 and the fixture below is a round that DOES ask for money, so the
  // assertion and its own setup disagreed. `feeMatchesEntry` is the rule -
  // too little and the round collects less than the fee table will owe its
  // nodes - and it had zero callers, so nothing noticed.
  //
  // M2's rounds are unchanged, and that is asserted rather than argued: 2% of
  // nothing is nothing, so a round that asks no stake still carries no fee and
  // there is no branch here to get wrong.
  assert.equal(seat.feeMsat, entryFeeMsat(100000n));
  assert.equal(seat.feeMsat, 2000n, 'a paying round is charged 2% of its stake');
  assert.equal(feeMatchesEntry(seat).ok, true);
  const free = entryFor({ id: b32(0x0d), stakeMsat: 0n, blockTicks: 9000 }, { ...me, random });
  assert.equal(free.feeMsat, 0n, 'a round that asks no money is charged some');
  assert.equal(feeMatchesEntry(free).ok, true);

  assert.equal(seat.donationMsat, 0n);
  assert.equal(seat.joinTick, 0);
  assert.equal(seat.stakeCommitment.length, 32);
  assert.equal(seat.worldSecret.length, 32);
  assert.notEqual(toHex(seat.stakeCommitment), toHex(seat.worldSecret),
    'the commitment and the world secret are one value, so one leaks the other');

  assert.throws(() => entryFor(null, { ...me, random }), /no round/);
  assert.throws(() => entryFor(round, { seed: b32(5).slice(0, 8), curve: feldmanGroup, random }),
    /32-byte seed/);
});

// THE SHIPPING PAGE, READ AS A FILE.
//
// Every rule above is measured against real daemons, and none of it does
// anything unless the page actually calls it. That was the whole shape of the
// last fault in this letter: a class nothing constructed, green tests all
// around it. So the template is read here, the way the client bundle beside it
// already is.
test('the page joins a named round and still invents none', () => {
  const page = readFileSync(
    new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html',
      import.meta.url).pathname, 'utf8');

  for (const call of ['joinFromQuery', 'entryFor', 'tabSeed', 'playerFor'])
    assert.ok(new RegExp('BLWPCLIENT\\.' + call + '\\s*\\(').test(page),
      'the page never calls ' + call + ', so the round in the URL reaches nothing');

  for (const global of ['BLWP_ROUND', 'BLWP_CHAIN', 'BLWP_ADVERT', 'BLWP_ENTRY'])
    assert.ok(new RegExp('window\\.' + global + '\\s*=\\s*(named|BLWPCLIENT)').test(page),
      global + ' is not filled from what the URL named');

  // AND IT WRITES NO CONTRACT. A page that carried its own fields could name
  // its own committee and then satisfy its own choice, which is the exact
  // substitution the round id exists to stop.
  for (const field of ['censusRoot', 'simCoreHash', 'gameVerifySlots', 'stakeMsat',
                       'committeeTimeMs', 'blockTicks'])
    assert.ok(!page.includes(field),
      'the page writes ' + field + ', so it is inventing a round rather than joining one');

  // THE SESSION KEY IS PER TAB. localStorage would make two tabs one player,
  // and a player's own ghost is dropped - so the two tabs would show each
  // other nothing.
  assert.ok(page.includes('sessionStorage'), 'the page has no per-tab identity');
  assert.ok(!page.includes('localStorage'),
    'the page keeps the player in storage every tab shares');
  assert.ok(page.includes('id="blwp-players"'),
    'the page has no on-screen count of who is in the round');
  assert.ok(page.includes('probeNodes'),
    'the page never checks whether both nodes answer');
  assert.ok(page.includes('playLine'),
    'the page never says whether the play socket is up');
  assert.ok(page.includes('BLWP_CURVE.verify'),
    'the page still verifies node adverts with Ed25519');

  // AND THE PAGE DEALS ITS OWN STAKE (letter 15).
  //
  // Measured before this: `entryFor` was called with NO stake, so every seat
  // the shipped page took carried `random(32)` where `sha256(P)` belongs and
  // 32 zero bytes where the shares belong - and `stakeFor` was compiled into
  // the bundle with ZERO CALLERS. The daemon accepts those zeros on purpose
  // for M2, so nothing refused and nothing said anything.
  assert.ok(page.includes('BLWPCLIENT.stakeFor('),
    'the page takes a seat without dealing a stake');
  assert.ok(page.includes('fetchSettlementSeats'),
    'the page deals a stake without asking who settles the round');
  assert.ok(!/stakeFor\(\s*named\.round\b/.test(page),
    'the page deals to the contract\'s flat node list, which is the union of the committees');
  // THE HANDOUT IS PUBLISHED, AND THE COUNT IS ACTED ON. This pinned the
  // string "/handout" in the page, which only proved a URL was written down.
  // The posting and the five-seat threshold are `postHandout` now - a handout
  // three of seven seats hold is a stake nobody can open - so what is pinned
  // is the call and the branch that refuses on it.
  assert.match(page, /BLWPCLIENT\.postHandout\(/,
    'the page deals a handout and never posts it, so no seat can accept it');
  assert.match(page, /if \(!put\.ok\)/,
    'the page publishes the handout and ignores how many seats took it');
  assert.ok(page.includes('BLWP_SEAT_REFUSED'),
    'a paying round whose committee cannot be learned is still seated silently');
  // THE SEAT'S FUNDING REACHES THE SCREEN, and this pin was weaker when it was
  // written: it asserted the page contained the words "THE STAKE IS NOT PAID",
  // which is a CONSTANT - the page asserting a funding state it never measured.
  // The node answers `x-hold` when it takes the entry, so what is pinned now is
  // that the page hands the chip the node's word and the refusal, and that
  // `playersLine` is what turns them into a line. Stronger, not looser:
  // `page-stake.test.js` drives the wording itself.
  assert.match(page, /seatRefused,\s*stake/,
    'the chip is never told why there is no seat or what it cost');
  assert.match(page, /net\.client\.seatHold/,
    'the page invents the funding word instead of reading the node\'s');
  assert.ok(!page.includes('THE STAKE IS NOT PAID'),
    'the page asserts a funding state it did not measure');

  // AND IT STILL NAMES NO CONTRACT FIELD. Knowing whether a round asks for
  // money is a rule, so it lives in the client where a test can drive it - the
  // page asks `roundPays` rather than reading `stakeMsat` off the contract,
  // which is the same discipline the loop above enforces.
  assert.ok(page.includes('BLWPCLIENT.roundPays('),
    'the page decides for itself whether a round pays');
});

test('whether a round pays is one rule, and it is not in the page', () => {
  assert.equal(roundPays({ stakeMsat: 100000n }), true);
  assert.equal(roundPays({ stakeMsat: 0n }), false);
  assert.equal(roundPays({}), false, 'a round with no stake field is not a paying round');
  assert.equal(roundPays(null), false);
});

/**
 * WHO A STAKE IS DEALT TO, AND WHY IT IS NOT THE LIST THE PAGE ALREADY HOLDS.
 *
 * MEASURED on nine bonded nodes with seven game/verify slots and seven
 * settlement slots: the game committee is 7, the settlement committee is 7,
 * and `contract.nodes` - what `joinFromQuery` hands the page - is the UNION at
 * 9, with 5 in both and 2 settlement-only. `Roster.seatsFor` says so itself.
 * Dealing to the flat list would seal nine shares for a five-of-seven scheme,
 * two of them to seats that could never open one, and a stake nobody can open
 * at payout is worse than one never dealt.
 */
test('the settlement seats are asked of every node, and a disagreement is refused', async () => {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const committee = (keys) => ({
    ok: true, status: 200,
    arrayBuffer: async () => {
      const out = new Uint8Array(keys.length * 32);
      keys.forEach((k, i) => out.set(k, i * 32));
      return out.buffer;
    },
    text: async () => '',
  });
  const seats = [b32(1), b32(2), b32(3), b32(4), b32(5), b32(6), b32(7)];

  // EVERY NODE IS ASKED, and the ORDER they list them in is not a difference:
  // one committee written two ways is one committee.
  const asked = [];
  const got = await fetchSettlementSeats('ab'.repeat(32), ['http://a', 'http://b/'], {
    fetcher: async (u) => { asked.push(u); return committee(u.startsWith('http://a') ? seats : [...seats].reverse()); },
  });
  assert.equal(got.seats.length, 7);
  assert.equal(got.agreed, 2);
  assert.equal(asked.length, 2, 'the page asked one node and took its word');
  for (const u of asked) assert.match(u, /\/committee\?role=settlement&round=/);

  // A DISAGREEMENT IS A REFUSAL. One node's answer about who may open a
  // player's stake is one node choosing who may open it.
  await assert.rejects(() => fetchSettlementSeats('ab'.repeat(32), ['http://a', 'http://b'], {
    fetcher: async (u) => committee(u.startsWith('http://a') ? seats : [...seats.slice(0, 6), b32(9)]),
  }), /two different settlement committees/);

  // And a round nobody will answer for is a refusal too, with the reasons.
  await assert.rejects(() => fetchSettlementSeats('ab'.repeat(32), ['http://a'], {
    fetcher: async () => ({ ok: false, status: 409, text: async () => 'that round is not seated' }),
  }), /named no round's settlement committee|no node named this round/);
  await assert.rejects(() => fetchSettlementSeats('ab'.repeat(32), []), /no node to ask/);
});

/**
 * THE PAGE AS DEALER (23.1 steps 1 and 2).
 *
 * Measured before this existed: `entryFor` set `stakeCommitment: random(32)` -
 * a commitment to nothing - and `vssSharesRef: NO_SHARES`, so there was no
 * preimage in the system at all and nothing for a committee to reconstruct.
 *
 * The curve is injected here the same way `sign` is, because this bundle
 * carries no crypto: a vendored curve in the page is an implementation of the
 * thing that pins money that nobody audits.
 */
test('a page deals its own stake: the commitment is a hash and the ref is a handout', async () => {
  const { feldmanGroup } = await import('../../blwp-node/src/curve.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { sha256 } = await import('../../protocol/src/hash.js');
  const { handoutId, decodeHandout, openMyShare } = await import('../../protocol/src/handout.js');
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));

  const secrets = Array.from({ length: 7 }, () => rand(32));
  const seats = secrets.map((s) => schnorr.getPublicKey(s));
  const round = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 7, simCoreHash: CORE };

  const me = { seed: b32(5), curve: feldmanGroup };
  const stake = await stakeFor(round, {
    seats, curve: feldmanGroup, random: rand, playerPubkey: playerFor(round, me).pubkey,
  });

  // THE COMMITMENT IS A HASH OF SOMETHING, which is what a hold invoice needs
  // and what `random(32)` never was.
  assert.deepEqual(stake.stakeCommitment, sha256(stake.preimage));
  assert.equal(stake.preimage.length, 32);
  assert.deepEqual(stake.vssSharesRef, handoutId(stake.handout));
  assert.notDeepEqual(stake.vssSharesRef, NO_SHARES);

  // AND EVERY SEAT CAN OPEN ITS OWN, which is what makes the reference worth
  // naming. A handout no seat accepts is a reference an entry cannot use.
  const back = decodeHandout(stake.body);
  assert.equal(back.shares.length, 7);
  let opened = 0;
  for (let i = 0; i < seats.length; i++) {
    const mine = await openMyShare(back, {
      pubkey: seats[i], secret: secrets[i], curve: feldmanGroup,
    });
    if (mine.ok) opened++;
  }
  assert.equal(opened, 7, 'the page dealt shares its own committee cannot open');

  // AND THE ENTRY CARRIES IT. Without a dealt stake the seat is still the M2
  // one: a commitment to nothing, and no shares.
  const seat = entryFor(round, { ...me, random: rand, stake });
  assert.deepEqual(seat.stakeCommitment, stake.stakeCommitment);
  assert.deepEqual(seat.vssSharesRef, stake.vssSharesRef);
  const plain = entryFor(round, { ...me, random: rand });
  assert.deepEqual(plain.vssSharesRef, NO_SHARES);
});

test('a page refuses to deal without a curve, a committee, or a player', async () => {
  const { feldmanGroup } = await import('../../blwp-node/src/curve.js');
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const seats = Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
  const round = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 7, simCoreHash: CORE };

  await assert.rejects(() => stakeFor(round, { seats, random: rand, playerPubkey: b32(5) }),
    /needs a curve, and none was injected/);
  await assert.rejects(() => stakeFor(round, { seats: seats.slice(0, 3), curve: feldmanGroup, random: rand, playerPubkey: b32(5) }),
    /cannot be dealt to 3 seats/);
  await assert.rejects(() => stakeFor(round, { seats, curve: feldmanGroup, random: rand }),
    /that is 32 bytes of key/);
  await assert.rejects(() => stakeFor(null, { seats, curve: feldmanGroup, random: rand, playerPubkey: b32(5) }),
    /that is not one/);
});
