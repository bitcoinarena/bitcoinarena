// THE PAGE DEALS ITS OWN STAKE, AND THE SIGNER NODES IT DEALS TO CAN OPEN IT.
//
// LETTER 15, AND ITS OWN SENTENCE IS RETRACTED. The letter read "the page does
// not vendor a curve, so a shipped page refuses a signer node at a paying round".
// Measured on the live Daily: `blwp-curve.js` is 96,493 bytes, `index.html`
// loads it, and driving the SERVED file produces a real x-only key. The guard
// cannot fire and the missing curve was 0% of the hole.
//
// WHAT WAS OPEN IS A SILENT SIGNER NODE. `entryFor` was called with NO stake, so every
// signer node the shipped page took carried `random(32)` where `sha256(P)` belongs and
// 32 zero bytes where the shares belong - and `stakeFor`, the page as dealer
// for 23.1 steps 1 and 2, had ZERO CALLERS. `round.js` accepts those zeros on
// purpose for M2, so nothing refused and nothing said anything.
//
// This file drives the page's OWN sequence against real daemons: ask who
// settles the round, deal, post the handout, build the entry, join.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { stakeFor, entryFor, playerFor, fetchSettlementSignerNodes, roundPays, postHandout } from '../src/join.js';
import { playersLine, stakeLine } from '../src/ghost-field.js';
import { Client } from '../src/client.js';
import { readFileSync } from 'node:fs';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { handoutId, decodeHandout, openMyShare, NO_SHARES } from '../../protocol/src/handout.js';
import { sha256, toHex, fromHex } from '../../protocol/src/hash.js';
import { coreHashHex } from '../../core/tools/hash-core.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { SHARES_TOTAL, SHARES_NEEDED } from '../../protocol/src/shares.js';
import { entryFeeMsat, feeMatchesEntry } from '../../protocol/src/fee.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const FUNDED = { funded: () => true };

const contractFor = (nodes, stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: fromHex(coreHashHex()),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  const raw = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes: raw, text: new TextDecoder().decode(raw) };
};

/**
 * SEVEN DAEMONS, and a `/committee?role=settlement` that answers with the ones
 * that actually settle.
 *
 * The real door reads a chain census, which `signer-node-committee.test.js`
 * exercises; what this file is about is the PAGE, so the answer is served and
 * the page's own behaviour is measured against it. The list it is given is
 * deliberately NOT all seven, because the whole point of `fetchSettlementSignerNodes`
 * is that the contract's flat `nodes` list is the union of the committees.
 */
async function daemons(n = SHARES_TOTAL, { stakeMsat = 100000n } = {}) {
  const nodes = [];
  for (let i = 0; i < n; i++)
    nodes.push(await serve(openStore(':memory:'), { port: 0, ...FUNDED, now: () => NOW }));
  const contract = contractFor(nodes.map((x) => x.round.pubkey), stakeMsat);
  const rid = roundId(contract);
  for (const x of nodes)
    assert.equal((await post(x.port, '/round', encodeRoundContract(contract))).status, 201);
  return { nodes, contract, rid, close: () => Promise.all(nodes.map((x) => x.close())) };
}

/** The page's own sequence, in the order `index.html` runs it. */
async function pageJoins(world, settlementSignerNodes, { reachable = world.nodes, needed = SHARES_NEEDED } = {}) {
  const player = playerFor(world.contract, { seed: rand(32), curve: feldmanGroup });

  const pays = roundPays(world.contract);
  let stake = null;
  const accepted = [];
  const refused = [];
  let put = null;
  if (pays) {
    stake = await stakeFor({ ...world.contract, id: world.rid }, {
      signerNodes: settlementSignerNodes, curve: feldmanGroup, random: rand, playerPubkey: player.pubkey,
    });
    put = await postHandout(stake, reachable.map((n) => `http://127.0.0.1:${n.port}`),
      { needed });
    for (const u of put.refused) refused.push(u);
    for (let i = 0; i < put.accepted; i++) accepted.push(i);
    if (!put.ok) return { player, stake, entry: null, accepted, refused, pays, put };
  }
  const entry = {
    roundId: world.rid, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    ...entryFor(world.contract, {
      seed: player.seed, curve: feldmanGroup, random: rand, ...(stake ? { stake } : {}),
    }),
  };
  return { player, stake, entry, accepted, refused, pays, put };
}

/**
 * THE NUMBER THAT CLOSES THE LETTER: an entry from the page's own sequence
 * carries a real commitment and shares the settlement signer nodes can open.
 */
