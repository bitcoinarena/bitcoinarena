// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT BUILDS THE COMMITTEE ITSELF (spec 5A.6: "a client MUST NOT take a census, a committee or an
// endpoint on the word of any API"). Until this the page asked every node GET /committee and took the set when they
// agreed - so a set of colluding seats could name any committee and be dealt a player's stake.
//
// Here the client derives it from what it checks itself:
//   HEADERS   the chain it agreed from independent providers (directory.js agreedChain), from a compiled-in anchor;
//   CENSUS    every entry of the round's census as EVIDENCE a seat hands over (GET /census): its bond transaction proven
//             into one of those headers, the advertisement it commits to, the output rebuilt as the bond from the
//             network's arbitration set and a curve, its maturity, its floor - and, for a carried bond, its
//             re-affirmation and update, proved and signed by the bond's key. The verified set must hash to the round's
//             own census_root (censusRootOf, the seat's own function): an entry left out, added or altered is another
//             root, and the round is refused. Spentness at census_height is in that root.
//   BEACON    the first block whose median time is past committee_time, deep enough - off the same headers
//             (beaconFromChain), its hash the randomness (committeeSeedFromBeacon);
//   SORTITION selectCommittee over the verified entries, the function a seat's Roster.committeeFor runs.
// This package carries no curve and no signature scheme: `bond` brings the curve operations, `verify` BIP-340.
import { tableAnchorOf } from './known-game.js';
import { parseTransaction, commitmentsOf, witnessRunsOf } from './tx.js';
import { splitSignedAdvert, decodeAdvert, advertId } from './advert.js';
import { blockHashOf, provesTransaction, recognizeBond, merkleRootFromProof } from './chain.js';
import { decodeAncestorAdvert } from './ancestor.js';
import { acceptAncestorEndpoint } from './ancestor-endpoint.js';
import { readAdvertUpdate } from './advert-update.js';
import { bondPresigStands } from './slash-presig.js';
import { maturityStands } from './bond-script.js';
import { bondNamesStandingKey, censusKeyAnchorIn, censusKeyBodyIn, censusKeyContract, censusKeyDrawHeight, censusKeyRecordDue, censusKeyRecordStands, censusKeyShares } from './census-key.js';
import { BOND_TEMPLATE_V3 } from './bond-script.js';
import { censusRootOf, sumsBonds, floorOnSums } from './census.js';
import { beaconFromChain, committeeSeedFromBeacon } from './beacon.js';
import { selectCommittee, drawCommittee, slotsForRole, drawAttestors } from './sortition.js';
import { networkOf, CLIENT_CENSUS_FLOOR_BPS } from './constants.js';
import { toHex, fromHex } from './hash.js';
import { medianTimePast } from './beacon.js';
import { decodeRoundContract, roundId } from './contracts.js';
import { seatingCloseMs } from './seating.js';
import { checkAbsenceProof, presenceWindow, dropsAbsent } from './presence.js';
import { checkStallProof, stallWindow, stallsOut } from './stall.js';
import { drawHeartbeat, heartbeatSlotOf, heartbeatCloseMs, hasHeartbeats } from './heartbeat.js';
import { dutyMarkerOf, dutyRoundStands } from './duty.js';
import { creatorMessage, seriesCreatorMessage } from './creator.js';
import { publishesRound } from './publication.js';
import { seriesPublicationPayload } from './series.js';
import { TAG_SWITCH } from './tag-switch.js';

const sameCC = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
const bytesOfCC = (v) => (v instanceof Uint8Array ? v : typeof v === 'string' ? fromHex(v) : null);
const proofOf = (p) => (p ? { transaction: bytesOfCC(p.transaction), branch: (p.branch || []).map(bytesOfCC), position: p.position | 0 } : null);

// THE HEADERS BY THEIR MERKLE ROOT, once per header set: a proof's root is computed once and looked up, instead of
// re-deriving it against each of ~2,000 headers (measured on testnet4: 280 ms an entry, 2 s a census, before this)
const ROOTS = new WeakMap();
function rootsOf(headers) {
  let m = ROOTS.get(headers);
  if (!m) { m = new Map(); headers.forEach((h, i) => m.set(toHex(h.subarray(36, 68)), i)); ROOTS.set(headers, m); }
  return m;
}

