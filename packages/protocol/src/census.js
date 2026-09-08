// The census: which bonds exist at a height, canonicalised and Merkle-rooted.
//
// Two decisions here are load-bearing and both look like details.

import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { TAG, ROLES, PROTOCOL_VERSION, TYPE_CENSUS_LEAF, networkOf } from './constants.js';
import { parseTransaction, commitmentsOf, witnessItemsOf, blockMerkleRoot } from './tx.js';
import {
  recognizeBond, isTaprootOutput, BOND_UNCHECKED, chainWork, merkleRootOf, blockHashOf,
  paysBondMarker,
} from './chain.js';
import { decodeAdvert, splitSignedAdvert, advertId } from './advert.js';

/**
 * One census entry, encoded.
 *
 * The outpoint leads because it is what the entry is sorted and identified by.
 *
 * `pubkey` IS THE ADVERTISEMENT'S DECLARED KEY, not a candidate's claim about
 * it. RESOLVE overwrites the field with `advert.nodePubkey` before anything
 * hashes it, for the same reason it overwrites `roles`: the body is what the
 * bond committed to, and the row beside it is somebody's transcription. A leaf
 * over the transcription would let a publisher put a key that never bonded
 * into the census, and the committee seed, the receipts and the payout all
 * read that key.
 */
// Recognition lives in `chain.js` now: it answers about an OUTPUT, and both
// this file and `acceptAdvert` need it, so it cannot sit in either one of
// them and be imported by the other. Re-exported here because the census is
// where most callers meet it.
export { recognizeBond, isTaprootOutput, BOND_UNCHECKED };

export function encodeEntry(e) {
  const w = new Writer();
  w.bytes32(e.txid);
  w.u32(e.vout);
  w.bytes32(e.pubkey);
  w.u64(e.bondSats);
  w.u32(e.height);
  w.vec([...e.roles].sort(), (r, ww) => ww.u8(ROLES.indexOf(r)),
        { sortedBy: (a, b) => (a < b ? -1 : a > b ? 1 : 0) });
  return w.finish();
}

export const leafHash = (e) => taggedHash(TAG.censusLeaf, encodeEntry(e));

/**
 * Compare two entries by (txid, vout).
 *
 * NOT by H(pubkey), which earlier drafts specified and which looks equivalent.
 * It is not: a node can grind a pubkey until its hash lands wherever it likes,
 * and the census order feeds the committee seed. A txid cannot be chosen after
 * the funding transaction is confirmed.
 */
export function compareEntries(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a.txid[i] !== b.txid[i]) return a.txid[i] < b.txid[i] ? -1 : 1;
  }
  return a.vout === b.vout ? 0 : a.vout < b.vout ? -1 : 1;
}

/**
 * Merkle root over the sorted leaves.
 *
 * An odd node is PROMOTED, not duplicated. Duplicating the last leaf is what
 * Bitcoin does and it is why CVE-2012-2459 exists: two different leaf sets can
 * produce one root. Promotion has no such pair.
 */
export function merkleRoot(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; }
      const pair = new Uint8Array(64);
      pair.set(level[i], 0);
      pair.set(level[i + 1], 32);
      next.push(taggedHash(TAG.censusBranch, pair));
    }
    level = next;
  }
  return level[0];
}

/**
 * THE HEIGHT AND THE DEPTH, BOTH OFF THE CONTRACT.
 *
 * 5A.11: "The Round Contract contains: `census_height, census_confirmations`."
 * The height was taken from the contract already and the depth beside it was
 * still an argument, so a caller could recompute an honest census at a depth
 * nobody signed up to - and a census is what picks the committee.
 *
 * AND THE TIP IS THE CHAIN'S. It used to be a caller's integer, and the old
 * comment here said that was fine because "the tip is OBSERVED chain state,
 * not a rule". Observed from what? There was no chain in this file to observe
 * it from, so it was asserted: a high tip matured a shallow bond and a low one
 * emptied the census. It is now the last height of the view the census was
 * read from, which is what makes that sentence true.
 */
function depthRuleOf(contract, view) {
  if (!contract || !Number.isInteger(contract.censusHeight))
    throw new Error('that round names no census height');
  if (!Number.isInteger(contract.censusConfirmations))
    throw new Error('that round names no confirmation depth');

  // A TIP BELOW THE CENSUS HEIGHT IS NOT A SHALLOW CHAIN, IT IS THE WRONG
  // QUESTION. The census is the chain up to `census_height`, so a view that
  // ends before it has not reached the census yet - and the arithmetic said so
  // by printing "-979 confirmations deep", which is not a depth and not an
  // answer.
  if (view.tipHeight < contract.censusHeight)
    throw new Error(
      `that chain ends at height ${view.tipHeight}, before this round's census `
      + `height ${contract.censusHeight}`);

  // AND A VIEW THAT BEGINS AFTER IT CARRIES NO BLOCK THE CENSUS IS ABOUT.
  // Measured: it returned ok, an empty census, and the reason "no such outpoint
  // between height 900001 and 900000" - a range that runs backwards, from a
  // view that had not seen a single block at or before the census height. The
  // mirror of the rule above: one end of the window has to be on each side of
  // `census_height` or the view is not looking at this census at all.
  if (view.firstHeight > contract.censusHeight)
    throw new Error(
      `that chain begins at height ${view.firstHeight}, after this round's census `
      + `height ${contract.censusHeight}`);

  return {
    censusHeight: contract.censusHeight,
    censusConfirmations: contract.censusConfirmations,
    tipHeight: view.tipHeight,
  };
}

