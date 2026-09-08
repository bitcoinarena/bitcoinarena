// WHICH CHAIN THE CENSUS WAS READ FROM.
//
// 5A.2: "The eligible set is therefore a pure function of THE CHAIN up to
// `census_height`. Two parties with the same chain compute the same census."
//
// Measured before this file existed: the census took a bag of {height,
// transactions}. Two chains that disagreed about Bitcoin BOTH derived cleanly,
// to different roots, and nothing in the package could say which was the
// chain. `chainWork` and `mostWork` had implemented 25.1's rule - "block
// headers from several independent sources, MOST WORK WINS" - since the
// checkpoint letter, and the census never reached them.
//
// And the tip was a caller's integer: 899999 gave one census, 899000 another,
// and a tip below the census height printed "-979 confirmations deep", which
// is not a depth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, fromHex } from '../src/hash.js';
import { PROTOCOL_VERSION } from '../src/constants.js';
import { parseTransaction } from '../src/tx.js';
import { workOf, blockHashOf } from '../src/chain.js';
import { bondTransaction } from '../tools/bond.js';
import { chainOf as minedChain, HARD } from '../tools/chainview.js';
import {
  deriveCensus, chainViewOf, bestChainView, scanCensus, commitCensus, censusInputsId,
  censusRootMatchesRound,
} from '../src/census.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), timestamp: 1788700000000n,
});
const BOND = bondTransaction(advertFor(0x11), {
  previousTxid: b32(0xa1), previousVout: 0, value: 60000,
});
const BOND_ID = parseTransaction(BOND).txid;

const HEIGHT = 900000;
const TIP = HEIGHT + 4;
const FROM = HEIGHT - 20;
const contract = {
  censusHeight: HEIGHT, censusConfirmations: 6,
  bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
};
const candidates = [{ txid: BOND_ID, vout: 0, pubkey: b32(0xEE), bondSats: 60000n, roles: ['game'] }];

const view = (at, { tip = TIP, bits } = {}) => {
  const blocks = [];
  for (let h = FROM; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, FROM, bits === undefined ? {} : { bits });
};
const derive = (views) => deriveCensus(views, { contract, candidates, resolve: () => ({ transaction: BOND }) });

const WITH_BOND = { [HEIGHT - 20]: [BOND] };
const WITHOUT = {};

/**
 * CASE 1: A REORG THAT REPLACES THE CENSUS BLOCK.
 *
 * Both chains are real, mined and linked. One carries the bond and one does
 * not. They are not two censuses - one of them is the chain, and 25.1 says
 * which: the one with the most work.
 */
test('when two chains disagree, the heavier one is the census and the lighter is not another', () => {
  const light = view(WITHOUT);
  const heavy = view(WITH_BOND, { bits: HARD });

  assert.ok(chainViewOf(heavy).work > chainViewOf(light).work, 'the fixture is not a contest');

  const seen = derive([light, heavy]);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.entries.length, 1, 'the heavier chain was not the census');
  assert.equal(seen.work, chainViewOf(heavy).work);

  // and the other way round: heavier chain WITHOUT the bond, and the bond is
  // not in the census however real the lighter chain that carries it is
  const heavyEmpty = view(WITHOUT, { bits: HARD });
  const lightBond = view(WITH_BOND);
  const other = derive([lightBond, heavyEmpty]);
  assert.equal(other.entries.length, 0, 'a lighter chain put a bond in the census');
  assert.match(other.excluded[0].why, /no such outpoint/);

  // the two roots differ, which is the point: this is a decision, not a merge
  assert.notEqual(toHex(seen.root), toHex(other.root));

  // and order does not decide it
  assert.equal(derive([heavy, light]).entries.length, 1);
  assert.equal(derive([heavyEmpty, lightBond]).entries.length, 0);
});

/**
 * CASE 2, UNCHANGED: a reorg AFTER census_height that does not touch the bond
 * block. This is what `census_confirmations` exists for and it needed nothing.
 */
