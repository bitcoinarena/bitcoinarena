// THE CLIENT BUILDS THE COMMITTEE ITSELF (kanban #296, spec 5A.6: "a client MUST NOT take a census, a committee or an
// endpoint on the word of any API"). Until this the page asked every node GET /committee and took the set when they
// agreed - so a set of colluding seats could name any committee and be dealt a player's stake.
//
// Here the client derives it from what it checks itself:
//   HEADERS   the chain it agreed from independent providers (directory.js agreedChain), from a compiled-in anchor;
//   CENSUS    every entry of the round's census as EVIDENCE a seat hands over (GET /census): its bond transaction proven
//             into one of those headers, the advertisement it commits to, the output rebuilt as the bond from the
//             network's arbitration set and a curve, its maturity (#295), its floor - and, for a carried bond, its
//             re-affirmation and update, proved and signed by the bond's key. The verified set must hash to the round's
//             own census_root (censusRootOf, the seat's own function): an entry left out, added or altered is another
//             root, and the round is refused. Spentness at census_height is in that root.
//   BEACON    the first block whose median time is past committee_time, deep enough - off the same headers
//             (beaconFromChain), its hash the randomness (committeeSeedFromBeacon);
//   SORTITION selectCommittee over the verified entries, the function a seat's Roster.committeeFor runs.
// This package carries no curve and no signature scheme: `bond` brings the curve operations, `verify` BIP-340.
import { parseTransaction, commitmentsOf, witnessRunsOf } from './tx.js';
import { splitSignedAdvert, decodeAdvert, advertId } from './advert.js';
import { provesTransaction, recognizeBond, merkleRootFromProof } from './chain.js';
import { decodeAncestorAdvert } from './ancestor.js';
import { acceptAncestorEndpoint } from './ancestor-endpoint.js';
import { readAdvertUpdate } from './advert-update.js';
import { maturityStands } from './bond-script.js';
import { censusRootOf } from './census.js';
import { beaconFromChain, committeeSeedFromBeacon } from './beacon.js';
import { selectCommittee } from './sortition.js';
import { networkOf } from './constants.js';
import { toHex, fromHex } from './hash.js';

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
 * `item` is { transaction, branch, position, update?, reaffirm? } (hex or bytes), each proved into `headers`.
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
  // RESOLVE's filters, on the body the bond committed to
  if (bondSats < contract.bondMinSats) return { ok: false, why: `that bond is ${bondSats} where this round's floor is ${contract.bondMinSats}` };
  if (!(advert.roles || []).length) return { ok: false, why: 'that advertisement declares no role' };
  if (!(advert.protocolVersions || []).includes(contract.protocolVersion)) return { ok: false, why: 'that advertisement does not speak this round\'s version' };
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
    if (!sameCC(read.bondTxid, tx.txid) || read.bondVout !== vout) return { ok: false, why: 'its update names another bond' };
    if (!sameCC(read.nodePubkey, entry.pubkey) || !sig(read.signature, read.advertId, entry.pubkey)) return { ok: false, why: 'its update is not signed by the bond\'s key' };
    const roles = read.advert.roles || [];
    if (!roles.length || !(read.advert.protocolVersions || []).includes(contract.protocolVersion))
      return { ok: false, why: 'its newest update declares no role or not this round\'s version' };
    entry = { ...entry, advert: read.advert, advertId: read.advertId, roles, hostedGames: read.advert.hostedGames };
  }
  return { ok: true, entry };
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
  const seeded = committeeSeedFromBeacon(contract, { roundId, randomness: beacon.hash, height: beacon.height, timeMs: beacon.timeMs });
  if (!seeded.ok) return { ok: false, why: seeded.why };
  const committees = {};
  for (const role of roles) {
    try { committees[role] = selectCommittee({ entries: census.entries, contract, role, committeeSeed: seeded.seed }).map((e) => e.pubkey); }
    catch (e) { return { ok: false, why: `the ${role} committee cannot be drawn: ${e.message}` }; }
  }
  return { ok: true, committees, beacon: { height: beacon.height, hash: beacon.hash }, census: { root: census.root, entries: census.entries.length },
    checkedCensus: { root: census.root, entries: census.entries } };
}