/** The height of the agreed header that proves `txid` with this branch, or null. */
function provenAt(headers, firstHeight, txid, proof) {
  let root;
  try { root = merkleRootFromProof(txid, proof.branch, proof.position); } catch { return null; }
  const i = rootsOf(headers).get(toHex(root));
  return i === undefined || !provesTransaction(headers[i], txid, proof.branch, proof.position) ? null : firstHeight + i;
}

/** The Arena advertisement a bond transaction commits to, with its signature. */
function committedSigned(tx) {
  const commitments = commitmentsOf(tx).filter((c) => c.length === 32);
  for (const item of witnessRunsOf(tx)) {
    try {
      const { body, signature } = splitSignedAdvert(item);
      const advert = decodeAdvert(body);
      const id = advertId(advert);
      if (commitments.some((c) => sameCC(c, id))) return { advert, signature, id };
    } catch { /* not a signed body */ }
  }
  return null;
}

/**
 * ONE CENSUS ENTRY FROM ITS EVIDENCE, as RESOLVE and the update/re-affirmation steps of deriveCensus make it - or why not.
 * `item` is { transaction, branch, position, update?, reaffirm?, presig? } (hex or bytes), each proved into `headers`.
 */
export function entryFromEvidence(item, { contract, headers, firstHeight, bond, verify }) {
  const network = networkOf(contract.networkId);
  if (!network) return { ok: false, why: 'that round names a network this client has no genesis for' };
  const b = proofOf(item);
  if (!b || !b.transaction) return { ok: false, why: 'no bond transaction' };
  let tx; try { tx = parseTransaction(b.transaction); } catch (e) { return { ok: false, why: `the bond is not a transaction: ${e.message}` }; }
  const height = provenAt(headers, firstHeight, tx.txid, b);
  if (height === null) return { ok: false, why: `bond ${toHex([...tx.txid].reverse()).slice(0, 16)} is not in any block of the agreed headers` };
  const sig = (s, m, k) => { try { return verify(s, m, k) === true; } catch { return false; } };

  let advert, id, ancestor = false, vout, bondSats;
  const r = proofOf(item.reaffirm);
  if (r && r.transaction) {
    // A CARRIED BOND (spec 0A.9): its ancestor body, its re-affirmation and its update, proved and signed by the bond's key
    // the three headers its proofs name, found by root - acceptAncestorEndpoint proves each into the chain it is handed
    const named = [height, (() => { try { return provenAt(headers, firstHeight, parseTransaction(r.transaction).txid, r); } catch { return null; } })(),
      (() => { const u0 = proofOf(item.update); try { return u0 && u0.transaction ? provenAt(headers, firstHeight, parseTransaction(u0.transaction).txid, u0) : null; } catch { return null; } })()]
      .filter((h) => h !== null).map((h) => headers[h - firstHeight]);
    const carried = acceptAncestorEndpoint({ chain: named, transaction: b.transaction, branch: b.branch, position: b.position,
      update: proofOf(item.update), reaffirm: r });
    if (!carried.ok) return { ok: false, why: carried.why };
    // the re-affirmation's signature, as the seat's census checks it (reaffirmedBonds); the update's below
    for (const c of carried.checks.filter((x) => /re-affirmation/.test(x.what)))
      if (!sig(c.signature, c.message, c.key)) return { ok: false, why: `${c.what} is not signed by the bond's key` };
    const rHeight = provenAt(headers, firstHeight, parseTransaction(r.transaction).txid, r);
    if (rHeight === null || rHeight < height || rHeight > contract.censusHeight)
      return { ok: false, why: 'its re-affirmation is not between the bond and the census height' };
    ancestor = true; vout = carried.bondVout;
    // the bond's own body, for its key and the resolve filters (the ancestor's layout)
    let body = null;
    for (const w of witnessRunsOf(tx)) { try { body = decodeAncestorAdvert(splitSignedAdvert(w).body); if (body.nodePubkey && sameCC(body.nodePubkey, carried.nodePubkey)) break; body = null; } catch { body = null; } }
    if (!body) return { ok: false, why: 'the carried bond\'s ancestor body does not read' };
    advert = body; id = new Uint8Array(32).fill(1);         // the ancestor's id is not a leaf field; it only marks "resolved"
  } else {
    // THE ADVERTISEMENT THE OUTPUT COMMITS TO. Its own signature is not asked, as a seat's census does not ask it
    // (BOND_UNCHECKED): the output key is rebuilt from the node key it names, so the body is bound to the money anyway.
    const c = committedSigned(tx);
    if (!c) return { ok: false, why: 'the bond carries no advertisement its output commits to' };
    advert = c.advert; id = c.id; vout = advert.bondVout;
  }
  const seen = recognizeBond(tx, vout, advert, { network, bond, ...(ancestor ? { ancestor: true } : {}) });
  if (!seen.ok) return { ok: false, why: seen.why };
  bondSats = seen.valueSats;
  const matures = maturityStands(advert, height, network);
  if (!matures.ok) return { ok: false, why: matures.why };
  const named = bondNamesStandingKey(advert, height, bond && bond.standingKeys, Number(contract.censusConfirmations ?? 0));
  if (!named.ok) return { ok: false, why: named.why };
  // A TEMPLATE-3 BOND COUNTS ONLY WITH ITS slash_presig census_confirmations DEEP (5A.3B, RULED 2026-11-02, kanban #1053), as a seat's census asks it: one signature check over the bond, its
  // advertisement and its census key, on the update that posted it, proved into the agreed headers. A seat that hands none has handed a bond the census does not count.
  if (advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3) {
    const p = proofOf(item.presig);
    if (!p || !p.transaction) return { ok: false, why: 'a template-3 bond counts only with its slash_presig, and none was handed' };
    const read = readAdvertUpdate(p.transaction, { network });
    if (!read.ok) return { ok: false, why: read.why };
    const pHeight = provenAt(headers, firstHeight, read.txid, p);
    if (pHeight === null || pHeight < height || contract.censusHeight - pHeight + 1 < Math.max(1, Number(contract.censusConfirmations ?? 0)))
      return { ok: false, why: 'its slash_presig is not between the bond and census_confirmations below the census height' };
    if (!sameCC(read.bondTxid, tx.txid) || read.bondVout !== vout || !sameCC(read.nodePubkey, advert.nodePubkey) || !sig(read.signature, read.advertId, advert.nodePubkey))
      return { ok: false, why: 'its slash_presig is not in an update of this bond by this bond\'s key' };
    if (!read.advert.slashPresig || !bond || !bondPresigStands({ presig: read.advert.slashPresig, bond: { txid: tx.txid, vout, value: BigInt(bondSats), script: tx.outputs[vout].script },
      advert, networkId: contract.networkId, tweakPoint: bond.tweakPoint, verify: sig }))
      return { ok: false, why: 'its slash_presig does not verify over the bond, its advertisement and its census key' };
  }
  // RESOLVE's filters, on the body the bond committed to
  // FROM PROTOCOL 19 THE FLOOR IS THE NODE'S SUM (kanban #544), asked over the whole census below - as a seat's census asks it.
  // Asked per output here, a node's 32,000 top-up was refused where every seat counted it, and no paid round could be joined (#543).
  if (!sumsBonds(contract) && bondSats < contract.bondMinSats) return { ok: false, why: `that bond is ${bondSats} where this round's floor is ${contract.bondMinSats}` };
  // ROLES AND VERSION OFF THE NEWEST ADVERTISEMENT (2026.0.2): a bond whose update announces this round's
  // version counts - asked of its first advertisement, every node that announced version 2 by update was refused (the seats'
  // census had the same order, fixed in e8f039d8). The update, when there is one, is asked below.
  const updated = !!(proofOf(item.update) && proofOf(item.update).transaction);
  if (!updated && !(advert.roles || []).length) return { ok: false, why: 'that advertisement declares no role' };
  if (!updated && !(advert.protocolVersions || []).includes(contract.protocolVersion)) return { ok: false, why: 'that advertisement does not speak this round\'s version' };
  let entry = { txid: tx.txid, vout, pubkey: advert.nodePubkey, bondSats, height, roles: advert.roles, hostedGames: advert.hostedGames, advert, advertId: id,
    ...(ancestor ? { ancestor: true } : {}) };

  // ITS NEWEST UPDATE (§5A.2), when the seat says there is one: proved, for this bond, by this bond's key, at or below the
  // census height. A seat handing an older one, or none, makes the root differ - so omission is caught there.
  const u = proofOf(item.update);
  if (u && u.transaction) {
    const read = readAdvertUpdate(u.transaction, { network });
    if (!read.ok) return { ok: false, why: read.why };
    const uHeight = provenAt(headers, firstHeight, read.txid, u);
    if (uHeight === null || uHeight < height || uHeight > contract.censusHeight) return { ok: false, why: 'its update is not between the bond and the census height' };
    // FROM PROTOCOL 19 THE NODE'S NEWEST UPDATE DECIDES FOR EACH OF ITS OUTPUTS (kanban #544, census.js newestPerNode): a seat hands
    // an output the update of another output of the same node - signed by this bond's key, so it is this node's (kanban #543)
    if (!sumsBonds(contract) && (!sameCC(read.bondTxid, tx.txid) || read.bondVout !== vout)) return { ok: false, why: 'its update names another bond' };
    if (!sameCC(read.nodePubkey, entry.pubkey) || !sig(read.signature, read.advertId, entry.pubkey)) return { ok: false, why: 'its update is not signed by the bond\'s key' };
    const roles = read.advert.roles || [];
    if (!roles.length || !(read.advert.protocolVersions || []).includes(contract.protocolVersion))
      return { ok: false, why: 'its newest update declares no role or not this round\'s version' };
    // each output keeps its own maturity and template (census.js ownMaturity)
    const advertNow = sumsBonds(contract) ? { ...read.advert, bondMaturityHeight: entry.advert.bondMaturityHeight, censusKey: entry.advert.censusKey, bondScriptTemplateVersion: entry.advert.bondScriptTemplateVersion } : read.advert;
    entry = { ...entry, advert: advertNow, advertId: read.advertId, roles, hostedGames: read.advert.hostedGames };
  }
  return { ok: true, entry };
}