test('a paying-round entry from the page carries a real stake, not random bytes', async () => {
  const world = await daemons();
  try {
    // The settlement committee is FIVE of the seven, so this file measures the
    // page dealing to the list it was told rather than to everybody it knows.
    const settlement = world.nodes.slice(0, 5).map((n) => n.round.pubkey);
    const joined = await pageJoins(world, settlement);

    assert.equal(joined.pays, true, 'this fixture is not a paying round');
    assert.deepEqual(joined.entry.stakeCommitment, sha256(joined.stake.preimage),
      'the entry does not commit to a preimage anybody holds');
    assert.notDeepEqual(joined.entry.vssSharesRef, NO_SHARES,
      'the entry still says it publishes no shares');
    assert.deepEqual(joined.entry.vssSharesRef, handoutId(joined.stake.handout));

    // AND THE SIGNER NODES IT WAS DEALT TO CAN OPEN THEIRS. A handout no signer node can open
    // is a stake that is lost at payout, which is worse than one never dealt.
    assert.equal(joined.accepted.length, settlement.length,
      `${joined.accepted.length} of ${settlement.length} settlement signer nodes took the handout: `
      + joined.refused.join('; '));
    const handout = decodeHandout(joined.stake.body);
    let opened = 0;
    for (const node of world.nodes.slice(0, 5)) {
      const mine = await openMyShare(handout, {
        pubkey: node.round.pubkey, secret: node.round.identity.secret, curve: feldmanGroup,
      });
      if (mine.ok) opened++;
    }
    assert.equal(opened, settlement.length);
    console.log(`  ${settlement.length} settlement signer nodes, ${joined.accepted.length} accepted the `
      + `handout, ${opened} opened their own share; ${SHARES_NEEDED} of them settle`);

    // AND A REAL DAEMON TAKES THE ENTRY, with the handout named rather than zeroed.
    const answer = await post(world.nodes[0].port, '/entry', encodeEntryContract(joined.entry));
    assert.equal(answer.status, 201, answer.text);
    assert.equal(toHex(answer.bytes), toHex(entryId(joined.entry)));
    console.log('  a daemon took the entry, and it names the handout rather than 32 zero bytes');
  } finally { await world.close(); }
});

/**
 * AND DEALING TO THE WRONG LIST IS REFUSED BY THE SIGNER NODES THEMSELVES.
 *
 * `contract.nodes` is the UNION of the role committees - `Roster.signerNodesFor`
 * says so - so a page that dealt to it would seal shares to signer nodes that cannot
 * open one. Measured on nine bonded nodes with 7 + 7 slots: game 7,
 * settlement 7, union 9, five in both and two settlement-only.
 */
test('a stake dealt to the wrong committee is refused by the signer nodes that cannot open it', async () => {
  const world = await daemons();
  try {
    // Two of the seven are strangers to the settlement committee - the shape a
    // game-verify-only signer node has.
    const strangers = [schnorr.getPublicKey(rand(32)), schnorr.getPublicKey(rand(32))];
    const wrong = [...world.nodes.slice(0, 5).map((n) => n.round.pubkey), ...strangers];
    const joined = await pageJoins(world, wrong);

    assert.equal(joined.accepted.length, 5,
      'a signer node with no share in the handout accepted it anyway');
    assert.equal(joined.refused.length, 2);
    for (const why of joined.refused)
      assert.match(why, /share|signer node|open/i, `a signer node refused for an unexpected reason: ${why}`);
    console.log(`  dealt to ${wrong.length} keys: ${joined.accepted.length} could open a share, `
      + `${joined.refused.length} could not`);
  } finally { await world.close(); }
});

/**
 * AND A ROUND THAT ASKS NOTHING IS A FREE ROUND, SAID OUT LOUD RATHER THAN
 * DEALT.
 */
test('a round that asks no stake deals none, and says so', async () => {
  const world = await daemons(3, { stakeMsat: 0n });
  try {
    const joined = await pageJoins(world, []);
    assert.equal(joined.pays, false);
    assert.equal(joined.stake, null, 'a free round dealt a stake nobody asked for');
    assert.deepEqual(joined.entry.vssSharesRef, NO_SHARES);
    const answer = await post(world.nodes[0].port, '/entry', encodeEntryContract(joined.entry));
    assert.equal(answer.status, 201, answer.text);
    console.log('  a free round: no stake dealt, 32 zero share bytes, and the daemon takes it');
  } finally { await world.close(); }
});