test('a reorg after the census height does not move the census', () => {
  const before = derive([view(WITH_BOND)]);
  const after = derive([view({ ...WITH_BOND, [HEIGHT + 3]: [] })]);

  assert.equal(before.entries.length, 1);
  assert.equal(after.entries.length, 1);
  assert.equal(toHex(before.root), toHex(after.root),
    'a block past the census height moved the census');
});

/**
 * CASE 3: TWO COMPETING TIPS WITH DIFFERENT WORK, and the work is real.
 */
test('most work wins, and a header nobody mined carries none of it', () => {
  // the figure the measurement pass recorded, unchanged
  const H100000 = fromHex(
    '0100000050120119172a610421a6c3011dd330d9df07b63616c2cc1f1cd0020000000000'
    + '6657a9252aacd5c0b2940996ecff952228c3067cc38d4885efb5a4ac4247e9f337221b'
    + '4d4c86041b0f2b5710');
  assert.equal(workOf(H100000).toString(), '62209952899966');

  const light = view(WITH_BOND);
  const heavy = view(WITH_BOND, { bits: HARD });
  assert.equal(bestChainView([light, heavy]).work, chainViewOf(heavy).work);
  assert.equal(bestChainView([heavy, light]).work, chainViewOf(heavy).work);

  // A HEADER CLAIMING WORK IT DID NOT DO. One block, mined at the easy target
  // and then rewritten to claim mainnet's - which is the attack `meetsTarget`
  // exists for: "the difficulty lives in four bytes of the header, so anybody
  // can write down a target of 1... and outweigh the whole of Bitcoin".
  const one = view(WITH_BOND, { tip: HEIGHT });
  const bent = { blocks: one.blocks.map((b) => ({ ...b })), firstHeight: one.firstHeight };
  bent.blocks[0].header = bent.blocks[0].header.slice();
  new DataView(bent.blocks[0].header.buffer).setUint32(72, 0x1d00ffff, true);

  const no = chainViewOf(bent);
  assert.equal(no.ok, false, 'a header claiming unearned work was taken as a chain');
  assert.match(no.why, /not a chain: this header was not mined/);
  assert.equal(no.work, undefined);

  // and it cannot outweigh a real one by claiming a target it never met
  assert.equal(bestChainView([bent, light]).work, chainViewOf(light).work);
  assert.equal(derive([bent]).why, 'that census cannot be scanned: that is not a chain: '
    + 'this header was not mined: its hash does not meet the target it claims');
});

/**
 * A TIP BELOW THE CENSUS HEIGHT IS REFUSED. It used to be accepted and the
 * arithmetic answered "-979 confirmations deep", which is not a depth.
 */
test('a chain that ends before the census height is refused, not counted backwards', () => {
  for (const tip of [HEIGHT - 1, HEIGHT - 10]) {
    const seen = derive([view(WITH_BOND, { tip })]);
    assert.equal(seen.ok, false, `a tip of ${tip} was accepted`);
    assert.match(seen.why, new RegExp(`ends at height ${tip}, before this round's census height ${HEIGHT}`));
    assert.equal(/confirmations deep/.test(seen.why), false, 'a negative depth was printed as a depth');
  }

  // the census height itself is the boundary and it is fine
  assert.equal(derive([view(WITH_BOND, { tip: HEIGHT })]).entries.length, 1);
});

/**
 * AND A CHAIN THAT BEGINS AFTER THE CENSUS HEIGHT IS REFUSED TOO - the mirror
 * of the rule above.
 *
 * Measured: it returned ok, an empty census, and "no such outpoint between
 * height 900001 and 900000", a range that runs backwards, from a view that had
 * not seen one block the census is about.
 */