/**
 * 5A.4 STEPS 4 AND 5: sort by outpoint, hash the leaves, root them.
 *
 * Immutable per height by construction - the same inputs give the same root,
 * which is what lets a node compute it once and cache it forever.
 *
 * NO ROOT OVER AN UNRESOLVED ENTRY. Every entry must carry the id of the
 * advertisement it resolved to, and RESOLVE is the only thing that puts one
 * there. This is not a flag: `advertId` is the hash the bond output committed
 * to, the thing step 2 exists to find. Without the guard the natural way to
 * use this package - scan, then root - skipped steps 2 and 3 in silence and
 * produced a root over nodes nobody had checked.
 *
 * 5A.4 wants that hash IN the leaf ("outpoint || advertisement hash || ..."),
 * where this leaf still carries a pubkey. That divergence is recorded and not
 * fixed here because it moves every census root; requiring the hash to be
 * KNOWN costs nothing and moves nothing.
 *
 * The height, depth and spend filters are re-applied rather than trusted from
 * upstream. SCAN read them off the chain; repeating them here means a set that
 * reaches this function by some other road cannot smuggle a late or spent
 * output into a root.
 */
export function commitCensus(entries, { contract, view }) {
  const { censusHeight, censusConfirmations, tipHeight } = depthRuleOf(contract, viewOrThrow(view));

  for (const e of entries)
    if (!(e.advertId instanceof Uint8Array) || e.advertId.length !== 32)
      throw new Error('that entry has not been resolved: no advertisement stands behind it');

  const eligible = entries
    .filter((e) => e.height <= censusHeight)
    .filter((e) => tipHeight - e.height + 1 >= censusConfirmations)
    .filter((e) => !e.spent)
    .sort(compareEntries);

  for (let i = 1; i < eligible.length; i++)
    if (compareEntries(eligible[i - 1], eligible[i]) === 0)
      throw new Error('duplicate outpoint in census');

  const leaves = eligible.map(leafHash);
  return { entries: eligible, leaves, root: merkleRoot(leaves) };
}

/**
 * THE ENTRIES A ROOT WAS TAKEN OVER, AS ONE HASH.
 *
 * 5A.4 makes the root a function of a set and a height: "census_root[role] =
 * Merkle root over their canonical serialization". So a check that a contract
 * names the right root is a comparison against a SET, and a set an accuser
 * chooses is no check at all - hand in a different list and any honest
 * contract looks wrong.
 *
 * The same discipline `payoutInputsId` needed for row 3 of 5A.3, and for the
 * same reason: whoever presents the accusation must be bound to the inputs
 * before the arithmetic is worth anything.
 *
 * SORTED THE CENSUS'S OWN WAY, by outpoint, not by a second rule invented
 * here. 5A.4 is explicit that sorting by `H(node_pubkey)` is grindable - "a
 * node can mine a pubkey to sit anywhere it likes" - and the census already
 * sorts by `(funding_txid, vout)`, which cannot be chosen after the fact.
 */
export function censusInputsId({ contract, view, entries }) {
  const chain = viewOrThrow(view);
  const { censusHeight, censusConfirmations, tipHeight } = depthRuleOf(contract, chain);
  const firstHeight = chain.firstHeight;
  const w = new Writer();
  w.u8(TYPE_CENSUS_LEAF);
  w.u16(PROTOCOL_VERSION);
  w.u32(censusHeight);
  w.u32(censusConfirmations);
  w.u32(tipHeight);

  // AND WHERE THE CHAIN THE ROOT WAS TAKEN OVER STARTED. Measured: a view
  // beginning after a bond's funding block reports that bond as "no such
  // outpoint" and derives a DIFFERENT root, ok and all - so two parties with
  // the same chain but different windows agreed on nothing and were told
  // nothing. 5A.2 says the eligible set is "a pure function of the chain up to
  // census_height", and a window is not the chain. Committing the start does
  // not make a short window correct; it makes it a different set of inputs,
  // which is what `boundTo` is for.
  w.u32(firstHeight);
  w.vec([...entries].sort(compareEntries), (e, ww) => {
    ww.bytes(encodeEntry(e), encodeEntry(e).length);
    ww.u8(e.spent ? 1 : 0);
  });
  return taggedHash(TAG.censusInputs, w.finish());
}

/**
 * DOES THIS ROUND NAME THE ROOT ITS OWN CENSUS DERIVES TO?
 *
 * 5A.4: "The Round Contract names `census_height` and both roots. Any
 * participant recomputes them; A CONTRACT WHOSE ROOTS DO NOT MATCH THE CHAIN
 * IS INVALID and no honest node will issue receipts against it."
 *
 * Until this, `censusRoot` was named by every contract and read by no code at
 * all - measured with a grep before the check was written. A round could name
 * any thirty-two bytes and be played, which makes the committee whatever the
 * round's author said it was.
 *
 * THE HEIGHT IS THE CONTRACT'S, not the caller's. Recomputing at another
 * height is recomputing a different census, and a caller who could choose it
 * could make an honest contract look wrong.
 *
 * Answered rather than thrown, like every other decision in this package: a
 * malformed census is a refusal with a reason, not an exception handed to
 * whoever asked whether a round may be played.
 */
export function censusRootMatchesRound(contract, { entries, view, boundTo }) {
  if (!contract || !(contract.censusRoot instanceof Uint8Array)
      || contract.censusRoot.length !== 32)
    return { ok: false, why: 'that round names no census root' };
  if (!Number.isInteger(contract.censusHeight))
    return { ok: false, why: 'that round names no census height' };
  if (!Number.isInteger(contract.censusConfirmations))
    return { ok: false, why: 'that round names no confirmation depth' };
  if (!Array.isArray(entries))
    return { ok: false, why: 'no census entries to derive a root from' };

  // AND THE ENTRIES ARE THE PUBLISHED ONES, not whichever set the asker
  // brought. A root is a function of a SET and a height, so a caller free to
  // choose the set can make any honest contract look wrong by handing in a
  // different list - the same free variable row 3 of 5A.3 had before its
  // inputs were bound, and the same fix: whoever presents the question is
  // bound to the inputs before the arithmetic means anything.
  if (!(boundTo instanceof Uint8Array) || boundTo.length !== 32)
    return { ok: false, why: 'no committed census inputs to check those entries against' };

  let bound;
  try { bound = censusInputsId({ contract, view, entries }); }
  catch (e) { return { ok: false, why: `those census inputs cannot be committed to: ${e.message}` }; }
  if (!bound.every((b, i) => b === boundTo[i]))
    return {
      ok: false,
      why: 'those are not the census entries that were published: the set, the '
        + 'height or the depth rule differs from what was committed to',
    };

  let census;
  try {
    census = commitCensus(entries, { contract, view });
  } catch (e) {
    return { ok: false, why: `that census cannot be built: ${e.message}` };
  }

  const same = census.root.every((b, i) => b === contract.censusRoot[i]);
  return same
    ? { ok: true, root: census.root, entries: census.entries.length, why: 'the censusRoot is the one those entries derive to' }
    : {
      ok: false,
      root: census.root,
      entries: census.entries.length,
      why: 'the censusRoot this round names is not the one its entries derive '
        + `to at height ${contract.censusHeight}`,
    };
}

