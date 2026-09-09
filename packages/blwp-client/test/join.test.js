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
import { joinQuery, joinFromQuery, fetchRound, tabIdentity, entryFor, stakeFor } from '../src/join.js';
import { NO_SHARES } from '../../protocol/src/handout.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
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
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
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
  // THE CURVE IS INJECTED, because this bundle carries none - and an identity
  // is a key now, not 32 bytes that looked like one.
  const a = tabIdentity({ storage: one, random, curve: feldmanGroup });
  const again = tabIdentity({ storage: one, random, curve: feldmanGroup });
  const b = tabIdentity({ storage: two, random, curve: feldmanGroup });

  assert.equal(toHex(a.pubkey), toHex(again.pubkey), 'a reload made the tab a different player');
  assert.equal(toHex(a.secret), toHex(again.secret), 'a reload drew a new secret');
  assert.notEqual(toHex(a.pubkey), toHex(b.pubkey), 'two tabs are the same player, so each drops the other');

  // AND IT IS A KEY ON THE CURVE, which is the whole point: a payout is an
  // output and an output pays to a key.
  assert.equal(a.pubkey.length, 32);
  assert.deepEqual(a.pubkey, schnorr.getPublicKey(a.secret));
  assert.notDeepEqual(a.pubkey, a.secret, 'the secret was handed out as the public key');

  // A TAB CARRYING RUBBISH GETS A NEW KEY rather than a seat nobody can pay.
  const junk = tab(); junk.setItem('blwp.player', 'not-a-key');
  assert.equal(tabIdentity({ storage: junk, random, curve: feldmanGroup }).pubkey.length, 32);

  // AND A PAGE WITH NO CURVE IS REFUSED, rather than handed random bytes.
  assert.throws(() => tabIdentity({ storage: tab(), random }),
    /a player identity is a key on a curve/);
});

test('the seat a page takes carries the round\'s own amounts', () => {
  const round = { stakeMsat: 100000n, blockTicks: 9000 };
  let n = 0;
  const random = (len) => new Uint8Array(len).fill(++n);
  const seat = entryFor(round, { playerPubkey: b32(5), random });

  assert.equal(seat.stakeMsat, 100000n, 'the page asked for a stake the round does not name');
  assert.equal(seat.feeMsat, 0n, 'M2 asks for no money');
  assert.equal(seat.donationMsat, 0n);
  assert.equal(seat.joinTick, 0);
  assert.equal(seat.stakeCommitment.length, 32);
  assert.equal(seat.worldSecret.length, 32);
  assert.notEqual(toHex(seat.stakeCommitment), toHex(seat.worldSecret),
    'the commitment and the world secret are one value, so one leaks the other');

  assert.throws(() => entryFor(null, { playerPubkey: b32(5), random }), /no round/);
  assert.throws(() => entryFor(round, { playerPubkey: b32(5).slice(0, 8), random }),
    /32 bytes of key/);
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

  for (const call of ['joinFromQuery', 'entryFor', 'tabIdentity'])
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
  const round = { id: b32(0x11), stakeMsat: 100000n };

  const stake = await stakeFor(round, {
    seats, curve: feldmanGroup, random: rand, playerPubkey: b32(5),
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
  const seat = entryFor(round, { playerPubkey: b32(5), random: rand, stake });
  assert.deepEqual(seat.stakeCommitment, stake.stakeCommitment);
  assert.deepEqual(seat.vssSharesRef, stake.vssSharesRef);
  const plain = entryFor(round, { playerPubkey: b32(5), random: rand });
  assert.deepEqual(plain.vssSharesRef, NO_SHARES);
});

test('a page refuses to deal without a curve, a committee, or a player', async () => {
  const { feldmanGroup } = await import('../../blwp-node/src/curve.js');
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const seats = Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
  const round = { id: b32(0x11), stakeMsat: 100000n };

  await assert.rejects(() => stakeFor(round, { seats, random: rand, playerPubkey: b32(5) }),
    /needs a curve, and none was injected/);
  await assert.rejects(() => stakeFor(round, { seats: seats.slice(0, 3), curve: feldmanGroup, random: rand, playerPubkey: b32(5) }),
    /cannot be dealt to 3 seats/);
  await assert.rejects(() => stakeFor(round, { seats, curve: feldmanGroup, random: rand }),
    /that is 32 bytes of key/);
  await assert.rejects(() => stakeFor(null, { seats, curve: feldmanGroup, random: rand, playerPubkey: b32(5) }),
    /that is not one/);
});