test('a chain that begins after the census height is refused, not answered emptily', () => {
  const after = (from) => {
    const blocks = [];
    for (let h = from; h <= from + 4; h++) blocks.push({ transactions: [] });
    return minedChain(blocks, from);
  };

  for (const from of [HEIGHT + 1, HEIGHT + 5]) {
    const seen = derive([after(from)]);
    assert.equal(seen.ok, false, `a view starting at ${from} was answered`);
    assert.match(seen.why,
      new RegExp(`begins at height ${from}, after this round's census height ${HEIGHT}`));
    assert.equal(/between height \d+ and \d+/.test(seen.why), false,
      'a backwards range was reported as a search');
  }

  // one block, exactly at the census height, is a view of this census: it
  // begins at it and ends at it, and both boundaries are inclusive
  const exact = minedChain([{ transactions: [BOND] }], HEIGHT);
  const seen = derive([exact]);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.entries.length, 0, 'a bond one confirmation deep passed a floor of six');
  assert.match(seen.excluded[0].why, /1 confirmations deep where this round needs 6/);
});

/**
 * AND THE TIP IS NOT A NUMBER ANYBODY CAN NAME. There is no argument left to
 * pass one through, and a hand-made object claiming to be a checked view is
 * refused: the stamp is a module-private symbol.
 */
test('nobody can assert a tip, and nobody can assert a chain', () => {
  const honest = derive([view(WITH_BOND)]);
  assert.equal(honest.tipHeight, TIP);

  for (const extra of [{ tipHeight: 999999 }, { tipHeight: 0 }]) {
    const tried = deriveCensus(view(WITH_BOND), {
      contract, candidates, resolve: () => ({ transaction: BOND }), ...extra,
    });
    assert.equal(tried.tipHeight, TIP, 'a caller named the tip');
    assert.equal(toHex(tried.root), toHex(honest.root));
  }

  // A HAND-MADE OBJECT CLAIMING TO BE A CHECKED VIEW, at every door that takes
  // one. An earlier draft short-circuited on `view.ok === true`, and the
  // vector generator promptly handed in exactly this: a "chain" with no blocks
  // asserting any tip it liked.
  const forged = { ok: true, blocks: [], tipHeight: 999999, work: 1n << 200n };
  assert.match(derive([forged]).why, /a chain view is at least one block/);

  const real = view(WITH_BOND);
  const entries = derive([real]).entries;
  assert.throws(() => scanCensus(forged, { contract, candidates }), /at least one block/);
  assert.throws(() => commitCensus(entries, { contract, view: forged }), /at least one block/);
  assert.throws(() => censusInputsId({ contract, view: forged, entries }), /at least one block/);
  assert.match(censusRootMatchesRound(
    { censusHeight: HEIGHT, censusConfirmations: 6, censusRoot: b32(9) },
    { entries, view: forged, boundTo: b32(1) }).why, /at least one block/);

  // AND A VERIFIED VIEW, SPREAD AND OVERRIDDEN, IS NOT A VERIFIED VIEW. Object
  // spread copies symbol-keyed properties, so a caller holding an honest view
  // could otherwise have carried the stamp onto any tip it liked. The stamp
  // pins the numbers, so the copy is re-checked and the invented tip is gone.
  const checked = chainViewOf(real);
  assert.equal(checked.tipHeight, TIP);

  const spread = { ...checked, tipHeight: 999999 };
  assert.equal(commitCensus(entries, { contract, view: spread }).entries.length,
    commitCensus(entries, { contract, view: checked }).entries.length);
  assert.equal(toHex(censusInputsId({ contract, view: spread, entries })),
    toHex(censusInputsId({ contract, view: checked, entries })),
    'a spread view carried an invented tip into the committed inputs');

  // an untouched copy is still the same chain, so this is not simply refusing
  // every object that was ever spread
  assert.equal(toHex(censusInputsId({ contract, view: { ...checked }, entries })),
    toHex(censusInputsId({ contract, view: checked, entries })));
});

/**
 * A WINDOW IS NOT THE CHAIN, AND A SHORT ONE SAYS SO RATHER THAN CLAIMING THE
 * BOND IS NOT THERE.
 *
 * Measured: a view starting after the bond's funding block returned ok, an
 * empty census, a different root, and the reason "no such outpoint at or
 * before that height" - a claim about Bitcoin that the view had not looked far
 * enough back to make. 5A.2 says the eligible set is "a pure function of the
 * chain up to census_height", and two parties with the same chain but
 * different windows were quietly computing different censuses.
 *
 * The window cannot be made unnecessary here - a bond can be funded at any
 * height and enumerating them needs BOND_MARKER - so the fix is that the
 * window is COMMITTED and the refusal is honest: a shorter view is a different
 * set of inputs, and `boundTo` catches it.
 */