/** Does any bond of this evidence name a census key? Only then has a client any standing key to read, and a census without one costs it nothing. */
export function evidenceNamesCensusKey(evidence) {
  return (evidence || []).some((item) => {
    const b = proofOf(item);
    if (!b || !b.transaction || item.reaffirm) return false;
    try { const c = committedSigned(parseTransaction(b.transaction)); return !!c && c.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3; } catch { return false; }
  });
}

/**
 * ONE STANDING KEY, CHECKED BY THE CLIENT (5A.3B, kanban #1048): "a client that cannot count a bond cannot check a draw". A seat hands the anchor with its merkle branch and the census the
 * record names; here the anchor is proved into the agreed headers, the body read from the leaf it spends, the record held to its epoch's rule, every census entry rebuilt as a round's
 * is, and its signatures counted against the shares of that census. So a seat can withhold a key and cannot make one up. Keys are read in chain order: a record's census reads the keys
 * standing below it, in `bond.standingKeys`. `firstHeight` is the network's, `keyFirstHeight` where its keys begin. Answers { ok, key: { epoch, publicKey, height } } or { ok: false, why }.
 */
export function censusKeyRecordFromEvidence({ item, evidence, networkId, network, genesis = null, keyFirstHeight, censusConfirmations, headers, firstHeight, bond, verify, sharesMax = undefined }) {
  const b = proofOf(item);
  if (!b || !b.transaction) return { ok: false, why: 'no anchor transaction' };
  let tx; try { tx = parseTransaction(b.transaction); } catch (e) { return { ok: false, why: `the anchor is not a transaction: ${e.message}` }; }
  const height = provenAt(headers, firstHeight, tx.txid, b);
  if (height === null) return { ok: false, why: 'that anchor is not in any block of the agreed headers' };
  const id = censusKeyAnchorIn(tx.outputs);
  const body = id ? censusKeyBodyIn(tx, id) : null;
  if (!body) return { ok: false, why: 'that transaction is no anchor with its body' };
  const { record, signatures } = body;
  if (!sameCC(record.networkId, networkId)) return { ok: false, why: 'that record is for another network' };
  const due = censusKeyRecordDue({ record, height, network, firstHeight: keyFirstHeight, censusConfirmations });
  if (!due.ok) return due;
  const contract = censusKeyContract({ networkId, network, height: due.censusHeight, censusConfirmations, genesis });
  const entries = [];
  for (const piece of evidence || []) {
    const got = entryFromEvidence(piece, { contract, headers, firstHeight, bond, verify });
    if (!got.ok) return { ok: false, why: `that census holds an entry that does not stand: ${got.why}` };
    entries.push(got.entry);
  }
  const counted = floorOnSums(entries, contract);
  const draw = headers[censusKeyDrawHeight(record.epoch, network) - firstHeight];
  if (!draw) return { ok: false, why: 'the agreed headers do not reach that key\'s draw' };
  const shares = censusKeyShares({ entries: counted.kept, network, genesis, blockHash: Uint8Array.from(blockHashOf(draw)).reverse(), ...(sharesMax ? { sharesMax } : {}) });
  const stands = censusKeyRecordStands({ record, signatures, networkId, shares, verify });
  return stands.ok ? { ok: true, key: { epoch: record.epoch, publicKey: record.publicKey, height } } : stands;
}