/**
 * Only `chainViewOf` can stamp a view as checked, and the stamp PINS the
 * numbers a caller could otherwise override. A symbol alone was not enough:
 * `{ ...verified, tipHeight: 999999 }` copies symbol-keyed properties too, so
 * a caller holding an honest view could have spread it and named any tip.
 */
const VERIFIED = Symbol('a chain view this module checked itself');
const stampOf = (v) => `${v.firstHeight}:${v.blocks.length}:${v.tipHeight}`;

/**
 * THE CHAIN A CENSUS IS READ FROM, AND THE PROOF THAT IT IS ONE.
 *
 * 5A.2: "The eligible set is therefore a pure function of THE CHAIN up to
 * `census_height`. Two parties with the same chain compute the same census."
 * That sentence has a load-bearing word in it, and until this the census took
 * a bag of `{height, transactions}` - no header, no work, no link - so two
 * chains that disagreed about Bitcoin both derived cleanly, to different
 * roots, and nothing in the package could say which was the chain.
 *
 * A VIEW IS `{ blocks, firstHeight }`, each block `{ header, transactions }`,
 * and four things are checked, none of them optional:
 *
 *   mined      every header's hash meets the target it claims. `chainWork`
 *              adds a header's work only after that, "because a header nobody
 *              mined contributes whatever difficulty its author felt like
 *              writing down".
 *   linked     each header names the one before it. A list that does not link
 *              is not a chain however long it is.
 *   contained  each block's transactions hash to the merkle root ITS OWN
 *              header commits to. Without this the headers are decoration: a
 *              real mined header with a fabricated transaction list would
 *              pass, which is precisely the forgery 25.1 says a provider must
 *              not be able to commit ("a list provider can then OMIT but not
 *              FORGE").
 *   placed     heights are positional from `firstHeight`, so nobody asserts
 *              one, and the TIP is the last block's height rather than a
 *              number a caller chose.
 *
 * The work is returned so competing views can be compared, which is 25.1's
 * rule: "block headers from several independent sources, MOST WORK WINS".
 */
export function chainViewOf(view) {
  if (!view || !Array.isArray(view.blocks) || !view.blocks.length)
    return { ok: false, why: 'a chain view is at least one block' };
  if (!Number.isInteger(view.firstHeight))
    return { ok: false, why: 'a chain view says which height it starts at' };

  const headers = [];
  for (const block of view.blocks) {
    if (!block || !(block.header instanceof Uint8Array))
      return { ok: false, why: 'every block in a chain view carries its header' };
    if (!Array.isArray(block.transactions))
      return { ok: false, why: 'every block in a chain view carries its transactions' };
    headers.push(block.header);
  }

  const linked = chainWork(headers);
  if (!linked.ok)
    return { ok: false, why: `that is not a chain: ${linked.why}`, at: linked.at };

  const blocks = [];
  for (let i = 0; i < view.blocks.length; i++) {
    const height = view.firstHeight + i;
    let ids;
    try { ids = view.blocks[i].transactions.map((raw) => parseTransaction(raw).txid); }
    catch (e) { return { ok: false, why: `block ${height} carries something that is not a transaction: ${e.message}` }; }

    const claimed = merkleRootOf(view.blocks[i].header);
    if (ids.length) {
      const root = blockMerkleRoot(ids);
      if (!root.every((b, k) => b === claimed[k]))
        return {
          ok: false,
          why: `block ${height} does not contain the transactions offered with it`,
        };
    } else if (!claimed.every((b) => b === 0)) {
      // AND A BLOCK CANNOT BE EMPTIED BY OFFERING NOTHING FOR IT. Measured: a
      // real header committing to a real merkle root, handed over with its
      // transaction list stripped, was accepted as a chain and the bond in it
      // simply vanished from the census. 25.1 allows a provider to OMIT, and
      // the answer to omission is asking another - but a view that CONTRADICTS
      // ITS OWN HEADER is not omitting, it is claiming a block Bitcoin does
      // not have. Every real block has at least a coinbase, so the only
      // transaction list consistent with no transactions is a root of zero.
      return {
        ok: false,
        why: `block ${height} is offered with no transactions, and its header `
          + 'commits to some',
      };
    }
    blocks.push({ height, header: view.blocks[i].header, transactions: view.blocks[i].transactions });
  }

  const checked = {
    ok: true,
    blocks,
    work: linked.work,
    firstHeight: view.firstHeight,
    tipHeight: view.firstHeight + view.blocks.length - 1,
  };
  checked[VERIFIED] = stampOf(checked);
  return checked;
}

/**
 * A view, verified, or the reason it is not one - as a throw, because the
 * functions below it are the ones that already throw on a malformed round.
 *
 * THE `ok` FLAG IS NOT TAKEN ON TRUST. An earlier draft short-circuited on
 * `view.ok === true`, and the vector generator promptly handed in
 * `{ ok: true, blocks: [], tipHeight: 900100 }` - a "chain" with no blocks
 * asserting any tip it liked, which is exactly the hole this letter closed
 * wearing a different hat. The stamp below is a module-private symbol, so only
 * `chainViewOf` can put it there.
 */