test('a shorter chain view is a different set of inputs, and says what it could not see', () => {
  const full = view(WITH_BOND);
  const short = (() => {
    const blocks = [];
    for (let h = HEIGHT - 10; h <= TIP; h++) blocks.push({ transactions: [] });
    return minedChain(blocks, HEIGHT - 10);
  })();

  const whole = derive([full]);
  const part = derive([short]);
  assert.equal(whole.entries.length, 1);
  assert.equal(part.entries.length, 0);
  assert.match(part.excluded[0].why,
    new RegExp(`no such outpoint between height ${HEIGHT - 10} and ${HEIGHT}, `
      + 'and this chain view does not reach further back'));
  assert.equal(/at or before that height/.test(part.excluded[0].why), false,
    'the short view claimed the chain does not carry a bond it never looked for');

  // and the two are not interchangeable under one commitment: the window is in
  // the committed inputs, so a root taken over a short view does not pass as
  // one taken over a long view
  const entries = whole.entries;
  assert.notEqual(
    toHex(censusInputsId({ contract, view: full, entries })),
    toHex(censusInputsId({ contract, view: short, entries })),
    'two different windows committed to the same inputs');

  const round = { ...contract, censusRoot: whole.root };
  const swapped = censusRootMatchesRound(round, {
    entries, view: short, boundTo: censusInputsId({ contract, view: full, entries }),
  });
  assert.equal(swapped.ok, false, 'a short window passed under a long window\'s commitment');
  assert.match(swapped.why, /not the census entries that were published/);
});

/**
 * A TIE ON WORK IS NOT DECIDED BY WHOEVER SPOKE FIRST.
 *
 * Measured before this: two chains of equal work, one carrying the bond and
 * one not, gave eligible 1 offered one way round and eligible 0 the other -
 * the same two inputs, two different censuses, chosen by the order a caller
 * happened to list them. 5A.2 says "two parties with the same chain compute
 * the same census", and that was not true of a tie.
 *
 * `mostWork` still takes the first of an equal pair, which is right for a NODE
 * choosing its own tip: that is Bitcoin's first-seen rule and a node is
 * allowed to have been somewhere when a block arrived. A census is not allowed
 * it, so the census breaks the tie on the tip hash - the work itself, so
 * nobody can choose it after the fact.
 */
test('two chains of equal work give one census, whichever order they arrive in', () => {
  const withBond = view(WITH_BOND);
  const without = view(WITHOUT);
  assert.equal(chainViewOf(withBond).work, chainViewOf(without).work, 'the fixture is not a tie');

  const a = derive([withBond, without]);
  const b = derive([without, withBond]);
  assert.equal(toHex(a.root), toHex(b.root), 'the order two equal chains arrived in chose the census');
  assert.equal(a.entries.length, b.entries.length);

  // and the winner is the one with the lower tip hash, not the first offered
  const tip = (v) => toHex(blockHashOf(chainViewOf(v).blocks[chainViewOf(v).blocks.length - 1].header));
  const lower = tip(withBond) < tip(without) ? withBond : without;
  assert.equal(toHex(derive([withBond, without]).root), toHex(derive([lower]).root));

  // AND THE WHOLE HASH DECIDES IT, NOT ITS FIRST BYTE. A mutant that compared
  // one byte survived, because the fixtures above differ there - two tips
  // sharing a first byte would fall through the comparison and go back to
  // whoever spoke first. Found by searching for such a pair, which needs
  // chains that genuinely DIFFER: mining is deterministic here, so a variant
  // is made by putting a different transaction in the first block.
  const byFirstByte = new Map();
  let pair = null;
  for (let n = 0; n < 600 && !pair; n++) {
    const tx = bondTransaction(advertFor(0x11), { previousTxid: b32(n % 256), previousVout: n >> 8 });
    const v = minedChain([{ transactions: [tx] }, { transactions: [] }], HEIGHT - 1);
    const tipHash = blockHashOf(v.blocks[1].header);
    const seen = byFirstByte.get(tipHash[0]);
    if (seen && toHex(blockHashOf(seen.blocks[1].header)) !== toHex(tipHash)) pair = [seen, v];
    else if (!seen) byFirstByte.set(tipHash[0], v);
  }

  assert.ok(pair, 'no two tips sharing a first byte were found, so this asserts nothing');
  const [x, y] = pair;
  assert.equal(blockHashOf(x.blocks[1].header)[0], blockHashOf(y.blocks[1].header)[0]);
  assert.equal(chainViewOf(x).work, chainViewOf(y).work, 'the pair is not a tie');

  const pick = (set) => {
    const best = bestChainView(set);
    return toHex(blockHashOf(best.blocks[best.blocks.length - 1].header));
  };
  assert.equal(pick([x, y]), pick([y, x]),
    'two tips sharing a first byte were decided by arrival order');

  // three-way, in every order, is still one answer
  const third = view({ [HEIGHT - 15]: [BOND] });
  const roots = [
    [withBond, without, third], [third, withBond, without], [without, third, withBond],
  ].map((set) => toHex(derive(set).root));
  assert.equal(new Set(roots).size, 1, 'three equal chains gave more than one census');
});