/**
 * THE ROUND'S CENSUS, CHECKED BY THE CLIENT: every evidence item an entry, and the set's root the round's census_root.
 * Answers { ok, entries, root } or { ok: false, why, refused: [{ i, why }] }.
 */
export function censusFromEvidence(evidence, { contract, headers, firstHeight, bond, verify }) {
  if (!Array.isArray(evidence) || !evidence.length) return { ok: false, why: 'no census evidence to check' };
  const entries = [], refused = [];
  evidence.forEach((item, i) => {
    const got = entryFromEvidence(item, { contract, headers, firstHeight, bond, verify });
    if (got.ok) entries.push(got.entry); else refused.push({ i, why: got.why });
  });
  if (sumsBonds(contract)) {
    const f = floorOnSums(entries, contract);
    entries.splice(0, entries.length, ...f.kept);
    refused.push(...f.out.map((e) => ({ i: -1, why: e.why })));
  }
  let census;
  try { census = censusRootOf(entries, { censusHeight: contract.censusHeight, censusConfirmations: contract.censusConfirmations }); }
  catch (e) { return { ok: false, why: `that census cannot be committed: ${e.message}`, refused }; }
  if (!sameCC(census.root, contract.censusRoot))
    return { ok: false, why: `the census the seats handed over hashes to ${toHex(census.root).slice(0, 16)}, and this round names `
      + `${toHex(contract.censusRoot).slice(0, 16)}: an entry was left out, added or altered${refused.length ? ` (${refused.length} refused: ${refused[0].why})` : ''}`, refused };
  return { ok: true, entries: census.entries, root: census.root, refused };
}