function viewOrThrow(view) {
  if (view && view[VERIFIED] && view[VERIFIED] === stampOf(view)) return view;
  const seen = chainViewOf(view);
  if (!seen.ok) throw new Error(seen.why);
  return seen;
}

/**
 * MOST WORK WINS, and it is Bitcoin's rule rather than a vote.
 *
 * 25.1: "block headers from several independent sources, most work wins... A
 * list provider can then OMIT but not FORGE, and omission is answered by
 * asking a second one." A view that is not a chain is not in the running - it
 * is not a competing answer, it is a bad source.
 *
 * A TIE IS BROKEN BY THE TIP HASH, NOT BY WHICHEVER ARRIVED FIRST.
 *
 * `mostWork` takes the first of an equal pair, which is right for a NODE
 * choosing its own tip - that is Bitcoin's first-seen rule, and a node is
 * allowed to have been somewhere when a block arrived. A CENSUS is not allowed
 * that: 5A.2 says "two parties with the same chain compute the same census",
 * and measured before this, two equal-work chains gave eligible 1 offered one
 * way round and eligible 0 the other, from the same two inputs.
 *
 * The tip hash is the intrinsic value to break it on: it is the work itself,
 * so nobody can pick it after the fact, and both parties compute the same
 * comparison from the same two chains. Lower hash wins, arbitrarily but
 * fixed - what matters is that it is the same everywhere.
 */
export function bestChainView(views) {
  const offered = Array.isArray(views) ? views : [views];
  const checked = offered.map(chainViewOf);
  const running = checked.filter((v) => v.ok);
  if (!running.length)
    return { ok: false, why: checked.length ? checked[0].why : 'no chain to read the census from' };

  const tipOf = (v) => blockHashOf(v.blocks[v.blocks.length - 1].header);
  let best = running[0];
  for (const v of running) {
    if (v.work > best.work) { best = v; continue; }
    if (v.work < best.work) continue;
    const a = tipOf(v);
    const b = tipOf(best);
    for (let i = 0; i < 32; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] < b[i]) best = v;
      break;
    }
  }
  return { ...best, refused: checked.filter((v) => !v.ok).map((v) => v.why) };
}

/**
 * 5A.4 STEP 1, SCAN: the chain says where an output was and whether it is
 * still there. Not the party handing the census over.
 *
 * "SCAN all outputs created at or before census_height whose script matches
 * the bond template (5A.3B) and that are unspent at census_height with >=
 * census_confirmations depth."
 *
 * WHAT THIS DOES AND WHAT IT CANNOT. Three of those four conjuncts are read
 * off the blocks here: WHERE an outpoint was created, WHETHER it was spent at
 * or before the census height, and HOW DEEP it is. `commitCensus` applies all
 * three too - to fields the caller supplied. That is the difference: a
 * census used to be a bag of entries someone asserted heights and spends for,
 * and this derives both from the chain, so a publisher who lies about either
 * is caught by anyone holding the same blocks.
 *
 * THE FOURTH CONJUNCT IS NOT HERE AND IS NOT FAKED. Finding which outputs are
 * bonds at all needs `BOND_MARKER` - 25.1's single dust address that puts every
 * bond in the compact filters - and `BOND_MARKER` is `null` in this protocol
 * by a decision recorded in `constants.js`: it is a genesis parameter, fixed
 * once before the first bond exists, and writing a plausible address into a
 * source tree would settle it by accident. `bondMarker()` throws for exactly
 * that reason. So the candidate outpoints come IN - from the advertisements a
 * node already holds, which name `bondTxid` and `bondVout` - and enumerating
 * them from the chain alone waits on that parameter, not on a daemon.
 *
 * A BLOCK IS `{ height, transactions }`, transactions being raw bytes. Nothing
 * here fetches: the caller brings the blocks, and two callers holding the same
 * blocks get the same census or neither does.
 */
/**
 * WHEN EACH OUTPOINT APPEARED AND WHETHER IT WAS SPENT, read off the blocks.
 *
 * One reader, used by SCAN and by RESOLVE, because two readers of the same
 * chain are two answers waiting to differ. 5A.2 makes the census "a pure
 * function of the chain up to census_height", so nothing after that height is
 * looked at: a block later than the census is a block the census did not see,
 * and reading it would make the answer depend on when a node happened to ask.
 */
export function chainFactsAt(blocks, censusHeight) {
  const createdAt = new Map();
  const spentAt = new Map();
  // AND THE OUTPUT ITSELF, for a caller that wants the script without going
  // back to the blocks. RESOLVE does not need it: a resolved transaction is
  // pinned to the entry's txid, and a transaction with that txid cannot have
  // different outputs - the txid IS the hash of them. Reading the script here
  // and comparing it there would be a check that can never fail, which is a
  // worse thing to have than no check at all.
  const outputAt = new Map();

  for (const block of blocks) {
    if (block.height > censusHeight) continue;

    for (const raw of block.transactions) {
      const tx = parseTransaction(raw);
      const txid = toHex(tx.txid);
      for (let vout = 0; vout < tx.outputs.length; vout++) {
        const key = `${txid}:${vout}`;
        if (createdAt.has(key)) continue;
        createdAt.set(key, block.height);
        outputAt.set(key, tx.outputs[vout]);
      }
      for (const input of tx.inputs)
        spentAt.set(`${toHex(input.previousTxid)}:${input.previousVout}`, block.height);
    }
  }
  return { createdAt, spentAt, outputAt };
}

/**
 * WHICH ADVERTISEMENT DOES THIS TRANSACTION COMMIT TO?
 *
 * 5A.2: the bond output "commits to H(NodeAdvertisement)... the body itself
 * travels in the witness of the same transaction, so it is retrievable by
 * anyone with the chain and there is nothing to serve and nothing to keep
 * running". So a transaction answers this about itself, and SCAN and RESOLVE
 * ask it the same way rather than two ways.
 */