/**
 * AND THE PLAYER CAN SEE ALL OF IT, which is where the first close of this
 * letter stopped short.
 *
 * The refusal and the stake went to `console.error` and `console.log`. The chip
 * reads `playersLine`, so a refused join printed "round named · not joined" -
 * word for word what a page nobody sent a round to prints - and a free round
 * printed "1 player · waiting", word for word what a funded one prints. A
 * silent refusal and a silent free round are the same fault this letter opened
 * on, on the other side of the glass.
 */
test('the chip says why there is no signer node, and what the signer node cost', () => {
  // A REFUSAL NAMES ITSELF, and it beats the bridge's own message: with no
  // entry the jslib throws "the page did not say which round to play", which
  // is a true sentence about the wrong cause.
  assert.equal(
    playersLine({ joined: false, joinRefused: 'its settlement committee could not be learned' }),
    'not joined · its settlement committee could not be learned');

  // A round nobody was sent to still reads the way it always did.
  assert.equal(playersLine({ joined: false }), 'round named · not joined');

  // A FREE ROUND SAYS SO.
  assert.equal(playersLine({ joined: true, others: 1, stake: { free: true, dealt: false } }),
    '2 players in this round · free round');

  // A DEALT BUT UNFUNDED SIGNER NODE SAYS SO, and it must not read like a funded one.
  const dealtOnly = playersLine({
    joined: true, others: 0, stake: { dealt: true, hold: { state: 'none', why: null } },
  });
  assert.equal(dealtOnly, '1 player · waiting · stake dealt, unpaid');
  assert.notEqual(dealtOnly, playersLine({ joined: true, others: 0 }),
    'a free round reads exactly like a funded one');

  // AND A HOLD IS COUNTED, NOT NAMED: the node's join-time HELD also covers an
  // invoice nobody has paid (M3.3-21, stake-seen.test.js). The reason there is
  // no hold is still the node's own word, printed beside it.
  assert.equal(stakeLine({ dealt: true, hold: { state: 'HELD' } }), ' · stake dealt, not yet counted');
  assert.equal(stakeLine({ dealt: true, hold: { state: 'none', why: 'no lightning port' } }),
    ' · stake dealt, unpaid (no lightning port)');
  assert.equal(stakeLine(null), '');

  // AND THE PAGE HANDS THEM OVER. The chip is in the one file node --test
  // cannot load, so what is pinned is that it calls the rule with the two
  // things it learned.
  const page = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
  assert.match(page, /joinRefused,\s*stake/, 'the chip is not told why there is no signer node');
  assert.match(page, /net\.client\.joinHold/, 'the chip invents the funding word instead of reading the node\'s');
  assert.ok(!page.includes('THE STAKE IS NOT PAID'),
    'the page still asserts a funding state it did not measure');
});

/**
 * THE NODE ALREADY ANSWERS WHETHER THERE IS A HOLD, and nothing read it.
 *
 * 23.1 issues the hold AT THE SIGNER NODE: `POST /entry` calls `custody.hold` and
 * answers `x-hold` with the state or `x-hold-why` with the reason there is
 * none. Both headers were dropped on the floor, so a page wanting to tell a
 * player whether their stake was funded had to guess - and the first close of
 * this letter guessed, printing "the stake is not paid" as a constant.
 */
test('joining keeps the hold the node reported', async () => {
  const world = await daemons(SHARES_NEEDED);
  try {
    const settlement = world.nodes.map((n) => n.round.pubkey);
    const joined = await pageJoins(world, settlement);
    const client = new Client({
      base: `http://127.0.0.1:${world.nodes[0].port}`,
      core: {}, sign: async () => new Uint8Array(64), verify: () => true,
    });
    assert.equal(client.joinHold, null, 'a client that has joined nothing claims a hold');
    assert.deepEqual(client.hold, [], 'the signer node hold was written over the tick buffer');
    await client.join(joined.entry);
    assert.ok(client.joinHold, 'the hold the node reported was thrown away');
    // AND THE TICK BUFFER IS STILL A BUFFER. Written as `this.hold` first,
    // which is the array `record` pushes into: every suite stayed green
    // because the jslib happens to call `setRound` after `join` and `setRound`
    // puts the array back.
    assert.deepEqual(client.hold, [], 'joining replaced the tick buffer with the signer node hold');
    // This daemon has no Lightning, so there is no hold and it says why - which
    // is exactly the state every page is in until M3.2.
    assert.equal(client.joinHold.state, 'none');
    assert.ok(client.joinHold.why && client.joinHold.why.length, 'the node gave no reason there is no hold');
    console.log(`  the node answered x-hold: ${client.joinHold.state} (${client.joinHold.why})`);
    assert.equal(stakeLine({ dealt: true, hold: client.joinHold }),
      ` · stake dealt, unpaid (${client.joinHold.why})`);
  } finally { await world.close(); }
});