/**
 * THE COMMITTEE, FROM THE CLIENT'S OWN CHECKS: the census above, the beacon off the same headers, and the sortition a seat
 * runs. `roles`: which committees to draw. Answers { ok, committees: { role: [pubkeys] }, beacon, census } or { ok: false, why }.
 */
export function committeeFromChain({ contract, roundId, headers, firstHeight, evidence, bond, verify, roles = ['game', 'settlement'], census: checked = null }) {
  // `census`: one this client already checked for this round's census_root (every round of a series shares it)
  const census = checked && sameCC(checked.root, contract.censusRoot) ? { ok: true, ...checked }
    : censusFromEvidence(evidence, { contract, headers, firstHeight, bond, verify });
  if (!census.ok) return census;
  const beacon = beaconFromChain(contract, { headers, firstHeight });
  if (!beacon.ok) return { ok: false, why: `no beacon: ${beacon.why}` };
  // A TABLE'S ROUNDS DRAW ON THE TABLE'S FIRST ROUND (pick (c), known-game.js tableAnchorOf), as the seats do
  const anchor = tableAnchorOf(contract);
  const seeded = committeeSeedFromBeacon(contract, { roundId: anchor ? anchor.anchorId : roundId, randomness: beacon.hash, height: beacon.height, timeMs: beacon.timeMs });
  if (!seeded.ok) return { ok: false, why: seeded.why };
  const committees = {};
  // THE DRAW (§5A.7 reserve seats): more than the seats, in score order - a seating certificate is checked
  // against it, and the committee is who that certificate seats; before one, the draw's first slots
  const drawn = {};
  for (const role of roles) {
    try { drawn[role] = drawCommittee({ entries: census.entries, contract, role, committeeSeed: seeded.seed }).map((e) => e.pubkey); }
    catch (e) { return { ok: false, why: `the ${role} committee cannot be drawn: ${e.message}` }; }
    committees[role] = drawn[role].slice(0, slotsForRole(contract, role));
  }
  // AND ITS DRAWN ATTESTORS (kanban #630): the 7 a drawn game's outcome is checked against - null where the census cannot hold the draw
  let attestors = null;
  try { attestors = drawAttestors({ entries: census.entries, contract, committeeSeed: seeded.seed }).map((e) => e.pubkey); } catch { attestors = null; }
  return { ok: true, committees, drawn, attestors, beacon: { height: beacon.height, hash: beacon.hash }, census: { root: census.root, entries: census.entries.length },
    checkedCensus: { root: census.root, entries: census.entries }, seed: seeded.seed };
}