function committedAdvertIn(tx) {
  const commitments = commitmentsOf(tx);
  if (!commitments.length) return null;
  for (const item of witnessItemsOf(tx)) {
    try {
      const { body } = splitSignedAdvert(item);
      const advert = decodeAdvert(body);
      const id = advertId(advert);
      if (commitments.some((c) => c.length === 32 && id.every((b, i) => b === c[i]))) return advert;
    } catch { /* not a signed body; most witness items are not */ }
  }
  return null;
}

/**
 * FINDING THE BONDS WITHOUT BEING TOLD WHERE THEY ARE, 5A.4 step 1.
 *
 * Until now SCAN threw unless a caller handed it the outpoints, so every
 * census in this tree was a census of a list somebody else made - and 25.1
 * answers "which nodes count?" with "Bitcoin: bond outputs", not "whatever you
 * were given". A census that has to be told what to look for is a directory
 * with extra steps.
 *
 * The rule is 5A.2's own findability: a funding transaction MUST pay a dust
 * output to this network's BOND_MARKER, "without it the census is unfindable
 * in practice". So a marked transaction is one to read, and the body it
 * commits to says which of its outputs is the bond.
 *
 * WHAT IS *NOT* DONE HERE. The output is not recomputed against the template
 * and the advertisement's signature is not checked - both belong to RESOLVE
 * and both already happen there. A scan that quietly dropped a marked
 * transaction whose output does not recompute would turn an exclusion anybody
 * can audit into a silence nobody can: the entry is FOUND here and refused by
 * name later.
 */
function candidatesIn(blocks, censusHeight, network) {
  const found = [];
  for (const block of blocks) {
    if (block.height > censusHeight) continue;
    for (const raw of block.transactions) {
      let tx;
      try { tx = parseTransaction(raw); } catch { continue; }
      if (!paysBondMarker(tx, network)) continue;

      const advert = committedAdvertIn(tx);
      if (!advert) continue;
      // THE BODY NAMES THE OUTPOINT, and a body that names an output this
      // transaction does not have has named no outpoint at all - there is
      // nothing for RESOLVE to read and nothing to exclude by name.
      if (!tx.outputs[advert.bondVout]) continue;

      // NO AMOUNT. The scan used to copy the output's value in beside the
      // outpoint, and measured, nothing ever read it: RESOLVE takes
      // `output.valueSats` off the funding transaction itself and overwrites
      // the field before the floor is applied or a leaf is hashed. A number
      // carried along that no rule consults is one a later caller can start
      // trusting, so the scan stops writing one.
      found.push({
        txid: tx.txid,
        vout: advert.bondVout,
        pubkey: advert.nodePubkey,
        roles: advert.roles,
      });
    }
  }
  return found;
}

export function scanCensus(view, { contract, candidates }) {
  const chain = viewOrThrow(view);
  const { censusHeight, censusConfirmations, tipHeight } = depthRuleOf(contract, chain);
  const blocks = chain.blocks;
  const firstHeight = chain.firstHeight;

  const { createdAt, spentAt } = chainFactsAt(blocks, censusHeight);

  // GIVEN A LIST, THIS IS WHAT IT ALWAYS WAS. Absent one, the chain is asked -
  // which is what 5A.4 step 1 says a participant does, and what makes the
  // census a function of Bitcoin rather than of whoever answered first.
  const network = contract && contract.networkId ? networkOf(contract.networkId) : undefined;
  if (!Array.isArray(candidates) && contract && contract.networkId && network === null)
    throw new Error('that round names a network this build has no genesis for');
  // A LIST THAT IS NOT A LIST IS STILL A MISTAKE. Omitting it means "ask the
  // chain"; handing something that is not an array means a caller built one
  // and got it wrong, and scanning the chain instead would bury that.
  if (candidates !== undefined && !Array.isArray(candidates))
    throw new Error('scan takes the outpoints as a list, or none at all and reads the chain');
  const looking = candidates === undefined
    ? candidatesIn(blocks, censusHeight, network || 'regtest')
    : candidates;

  const found = [];
  const excluded = [];
  for (const c of looking) {
    const key = `${toHex(c.txid)}:${c.vout}`;
    const height = createdAt.get(key);

    // AN OUTPOINT THE CHAIN DOES NOT CARRY IS NOT AN ENTRY. It is named rather
    // than silently dropped: a census that quietly lost a bond and one that
    // never had it look identical from the root alone.
    //
    // AND THE REASON SAYS WHAT THIS VIEW ACTUALLY KNOWS. A window that begins
    // after a bond's funding block cannot tell "not in the chain" from "below
    // where I start", and it used to claim the first. It still excludes the
    // entry - there is nothing else it could do with an outpoint it cannot see
    // - but it no longer asserts something it has not looked at.
    if (height === undefined) {
      excluded.push({
        ...c,
        why: firstHeight > 0
          ? `no such outpoint between height ${firstHeight} and ${censusHeight}, `
            + 'and this chain view does not reach further back'
          : 'no such outpoint at or before that height',
      });
      continue;
    }

    const entry = { ...c, height, spent: spentAt.has(key) };

    // SCAN APPLIES ITS OWN CONJUNCTS. It used to hand its findings to the
    // commit step and let that do the filtering, which made SCAN a lookup and
    // the root the only place the rules lived. 5A.4 puts "unspent at
    // census_height with >= census_confirmations depth" in step 1, so step 1
    // decides it, and says which rule dropped whom.
    if (entry.spent) {
      excluded.push({ ...entry, why: 'that output was already spent at the census height' });
      continue;
    }
    const depth = tipHeight - height + 1;
    if (depth < censusConfirmations) {
      excluded.push({
        ...entry,
        why: `that output is ${depth} confirmations deep where this round needs ${censusConfirmations}`,
      });
      continue;
    }

    found.push(entry);
  }

  // NO `census` FIELD. It used to return one, and it was a root taken before
  // RESOLVE and FILTER had run - the most natural way to use this package gave
  // back a census over nodes whose advertisements nobody had read. A premature
  // root is not a return value; `deriveCensus` is where a root comes from.
  return { entries: found, excluded };
}