/**
 * AND THE ENTRY'S FEE STANDS, which every entry the page ever built did not.
 *
 * `feeMatchesEntry` says an entry's `feeMsat` must be exactly 2% of its own
 * `stakeMsat` - too little and the round collected less than the fee table will
 * owe its nodes, too much and the excess is income no table allocates. It had
 * ZERO CALLERS outside its own tests, and `entryFor` wrote `feeMsat: 0n`, so on
 * the fixture stake every paying entry was charged 0 where 2000 is owed.
 */
test('a paying entry from the page is charged the fee the round asks', async () => {
  const world = await daemons(SHARES_NEEDED);
  try {
    const joined = await pageJoins(world, world.nodes.map((n) => n.round.pubkey));
    const stands = feeMatchesEntry(joined.entry);
    assert.equal(stands.ok, true, stands.why);
    assert.equal(joined.entry.feeMsat, entryFeeMsat(world.contract.stakeMsat));
    assert.equal(joined.entry.feeMsat, 2000n, 'the fixture stake is not the one this was measured on');
    console.log(`  stake ${world.contract.stakeMsat} msat, fee ${joined.entry.feeMsat} msat - 2%, and it stands`);

    // AND A DAEMON TAKES IT, so the fee is not a number that only satisfies a
    // rule nothing runs.
    const answer = await post(world.nodes[0].port, '/entry', encodeEntryContract(joined.entry));
    assert.equal(answer.status, 201, answer.text);
  } finally { await world.close(); }
});

test('a free round is charged 2% of nothing, and that stands too', async () => {
  const world = await daemons(2, { stakeMsat: 0n });
  try {
    const joined = await pageJoins(world, []);
    assert.equal(joined.entry.feeMsat, 0n);
    assert.equal(feeMatchesEntry(joined.entry).ok, true);
  } finally { await world.close(); }
});

/**
 * A HANDOUT TOO FEW SIGNER NODES HOLD IS A STAKE NOBODY CAN OPEN, AND THE ENTRY IS
 * REFUSED RATHER THAN TAKEN.
 *
 * The first close of this letter posted the handout, counted the acceptances
 * and acted on NONE of them - its own comment said "a signer node that refuses it is
 * counted rather than ignored", which overstated what the code did. Measured
 * with three of seven reachable: the stake needs five to open, the node the
 * page joined joined the player 201, and every other node refused the entry
 * 400 "that entry names shares this node has not accepted". Joined at a paying
 * round with a stake that can never be settled, and told nothing.
 */
test('a handout too few signer nodes hold refuses the entry instead of taking it', async () => {
  const world = await daemons();
  try {
    const settlement = world.nodes.map((n) => n.round.pubkey);
    const only3 = world.nodes.slice(0, 3);
    const joined = await pageJoins(world, settlement, { reachable: only3 });

    assert.equal(joined.put.ok, false, 'three of five needed was treated as enough');
    assert.equal(joined.put.accepted, 3);
    assert.equal(joined.put.needed, SHARES_NEEDED);
    assert.match(joined.put.why, /could never be settled/);
    assert.equal(joined.entry, null, 'the page built an entry for a stake nobody can open');
    console.log(`  ${joined.put.accepted} of ${joined.put.needed} needed: ${joined.put.why}`);

    // AND FIVE IS ENOUGH, so this measures the threshold and not the network.
    const five = await pageJoins(world, settlement, { reachable: world.nodes.slice(0, 5) });
    assert.equal(five.put.ok, true, five.put.why);
    assert.equal(five.put.accepted, SHARES_NEEDED);
    assert.ok(five.entry, 'five signer nodes held the handout and the page still refused');
    const answer = await post(world.nodes[0].port, '/entry', encodeEntryContract(five.entry));
    assert.equal(answer.status, 201, answer.text);
    console.log(`  ${five.put.accepted} of ${five.put.needed}: joined, and a daemon took the entry`);
  } finally { await world.close(); }
});

test('the page acts on the count rather than logging it', () => {
  const page = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
  assert.match(page, /BLWPCLIENT\.postHandout\(/,
    'the page posts the handout itself, so the threshold lives where no test can reach it');
  assert.match(page, /if \(!put\.ok\)/, 'the page does not act on how many signer nodes took the handout');
});