/**
 * THE CLIENT CHECKS A 22 ROUND'S ABSENT CLAIM ITSELF (§5A.3, kanban #727, the owner 2026-10-27: "absence only with proof" - every seat AND
 * the client). `claim` is what GET /absent answers for the round's census root: { claims, certs, contracts } - each absent node with the
 * seatings that prove it, the certificates of those seatings and the contracts of their rounds (hex). `evidenceOf(ridHex)` the census
 * evidence of a named round (GET /census?round=, as for the round itself). Each named round is drawn here as committeeFromChain draws
 * the client's own round - its contract by its id, its census from evidence hashing to its root, its beacon off the same headers - and
 * every proof is checked on that draw (presence.js checkAbsenceProof): the certificate signed by that draw's seated, the node drawn
 * there or left out already, listed present by none, at 3 different seating closes in the census's 24 h. A claimed node that is in the
 * round's own census is refused too. What the client cannot see is a node a census left out that the claim does not name: that root is
 * the seats' check against their chains, as every omission always was (§5A.6).
 * AND ONLY A DUTY POSTING'S ROUND PROVES (kanban #727, duty.js dutyRoundStands): the claim hands over each named round's publication
 * with its merkle branch (`publications[ridHex]` { transaction, branch, position }) and the creator's signature (`creators[ridHex]`,
 * over the series id for a series round, the round id otherwise). The client proves the publication into its agreed headers, reads the
 * duty marker off it (the day, the item), checks the creator signed, and reads the creator's rank in that day's duty order over the
 * round's census it just checked. What it cannot see is whether an earlier posting of the same day and item exists (the first confirmed
 * one counts): that is the seats' check against their chains, as completeness is.
 * `entries`: the round's own census as this client checked it (committeeFromChain's checkedCensus.entries).
 * Answers { ok: true, absent: [node hex], stalled? } or { ok: false, why, node? }.
 */