/**
 * 5A.4 STEP 2 (RESOLVE) AND THE 5A.3 FILTERS THAT NEED NOTHING PARKED.
 *
 * "RESOLVE: for each, read the committed H(advertisement) and retrieve the
 * body from the node, a mirror, or any peer. Hash must match. UNRETRIEVABLE
 * BODY -> EXCLUDED (identically for everyone: the hash is public, the content
 * is missing for all)."
 *
 * That parenthesis is the whole reason this can be a rule at all. A missing
 * body is missing for every participant, so excluding it keeps the census
 * canonical instead of making it depend on who could reach what. An entry
 * nobody can resolve is OUT, and it is out the same way everywhere.
 *
 * THREE OF 5A.3's SIX CRITERIA ARE APPLIED HERE, and they are the three that
 * wait on nothing parked:
 *
 *   - the committed advertisement body is retrievable and hash-matching
 *   - `bond_amount >= bond_min(role)`, the floor the ROUND names: "bond_min
 *     (role) is named in the Round Contract, not global"
 *   - the advertisement declares the role and a supported protocol version
 *
 * THE OTHER THREE ARE NOT WORKED AROUND. The bond script template cannot be
 * read off a taproot output - 5A.3B is explicit that the paths nobody uses are
 * never revealed - which is the same wall `BOND_MARKER` stands behind. And the
 * advertisement signature needs a curve this package does not carry, exactly
 * as `provesEquivocation` needs one from its caller. Both are named in the
 * answer rather than silently passed.
 *
 * `resolve` is injected. It is handed an entry and returns the transaction
 * that funded it, or nothing: retrieval is a fetch, and this package fetches
 * nothing. A resolver that throws is a resolver that failed, and a body that
 * cannot be had is excluded rather than allowed to break the census.
 */
/**
 * The body an output commits to, or why there is none.
 *
 * The same reading `acceptAdvert` does, without its inclusion proof: bodies
 * ride in the witness, an output commits to one by its tagged id, and the one
 * taken is the one committed to. Order decides nothing - a transaction
 * committing to two bodies would be one operator advertising twice, not an
 * ambiguity to settle here.
 */
function resolveBody(seen, entry, verifyAdvert) {
  let tx;
  try { tx = parseTransaction(seen.transaction); }
  catch (e) { return { ok: false, why: `that is not a transaction: ${e.message}` }; }

  // IT HAS TO BE THIS ENTRY'S OWN TRANSACTION. 5A.4 resolves the body "for
  // each" output, and a body is only that output's if the transaction is the
  // one the outpoint names. Found by a test that failed honestly: handing back
  // ANOTHER node's bond resolved happily, because a coherent transaction
  // commits to its own body - so an entry at one outpoint could be resolved
  // with an advertisement from somewhere else entirely, endpoint and all.
  if (!entry.txid.every((b, i) => b === tx.txid[i]))
    return { ok: false, why: 'that is a different transaction than the entry names' };

  const commitments = commitmentsOf(tx);
  if (!commitments.length)
    return { ok: false, why: 'no output of that transaction commits to anything' };

  // THE SIGNATURE IS KEPT WITH THE BODY, not dropped on the way past. It used
  // to be discarded here - `const { body } = split...` and the other half
  // thrown away - so a census entry was built from a body nobody had shown was
  // its author's, and the gap was named in `unchecked` instead. Naming a gap
  // is right when nothing can close it; it is not right once a caller can.
  const offered = [];
  const read = (bytes) => {
    try {
      const { body, signature } = splitSignedAdvert(bytes);
      offered.push({ advert: decodeAdvert(body), signature });
    } catch { /* not a signed body; most witness items are not */ }
  };
  for (const item of witnessItemsOf(tx)) read(item);
  if (seen.signedAdvert) read(seen.signedAdvert);

  const taken = offered.find((o) =>
    commitments.some((c) => c.length === 32 && advertId(o.advert).every((b, i) => b === c[i])));
  if (!taken)
    return { ok: false, why: 'the bond output commits to a different advertisement' };

  // AND IF THE CALLER BROUGHT A CURVE, THE SIGNATURE IS CHECKED HERE.
  //
  // This package carries none and must not: it is the one every other package
  // reads, and a hash that pins money should not gain a dependency whose
  // version could change its answer. So `verifyAdvert` is injected the way
  // `provesEquivocation` takes one - and when it is absent the gap is named in
  // `unchecked` exactly as before, rather than a body being called signed
  // because nobody looked.
  //
  // A KEY OF NOTHING AND A SIGNATURE OF NOTHING VERIFY EACH OTHER on ed25519,
  // measured: zero decodes to a point of small order and the equation closes
  // trivially. That is refused here whatever the caller's curve says, because
  // no census entry should rest on a key nobody holds.
  if (verifyAdvert) {
    const zero = (b) => b.every((v) => v === 0);
    if (zero(taken.advert.nodePubkey))
      return { ok: false, why: 'that advertisement names the zero key, which nobody holds' };
    if (zero(taken.signature))
      return { ok: false, why: 'that advertisement carries an empty signature' };
    if (!verifyAdvert(taken.signature, advertId(taken.advert), taken.advert.nodePubkey))
      return { ok: false, why: 'that advertisement is not signed by the node it names' };
  }

  return {
    ok: true, advert: taken.advert, advertId: advertId(taken.advert), tx,
    signatureChecked: !!verifyAdvert,
  };
}

