// The census: which bonds exist at a height, canonicalised and Merkle-rooted.
//
// Two decisions here are load-bearing and both look like details.

import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { TAG, ROLES, PROTOCOL_VERSION, TYPE_CENSUS_LEAF } from './constants.js';
import { parseTransaction, commitmentsOf, witnessItemsOf } from './tx.js';
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
 * `tipHeight` stays the caller's, and that is not the same thing: the tip is
 * OBSERVED chain state, not a rule. Two participants at different tips are two
 * participants at different moments; two participants at different depths are
 * two participants under different law.
 */
function depthRuleOf(contract) {
  if (!contract || !Number.isInteger(contract.censusHeight))
    throw new Error('that round names no census height');
  if (!Number.isInteger(contract.censusConfirmations))
    throw new Error('that round names no confirmation depth');
  return { censusHeight: contract.censusHeight, censusConfirmations: contract.censusConfirmations };
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
export function commitCensus(entries, { contract, tipHeight }) {
  const { censusHeight, censusConfirmations } = depthRuleOf(contract);

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
export function censusInputsId({ contract, tipHeight, entries }) {
  const { censusHeight, censusConfirmations } = depthRuleOf(contract);
  const w = new Writer();
  w.u8(TYPE_CENSUS_LEAF);
  w.u16(PROTOCOL_VERSION);
  w.u32(censusHeight);
  w.u32(censusConfirmations);
  w.u32(tipHeight);
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
export function censusRootMatchesRound(contract, { entries, tipHeight, boundTo }) {
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
  try { bound = censusInputsId({ contract, tipHeight, entries }); }
  catch (e) { return { ok: false, why: `those census inputs cannot be committed to: ${e.message}` }; }
  if (!bound.every((b, i) => b === boundTo[i]))
    return {
      ok: false,
      why: 'those are not the census entries that were published: the set, the '
        + 'height or the depth rule differs from what was committed to',
    };

  let census;
  try {
    census = commitCensus(entries, { contract, tipHeight });
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
export function scanCensus(blocks, { contract, tipHeight, candidates }) {
  if (!Array.isArray(blocks)) throw new Error('scan needs blocks to read');
  if (!Array.isArray(candidates)) throw new Error('scan needs the outpoints to look for');
  const { censusHeight, censusConfirmations } = depthRuleOf(contract);

  const createdAt = new Map();
  const spentAt = new Map();

  for (const block of blocks) {
    if (!Number.isInteger(block.height)) throw new Error('a block names its height');

    // AT OR BEFORE THE CENSUS HEIGHT, and nothing after it. A block later than
    // the census is a block the census did not see, and reading it would make
    // the answer depend on when a node happened to ask.
    if (block.height > censusHeight) continue;

    for (const raw of block.transactions) {
      const tx = parseTransaction(raw);
      const txid = toHex(tx.txid);
      for (let vout = 0; vout < tx.outputs.length; vout++)
        if (!createdAt.has(`${txid}:${vout}`)) createdAt.set(`${txid}:${vout}`, block.height);
      for (const input of tx.inputs)
        spentAt.set(`${toHex(input.previousTxid)}:${input.previousVout}`, block.height);
    }
  }

  const found = [];
  const excluded = [];
  for (const c of candidates) {
    const key = `${toHex(c.txid)}:${c.vout}`;
    const height = createdAt.get(key);

    // AN OUTPOINT THE CHAIN DOES NOT CARRY IS NOT AN ENTRY. It is named rather
    // than silently dropped: a census that quietly lost a bond and one that
    // never had it look identical from the root alone.
    if (height === undefined) {
      excluded.push({ ...c, why: 'no such outpoint at or before that height' });
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
 * IS THIS OUTPUT A BOND? Answered from chain data, not from being told.
 *
 * The census used to take a caller's word for which output was the bond. It
 * checked the transaction and the commitment and never looked at the OUTPUT,
 * so an entry could point anywhere in a real bond transaction and be counted -
 * measured before this existed: a candidate at vout 1, the OP_RETURN, value
 * zero, was accepted as a bond by `deriveCensus`. A publisher could point an
 * entry at a change output instead and inflate its own weight.
 *
 * TWO OF THE FIVE RULES CAN BE READ, AND THREE CANNOT:
 *
 *   readable   the output is P2TR. 5A.3B: "A P2TR output with three spend
 *              paths". The paths are hidden; the class is not - witness v1,
 *              a 32-byte program, `OP_1 <32 bytes>`. An OP_RETURN or a P2PKH
 *              is not the thing 5A.3B describes, whatever else is true.
 *   readable   the advertisement names THIS outpoint. 5A.1 makes the bond
 *              outpoint mandatory, so a body that points somewhere else is
 *              not this output's body. The all-zero txid is read as "the
 *              transaction carrying me", the same reading `acceptAdvert`
 *              settled: 25.1 puts the body in the transaction it names, so
 *              the txid is not knowable when the body is signed.
 *
 *   BLOCKED    the dust output to BOND_MARKER (25.1). The marker is null by
 *              decision. NO BRANCH IS WRITTEN FOR IT: code that would check
 *              a value nobody has chosen cannot be tested, and shipping an
 *              untested path that looks ready is the same fault as writing a
 *              plausible address into `constants.js`.
 *   BLOCKED    the script tree is 5A.3B's template. Taproot reveals a branch
 *              only when it is spent, which is the point of using it.
 *   BLOCKED    the advertisement signature. No curve in this package.
 *
 * So this says "counts as a bond as far as the chain can show" and names what
 * it could not look at. It never says "is a bond" - nothing here can.
 */
export function isTaprootOutput(script) {
  // OP_1 (0x51) then a 32-byte push (0x20): a witness v1 program, BIP341.
  return script instanceof Uint8Array && script.length === 34
    && script[0] === 0x51 && script[1] === 0x20;
}

export const BOND_UNCHECKED = [
  'the dust output to BOND_MARKER (25.1: the marker is null by decision)',
  'the bond script template (5A.3B: a taproot output hides it until spent)',
  'the advertisement signature (no curve in this package)',
];

export function recognizeBond(tx, vout, advert) {
  if (!tx || !Array.isArray(tx.outputs))
    return { ok: false, why: 'that is not a parsed transaction' };
  if (!Number.isInteger(vout) || vout < 0 || vout >= tx.outputs.length)
    return { ok: false, why: 'that transaction has no such output' };

  if (!isTaprootOutput(tx.outputs[vout].script))
    return {
      ok: false,
      why: 'that output is not a taproot output, so it is not the bond 5A.3B describes',
    };

  // AND AN OUTPUT HOLDING NOTHING IS NOT A BOND, whatever shape it is. 5A.3:
  // "The bond is what makes identity expensive. Without it, a Sybil attacker
  // creates arbitrarily many nodes for free and buys arbitrarily many
  // selection chances - the flaw that made v4.4 unsafe." A zero-value output
  // costs its fee and nothing else, so a census that counted them would be
  // that flaw with extra steps. The ROUND's floor is a separate question and
  // a round may set it low; nothing may set it to nothing.
  if (tx.outputs[vout].value <= 0n)
    return { ok: false, why: 'that output holds nothing, so there is no bond at stake' };

  if (!advert || !Number.isInteger(advert.bondVout))
    return { ok: false, why: 'that advertisement names no bond output' };
  if (advert.bondVout !== vout)
    return {
      ok: false,
      why: `that advertisement names output ${advert.bondVout} as its bond, not ${vout}`,
    };

  const carriesUs = advert.bondTxid.every((b) => b === 0);
  if (!carriesUs && !advert.bondTxid.every((b, i) => b === tx.txid[i]))
    return { ok: false, why: 'that advertisement names a different bond transaction' };

  return { ok: true, valueSats: tx.outputs[vout].value, unchecked: BOND_UNCHECKED };
}

/**
 * The body an output commits to, or why there is none.
 *
 * The same reading `acceptAdvert` does, without its inclusion proof: bodies
 * ride in the witness, an output commits to one by its tagged id, and the one
 * taken is the one committed to. Order decides nothing - a transaction
 * committing to two bodies would be one operator advertising twice, not an
 * ambiguity to settle here.
 */
function resolveBody(seen, entry) {
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

  const offered = [];
  const read = (bytes) => {
    try {
      const { body } = splitSignedAdvert(bytes);
      offered.push(decodeAdvert(body));
    } catch { /* not a signed body; most witness items are not */ }
  };
  for (const item of witnessItemsOf(tx)) read(item);
  if (seen.signedAdvert) read(seen.signedAdvert);

  const taken = offered.find((a) =>
    commitments.some((c) => c.length === 32 && advertId(a).every((b, i) => b === c[i])));
  if (!taken)
    return { ok: false, why: 'the bond output commits to a different advertisement' };
  return { ok: true, advert: taken, advertId: advertId(taken), tx };
}

export function resolveCensus(entries, { contract, resolve }) {
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
    const read = resolveBody(seen, e);
    if (!read.ok) { excluded.push({ ...e, why: read.why }); continue; }

    // AND THE OUTPUT ITSELF HAS TO LOOK LIKE A BOND. Until this, the census
    // checked the transaction and the commitment and never the output, so an
    // entry could name any vout of a real bond transaction - the OP_RETURN
    // included - and be counted.
    const bond = recognizeBond(read.tx, e.vout, read.advert);
    if (!bond.ok) { excluded.push({ ...e, why: bond.why }); continue; }

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
    const bondSats = bond.valueSats;

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
    unchecked: BOND_UNCHECKED,
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
export function deriveCensus(blocks, { contract, tipHeight, candidates, resolve }) {
  let scanned;
  try {
    scanned = scanCensus(blocks, { contract, tipHeight, candidates });
  } catch (e) {
    return { ok: false, why: `that census cannot be scanned: ${e.message}` };
  }

  const resolved = resolveCensus(scanned.entries, { contract, resolve });
  if (!resolved.ok) return resolved;

  let census;
  try {
    census = commitCensus(resolved.eligible, { contract, tipHeight });
  } catch (e) {
    return { ok: false, why: `that census cannot be committed: ${e.message}` };
  }

  return {
    ok: true,
    entries: census.entries,
    leaves: census.leaves,
    root: census.root,
    excluded: [
      ...scanned.excluded.map((e) => ({ ...e, step: 'scan' })),
      ...resolved.excluded.map((e) => ({ ...e, step: 'resolve' })),
    ],
    unchecked: resolved.unchecked,
  };
}