export function absenceFromChain({ contract, claim, evidenceOf, headers, firstHeight, bond, verify, entries = null }) {
  if (!dropsAbsent(contract)) return { ok: true, absent: [] };
  if (!claim || !Array.isArray(claim.claims)) return { ok: false, why: 'no absent claim for that census root' };
  const t = medianTimePast(headers, firstHeight, Number(contract.censusHeight));
  if (t === null) return { ok: false, why: 'the agreed headers do not reach the census block\'s median time, so its 24 h cannot be read' };
  const window = presenceWindow(BigInt(t) * 1000n);
  const inRound = new Set((entries || []).map((e) => toHex(e.pubkey)));
  for (const c of claim.claims) if (inRound.has(String(c.node).toLowerCase())) return { ok: false, node: c.node, why: `the claim names ${String(c.node).slice(0, 16)} absent, and the round's own census holds it` };
  const drawn = new Map();
  const checkedCensus = new Map();
  const drawOf = (ridHex, role) => {
    if (!drawn.has(ridHex)) {
      let got = null;
      try {
        const hex = claim.contracts && claim.contracts[ridHex];
        const c = hex ? decodeRoundContract(fromHex(hex)) : null;
        if (c && toHex(roundId(c)) === ridHex) {
          const kept = checkedCensus.get(toHex(c.censusRoot)) || null;
          const r = committeeFromChain({ contract: c, roundId: fromHex(ridHex), headers, firstHeight, evidence: kept ? null : evidenceOf(ridHex), bond, verify, census: kept });
          if (r.ok) { checkedCensus.set(toHex(c.censusRoot), r.checkedCensus); got = { contract: c, drawn: r.drawn, entries: r.checkedCensus.entries, seed: r.seed }; }
        }
      } catch { got = null; }
      drawn.set(ridHex, got);
    }
    const d = drawn.get(ridHex);
    if (!d) return null;
    // A HEARTBEAT SLOT (kanban #727): its committee drawn here on the round's census and seed, the census every node of which it expects
    const j = heartbeatSlotOf(role);
    if (j !== null) {
      // a round with no heartbeat slots (below 22, a table's later round) is a wrong proof, not one to ask again
      if (!hasHeartbeats(d.contract)) return { heartbeat: null, drawn: [], census: null, closeMs: 0n };
      try {
        return { heartbeat: j, drawn: drawHeartbeat({ entries: d.entries, contract: d.contract, committeeSeed: d.seed, slot: j }).map((e) => toHex(e.pubkey)),
          census: d.entries.map((e) => toHex(e.pubkey)), closeMs: heartbeatCloseMs(d.contract, j) };
      } catch { return null; }
    }
    return { drawn: d.drawn[role].map(toHex), slots: slotsForRole(d.contract, role), closeMs: seatingCloseMs(d.contract) };
  };
  // IS THE NAMED ROUND A DUTY POSTING'S (above): its publication proven into the headers and publishing it, its creator's signature,
  // the marker's day and item, the creator's rank over the round's checked census - the tag by the contract's network's switch
  const dutyOf = (ridHex) => {
    const d = drawn.get(ridHex);
    if (!d) return null;
    const c = d.contract;
    const p = claim.publications && claim.publications[ridHex];
    if (!p || !p.transaction) return { ok: false, why: 'its publication was not handed over with the claim' };
    let tx; try { tx = parseTransaction(bytesOfCC(p.transaction)); } catch (e) { return { ok: false, why: `its publication is not a transaction: ${e.message}` }; }
    if (provenAt(headers, firstHeight, tx.txid, proofOf(p)) === null) return { ok: false, why: 'its publication is not in any block of the agreed headers' };
    const series = c.seriesId instanceof Uint8Array;
    const publishes = series ? commitmentsOf(tx).some((x) => sameCC(x, seriesPublicationPayload(c.seriesId))) : publishesRound(tx, fromHex(ridHex));
    if (!publishes) return { ok: false, why: 'the transaction handed over as its publication does not publish it' };
    const marker = dutyMarkerOf(tx);
    if (!marker || !(c.creatorPubkey instanceof Uint8Array)) return dutyRoundStands({ contract: c, marker, orderEntries: [] });   // no marker, no creator: why
    const sigHex = claim.creators && claim.creators[ridHex];
    const sig = sigHex ? bytesOfCC(sigHex) : null;
    let signed = false;
    try { signed = !!sig && sig.length === 64 && verify(sig, series ? seriesCreatorMessage(c.seriesId) : creatorMessage(fromHex(ridHex)), c.creatorPubkey) === true; } catch { signed = false; }
    if (!signed) return { ok: false, why: 'its creator\'s signature was not handed over, or is not the named creator\'s' };
    return dutyRoundStands({ contract: c, marker, orderEntries: d.entries, sw: TAG_SWITCH[networkOf(c.networkId)] || null });
  };
  const r = checkAbsenceProof(claim.claims, { window, verify, drawOf, dutyOf,
    certOf: (ridHex, role) => { const h = claim.certs && claim.certs[`${ridHex}:${role}`]; return h ? fromHex(h) : null; } });
  if (!r.ok) return { ok: false, node: r.node, why: r.notYet ? `${r.why}: its contract or census was not handed over` : r.why };
  // AND THE STALLED (§5A.3 "Stalled in its rounds", protocol 26, kanban #1052): every note, on the seating drawn here from its round's contract and census, the round a duty posting's
  // as above. A claimed node's weight is the one its seating's census gives: the client holds no census that left it out
  const stalled = Array.isArray(claim.stalled) ? claim.stalled : [];
  if (stalled.length) {
    if (!stallsOut(contract)) return { ok: false, why: 'the claim leaves out stalled nodes and that round is not under the rule' };
    for (const c of stalled) if (inRound.has(String(c.node).toLowerCase())) return { ok: false, node: c.node, why: `the claim names ${String(c.node).slice(0, 16)} stalled, and the round's own census holds it` };
    const roundOf = (ridHex) => { drawOf(ridHex, 'settlement'); const d = drawn.get(ridHex); return d ? d.contract : null; };
    const weightOf = (node) => {
      const c = stalled.find((x) => String(x.node).toLowerCase() === node);
      const d = c && c.proofs && c.proofs[0] ? drawn.get(String(c.proofs[0].seatRound).toLowerCase()) : null;
      return (d ? d.entries : []).reduce((s, e) => (toHex(e.pubkey) === node ? s + BigInt(e.bondSats || 0) : s), 0n);
    };
    const s = checkStallProof(stalled, { window: stallWindow(BigInt(t) * 1000n), verify, roundOf, drawOf, dutyOf, weightOf,
      keptWeight: entries && entries.length ? entries.reduce((n, e) => n + BigInt(e.bondSats || 0), 0n) : null,
      certOf: (ridHex, role) => { const h = claim.certs && claim.certs[`${ridHex}:${role}`]; return h ? fromHex(h) : null; } });
    if (!s.ok) return { ok: false, node: s.node, why: s.notYet ? `${s.why}: its contract or census was not handed over` : s.why };
  }
  // THE 75 % FLOOR (§5A.3, RULED 2026-11-07 kanban #1291, kanban #1325): the chain census this client can see itself is every census it
  // checked here - each named round's, against its own root in the agreed headers - and the round's own with the nodes the claim leaves
  // out added back at the weight those censuses give them. A committed census under 75 % of the largest is refused.
  if (entries && entries.length) {
    const floor = censusFloor({ entries, out: [...claim.claims, ...stalled].map((c) => String(c.node).toLowerCase()), seen: [...checkedCensus.values()].map((c) => c.entries) });
    if (!floor.ok) return { ok: false, why: floor.why };
  }
  return { ok: true, absent: claim.claims.map((c) => String(c.node).toLowerCase()), ...(stalled.length ? { stalled: stalled.map((c) => String(c.node).toLowerCase()) } : {}) };
}