export function resolveCensus(entries, { contract, resolve, verifyAdvert, bond, view }) {
  if (!contract || typeof contract.bondMinSats !== 'bigint')
    return { ok: false, why: 'that round names no bond floor to measure against' };

  // THE VERSION IS THE ROUND'S. It used to be an argument with a default, so
  // whoever called this decided which nodes were selectable - and a version
  // the caller picks is a version the OPERATOR picks, the same fault that
  // moved the objection window and the minimum service into the contract.
  // 27A.7.5 puts it on the round: a node "simply stops being selectable for
  // rounds naming the new hash, exactly as with protocol versions".
  if (!Number.isInteger(contract.protocolVersion))
    return { ok: false, why: 'that round names no protocol version' };
  if (typeof resolve !== 'function')
    return { ok: false, why: 'no way to retrieve an advertisement body' };

  // THE CHAIN'S OWN ANSWER ABOUT EACH OUTPOINT, when a caller brings the view.
  //
  // 5A.2: "a node is in the census if and only if it has a bond output on
  // Bitcoin, CONFIRMED AND UNSPENT at census_height". Until now this function
  // re-applied that RULE to values the entry carried - `e.height`, `e.spent` -
  // so whoever composed the entries decided whether a bond was live. A node
  // resolving a census from somebody else's list could be told a spent bond
  // was unspent, on the single criterion the whole of eligibility rests on.
  //
  // Re-applying a rule to a claimed fact is not verification. With a view the
  // facts are READ, the claims are compared against them, and a disagreement
  // excludes the entry by name rather than being quietly overwritten - a list
  // that lies about the chain is a list to distrust, not to correct.
  // WHICH NETWORK THIS ROUND IS FOR, off its own contract. A contract naming a
  // network this build has no genesis for is refused rather than checked
  // against a guess: `networkOf` answers null, and a census that cannot say
  // where to look for a bond cannot say a bond is findable.
  const network = contract && contract.networkId ? networkOf(contract.networkId) : undefined;
  if (contract && contract.networkId && network === null)
    return { ok: false, why: 'that round names a network this build has no genesis for' };

  let facts = null;
  let depth = null;
  if (view) {
    const chain = viewOrThrow(view);
    depth = depthRuleOf(contract, chain);
    facts = chainFactsAt(chain.blocks, depth.censusHeight);
  }

  const eligible = [];
  const excluded = [];

  for (const e of entries) {
    let seen = null;
    try { seen = resolve(e); }
    catch { seen = null; }

    if (!seen || !seen.transaction) {
      excluded.push({ ...e, why: 'the committed advertisement body could not be retrieved' });
      continue;
    }

    // INCLUSION IS NOT RE-PROVED HERE, and that is deliberate. `acceptAdvert`
    // bundles a merkle proof with the resolution because it is used where
    // nothing has established the transaction is in the chain. SCAN has: it
    // read the blocks. Demanding a header and a branch again would make
    // RESOLVE ask for what step 1 already answered, and 5A.4 asks something
    // narrower of it - read the committed hash, retrieve the body, match.
    const read = resolveBody(seen, e, verifyAdvert);
    if (!read.ok) { excluded.push({ ...e, why: read.why }); continue; }

    // AND THE OUTPUT ITSELF HAS TO LOOK LIKE A BOND. Until this, the census
    // checked the transaction and the commitment and never the output, so an
    // entry could name any vout of a real bond transaction - the OP_RETURN
    // included - and be counted.
    // AND WITH THE NETWORK'S OWN SET AND A CURVE, THE OUTPUT KEY TOO. A door
    // nobody walks through is not a door: `recognizeBond` learned to rebuild
    // the key a node's own keys produce, and the census is where that has to
    // be asked, because this is what decides who may hold a round. Without the
    // set the census counts what it always counted and still lists the gap.
    // THE MARKER IS CHECKED ON THE CONTRACT'S OWN NETWORK. `recognizeBond`
    // defaults to regtest, and the census held the round's `networkId` and
    // never passed it - so a testnet4 census would have looked for the regtest
    // marker, which is a different address, and accepted a bond posted on
    // another chain. 5A.2 makes that dust output the whole of findability.
    const output = recognizeBond(read.tx, e.vout, read.advert, {
      ...(bond ? { bond } : {}),
      ...(network ? { network } : {}),
    });
    if (!output.ok) { excluded.push({ ...e, why: output.why }); continue; }

    let chainSays = null;
    if (facts) {
      const key = `${toHex(e.txid)}:${e.vout}`;
      const height = facts.createdAt.get(key);
      if (height === undefined) {
        excluded.push({ ...e, why: 'the chain does not carry that outpoint at or before the census height' });
        continue;
      }
      if (Number.isInteger(e.height) && e.height !== height) {
        excluded.push({
          ...e,
          why: `that entry claims height ${e.height} and the chain says ${height}`,
        });
        continue;
      }
      if (facts.spentAt.has(key)) {
        excluded.push({
          ...e,
          why: `that bond was spent at height ${facts.spentAt.get(key)}, so nothing is at stake`,
        });
        continue;
      }
      const deep = depth.tipHeight - height + 1;
      if (deep < depth.censusConfirmations) {
        excluded.push({
          ...e,
          why: `that bond is ${deep} block(s) deep and this round asks for `
            + `${depth.censusConfirmations}`,
        });
        continue;
      }
      // The chain's own numbers replace the claimed ones from here on: an
      // entry that agreed is an entry whose height came from the blocks.
      chainSays = { height, spent: false };
    }

    // AND THE AMOUNT IS THE CHAIN'S. This was the entry's own claim, measured:
    // an output worth 60000 sats, an entry claiming 100000000000, accepted -
    // and carrying weight 2000000 into `selectCommittee` instead of weight 1.
    //
    // 5A.3 says why that is not a detail: "The bond is what makes identity
    // expensive. Without it, a Sybil attacker creates arbitrarily many nodes
    // for free and buys arbitrarily many selection chances - the flaw that
    // made v4.4 unsafe." A bond that is asserted rather than observed costs
    // nothing, so believing the claim reinstates exactly that flaw. The leaf
    // hashes this number too, so the lie went into the census root.
    const bondSats = output.valueSats;

    // THE FLOOR IS THE ROUND'S. 5A.3: "bond_min(role) is named in the Round
    // Contract, not global... a node is eligible for THAT ROUND or not."
    if (bondSats < contract.bondMinSats) {
      excluded.push({
        ...e,
        bondSats,
        why: `that bond is ${bondSats} where this round's floor is ${contract.bondMinSats}`,
      });
      continue;
    }

    // AND THE ADVERTISEMENT HAS TO DECLARE WHAT IT IS. A body that names no
    // role this census is for, or speaks no version this software does, is a
    // node that has not said it can serve the round it is being counted into.
    const roles = read.advert.roles || [];
    if (!roles.length) { excluded.push({ ...e, why: 'that advertisement declares no role' }); continue; }

    const versions = read.advert.protocolVersions || [];
    if (!versions.includes(contract.protocolVersion)) {
      excluded.push({
        ...e,
        why: `that advertisement speaks ${versions.join(', ') || 'no version'} and this `
          + `round runs ${contract.protocolVersion}`,
      });
      continue;
    }

    // THE RESOLVED BODY REPLACES WHATEVER THE ENTRY CLAIMED - the roles, and
    // the key. The body is what the bond committed to; the entry beside it is
    // somebody's summary. The key mattered more than the roles and was missed
    // the first time: the leaf hashes `pubkey`, so a census over transcriptions
    // would name a key that never bonded, and the committee seed, the receipts
    // and the payout table all read that key afterwards.
    eligible.push({
      ...e,
      // The chain's height and spend state where a view gave them, so what
      // goes into a root is what the blocks said and not what a list claimed.
      ...(chainSays || {}),
      bondSats,
      pubkey: read.advert.nodePubkey,
      roles,
      advert: read.advert,
      advertId: read.advertId,
    });
  }

  return {
    ok: true,
    eligible,
    excluded,
    // WHAT IS STILL UNCHECKED SHRINKS WHEN A CALLER BRINGS A CURVE. Reporting
    // the signature as unchecked after checking it would be as wrong as not
    // checking it: the list is what a reader is asked to take on trust.
    // WHAT IS STILL UNCHECKED SHRINKS AS CALLERS BRING WHAT IT TAKES: the
    // signature needs a curve, the script template needs the network's set and
    // a curve. Reporting either as unchecked after checking it would be as
    // wrong as not checking it.
    chainChecked: !!view,
    unchecked: [
      ...BOND_UNCHECKED.filter((u) => {
        if (verifyAdvert && /advertisement signature/.test(u)) return false;
        if (bond && /script template/.test(u)) return false;
        return true;
      }),
      // AND THE ONE THIS FUNCTION ITSELF CANNOT ANSWER WITHOUT A CHAIN. Named
      // rather than silently taken from the entry, because "the list said so"
      // is not a check and a reader deserves to know which it got.
      ...(view ? [] : ['whether the output is unspent and deep enough at '
        + 'census_height (no chain view was given, so the entry was believed)']),
    ],
  };
}