/**
 * AND A BLOCK CANNOT BE EMPTIED BY OFFERING NOTHING FOR IT.
 *
 * Measured: a real header committing to a real merkle root, handed over with
 * its transaction list stripped, was accepted as a chain and the bond in it
 * vanished from the census - eligible 0, ok true. 25.1 lets a provider OMIT,
 * and omission is answered by asking another; but a view that contradicts its
 * own header is not omitting, it is claiming a block Bitcoin does not have.
 */
test('a block offered with no transactions must have a header that says so', () => {
  const full = view(WITH_BOND);
  assert.equal(chainViewOf(full).ok, true);

  const stripped = {
    blocks: full.blocks.map((b, i) => (i === 0 ? { header: b.header, transactions: [] } : b)),
    firstHeight: full.firstHeight,
  };
  const no = chainViewOf(stripped);
  assert.equal(no.ok, false, 'a header was emptied of the transactions it commits to');
  assert.match(no.why, new RegExp(`block ${FROM} is offered with no transactions, `
    + 'and its header commits to some'));
  assert.match(derive([stripped]).why, /is offered with no transactions/);

  // a block that really carries nothing is still fine: its header commits to
  // nothing either, which is what the padding in these fixtures is
  assert.equal(chainViewOf(view(WITHOUT)).ok, true);
});

/**
 * A BAG OF BLOCKS IS NOT A CHAIN, and each way of not being one says so.
 */
test('headers, links and containment are all required', () => {
  assert.match(derive([{ blocks: [{ transactions: [] }], firstHeight: FROM }]).why,
    /every block in a chain view carries its header/);

  // two chains that do not follow one another
  const a = view(WITH_BOND);
  const b = view(WITHOUT);
  const spliced = { blocks: [a.blocks[0], b.blocks[2]], firstHeight: FROM };
  assert.match(chainViewOf(spliced).why, /does not follow the one before it/);

  // A REAL MINED HEADER WITH A FABRICATED TRANSACTION LIST. Without this the
  // headers would be decoration: 25.1 says a provider "can OMIT but not
  // FORGE", and forging is exactly what putting a transaction under somebody
  // else's header would be.
  const swapped = view(WITHOUT);
  swapped.blocks[0] = { header: swapped.blocks[0].header, transactions: [BOND] };
  const no = chainViewOf(swapped);
  assert.equal(no.ok, false);
  assert.match(no.why, new RegExp(`block ${FROM} does not contain the transactions offered with it`));
  assert.match(derive([swapped]).why, /does not contain the transactions offered with it/);

  // and the honest one passes, so the check is not simply always refusing
  assert.equal(chainViewOf(view(WITH_BOND)).ok, true);
  assert.equal(toHex(blockHashOf(view(WITH_BOND).blocks[0].header)).length, 64);
});