const weighOf = (list) => (list || []).reduce((n, e) => n + BigInt(e.bondSats || 0), 0n);
/**
 * THE CLIENT'S CENSUS FLOOR (kanban #1291): `entries` the round's committed census as checked, `out` the node keys (hex) a claim leaves
 * out, `seen` the other censuses this client checked (entry lists). The chain census it sees: the largest of those, and the committed
 * one plus each left-out node's largest weight among them. Answers { ok, committedSats, seenSats } or { ok: false, why, ... }.
 */
export function censusFloor({ entries, out = [], seen = [] }) {
  const committed = weighOf(entries);
  let back = 0n;
  for (const node of new Set(out)) {
    let w = 0n;
    for (const list of seen) { const v = (list || []).reduce((n, e) => (toHex(e.pubkey) === node ? n + BigInt(e.bondSats || 0) : n), 0n); if (v > w) w = v; }
    back += w;
  }
  let seenSats = committed + back;
  for (const list of seen) { const v = weighOf(list); if (v > seenSats) seenSats = v; }
  if (committed * 10000n < seenSats * CLIENT_CENSUS_FLOOR_BPS) {
    return { ok: false, committedSats: committed, seenSats, why: `that round's census weighs ${committed} bonded sats, under ${Number(CLIENT_CENSUS_FLOOR_BPS) / 100} % of the ${seenSats} this client sees on the chain itself (§5A.3)` };
  }
  return { ok: true, committedSats: committed, seenSats };
}