/**
 * 5A.4, ALL FIVE STEPS, AND THE ONLY PLACE A CENSUS ROOT COMES FROM.
 *
 * "Given `census_height`, EVERY PARTICIPANT RUNS THE SAME FIVE STEPS." Five
 * steps that only join when a caller remembers to join them are not a
 * derivation, they are parts - and the parts were reachable in the wrong
 * order. `scanCensus` handed back a root of its own with steps 2 and 3
 * unrun, so the shortest path through this package produced a census over
 * nodes whose advertisements nobody had read. That is the defect this closes:
 *
 *   1. SCAN     the blocks say where each candidate outpoint was created,
 *               whether it was spent by the census height, and how deep it is.
 *   2. RESOLVE  the committed advertisement body, retrieved and hash-matched.
 *   3. FILTER   5A.3's objective criteria, the three that wait on nothing.
 *   4. SORT     ascending by (funding_txid, vout), which cannot be ground.
 *   5. COMMIT   the tagged leaves, Merkle-rooted, promotion on an odd level.
 *
 * Steps 1 and 2-3 are still separately callable, because a node wants to know
 * WHY somebody was dropped and at which step. Neither of them returns a root.
 *
 * Every exclusion comes back, from either step, carrying the step that made it
 * and the reason. A census that quietly lost a bond and one that never had it
 * look identical from the root alone, and a node accused of publishing the
 * wrong census needs to be able to point at the rule that removed a name.
 *
 * The two 5A.3 criteria this cannot apply come back in `unchecked` as they do
 * from RESOLVE: the bond script template is unreadable until the output is
 * spent, and the advertisement signature needs a curve this package does not
 * carry. Neither is skipped quietly.
 */
export function deriveCensus(views, { contract, candidates, resolve, verifyAdvert, bond }) {
  // MOST WORK WINS, HERE, before anything is read. Two chains that disagree
  // about Bitcoin are not two censuses: one of them is the chain.
  const chain = bestChainView(views);
  if (!chain.ok) return { ok: false, why: `that census cannot be scanned: ${chain.why}` };

  let scanned;
  try {
    scanned = scanCensus(chain, { contract, candidates });
  } catch (e) {
    return { ok: false, why: `that census cannot be scanned: ${e.message}` };
  }

  // THE CHAIN GOES DOWN WITH THEM. Derive holds the view it just scanned, so
  // resolving from entries whose height and spend state it could re-read and
  // did not would be the door-nobody-walks-through fault one function deeper.
  const resolved = resolveCensus(scanned.entries, {
    contract, resolve, verifyAdvert, bond, view: chain,
  });
  if (!resolved.ok) return resolved;

  let census;
  try {
    census = commitCensus(resolved.eligible, { contract, view: chain });
  } catch (e) {
    return { ok: false, why: `that census cannot be committed: ${e.message}` };
  }

  return {
    ok: true,
    entries: census.entries,
    leaves: census.leaves,
    root: census.root,
    work: chain.work,
    tipHeight: chain.tipHeight,
    refusedChains: chain.refused || [],
    excluded: [
      ...scanned.excluded.map((e) => ({ ...e, step: 'scan' })),
      ...resolved.excluded.map((e) => ({ ...e, step: 'resolve' })),
    ],
    unchecked: resolved.unchecked,
    chainChecked: resolved.chainChecked,
  };
}
