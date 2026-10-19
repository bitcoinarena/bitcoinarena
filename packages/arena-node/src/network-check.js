// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK STORE'S CHECKS, IN THE PAGE AND ON THE SEAT ALIKE (2026-10-10: "Everything with loading
// plugins must happen in the browser including updating games and networks like an AppStore"; letter 2026-10-10: a seat's
// network settings are its federation invite, the donation sets in force, its series and the chain it reads - each offered
// and updated from the owner page, signed by whoever has authority over it). Isomorphic, as plugin-check.js is: the owner
// page bundles it and shows its report before Install; the seat runs the same checks again and its own trial (server.js)
// before anything is kept or held. WHO HAS AUTHORITY OVER EACH OF THE FOUR:
//   - the chain:          the network's genesis - its network id commits to the chain it names (genesis.js), and the
//                         chain must be the one this seat reads;
//   - the donation sets:  the network's donation authority, Ed25519, and a rotation of it only by the recovery key
//                         (authority.js, §27A.4) - each set signed by the authority in force at its valid_from;
//   - the series:         the protocol's own rules for a series (series.js): on this network, on the genesis grid with its
//                         lead, naming the donation set in force at its census height, of a game this seat hosts;
//   - the federation invite: the federation the series name - the invite must read and name that federation id. Its
//                         guardians' bonds are counted per round at the door, from the census (§23.6, guardiansBonded).
// The manifest names each of them by id; its hash is the package's id. A package carrying anything its manifest does not
// name, or naming anything it does not carry, is refused.
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodeDonationSetBody, encodeDonationSetBody, donationSetBodyId, decodeAuthorityRotation, encodeAuthorityRotation,
  authorityRotationId, authorityAt, donationSetSignedBy, rotationSignedBy, donationSetInForce } from '../../arena-protocol/src/authority.js';
import { donationSetId, donationSetStands } from '../../arena-protocol/src/donation.js';
import { donationKeysForNetworkId } from '../../arena-protocol/src/donation-keys.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { decodeRoundContract, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { seriesId, seriesLeadIsValid } from '../../arena-protocol/src/series.js';
import { readInvite } from './invite.js';

export const NETWORK_FORMAT = 'arena-network/v1';
const utf8 = (s) => new TextEncoder().encode(s);

/** The package's id: sha-256 over its manifest's fields in a fixed order. */
export const networkPackageId = (m) => toHex(sha256(utf8(JSON.stringify(['arena/network-package/v1', m.chain, m.networkId, m.federationId,
  [...(m.donationSets || [])], [...(m.rotations || [])], [...(m.series || [])]]))));

/** A series template as a package carries it: the contract without its series fields, and its count, cut and period. */
const templateOf = (s) => {
  const t = decodeRoundContract(fromHex(String(s.template)));
  if (s.count !== undefined && s.count !== null) t.seriesCount = Number(s.count);
  if (s.cut !== undefined && s.cut !== null) t.seriesCutFrom = Number(s.cut);
  if (s.period !== undefined && s.period !== null) t.seriesPeriodMs = BigInt(s.period);
  return t;
};
export const seriesEntryOf = (t) => {
  const { seriesId: _s, roundIndex: _i, seriesCount, seriesCutFrom, seriesPeriodMs, ...rest } = t; void _s; void _i;
  return { template: toHex(encodeRoundContract(rest)), ...(Number.isInteger(seriesCount) ? { count: seriesCount } : {}),
    ...(Number.isInteger(seriesCutFrom) ? { cut: seriesCutFrom } : {}), ...(seriesPeriodMs !== undefined && seriesPeriodMs !== null ? { period: String(seriesPeriodMs) } : {}) };
};

/**
 * A SEAT'S NETWORK AS A PACKAGE (JSON-able): its chain, network id, federation invite, the signed donation sets and rotations
 * it holds for that network, and the series it holds on it. Answers the package with its manifest and id.
 */
export function networkPackageOf({ chain, networkId, invite, sets = [], rotations = [], series = [], title = '' }) {
  const nid = networkId instanceof Uint8Array ? networkId : fromHex(String(networkId));
  const mine = (x) => x.networkId instanceof Uint8Array && toHex(x.networkId) === toHex(nid);
  const donationSets = sets.filter(mine).map((s) => ({ body: toHex(encodeDonationSetBody(s)), signature: toHex(s.signature) }));
  const rots = rotations.filter(mine).map((r) => ({ body: toHex(encodeAuthorityRotation(r)), signature: toHex(r.signature) }));
  const ser = series.filter(mine).map(seriesEntryOf);
  const fed = invite ? readInvite(invite).federationId : null;
  const manifest = { chain, networkId: toHex(nid), federationId: fed,
    donationSets: sets.filter(mine).map((s) => toHex(donationSetBodyId(s))),
    rotations: rotations.filter(mine).map((r) => toHex(authorityRotationId(r))),
    series: series.filter(mine).map((t) => toHex(seriesId(t))) };
  return { format: NETWORK_FORMAT, title: title || chain, id: networkPackageId(manifest), manifest, invite: invite || '', donationSets, rotations: rots, series: ser };
}

/**
 * THE REPORT ON A NETWORK PACKAGE: `verify(sig, msg, key)` is Ed25519 (the donation authority's curve, ruled 2026-09-13);
 * `seatChain` is the chain the installing seat reads ('bitcoin-testnet4'); `hostsGame(gameIdHex)` whether that seat hosts a
 * game. Answers { ok, why, id, chain, networkId, federationId, checks: [{ check, ok, detail }], sets, rotations, series }
 * with every check listed, passed or not - the page shows the whole report, and the first failing line is the `why`.
 */
export function checkNetworkPackage(pkg, { verify, seatChain, hostsGame = () => true } = {}) {
  const checks = [];
  const add = (check, ok, detail = '') => { checks.push({ check, ok: !!ok, detail }); return !!ok; };
  const out = (extra = {}) => { const bad = checks.find((c) => !c.ok); return { ok: !bad, why: bad ? `${bad.check}: ${bad.detail || 'no'}` : null, checks, ...extra }; };
  if (!add('a network package of this store', !!pkg && pkg.format === NETWORK_FORMAT && pkg.manifest && typeof pkg.manifest === 'object', pkg && pkg.format !== NETWORK_FORMAT ? `not ${NETWORK_FORMAT}` : ''))
    return out();
  const m = pkg.manifest;
  const id = networkPackageId(m);
  const who = { id, chain: m.chain, networkId: m.networkId, federationId: m.federationId };
  add('its id is its manifest\'s', !pkg.id || pkg.id === id, id.slice(0, 16));
  // THE CHAIN: the network id is a genesis this build knows, the chain it names is that genesis's, and it is this seat's
  let nid = null, net = null;
  try { nid = fromHex(String(m.networkId)); net = nid.length === 32 ? networkOf(nid) : null; } catch { net = null; }
  let genesisChain = null;
  try { genesisChain = net ? genesisFor(net).chain : null; } catch { genesisChain = null; }
  add('its network id is a genesis this build knows', !!genesisChain, genesisChain ? `${net} · ${String(m.networkId).slice(0, 16)}…` : `${String(m.networkId).slice(0, 16)}… names no known genesis`);
  add('its chain is the one its network\'s genesis names', !!genesisChain && m.chain === genesisChain, genesisChain ? `${m.chain}${m.chain === genesisChain ? '' : `, and the genesis names ${genesisChain}`}` : '');
  add('its chain is this seat\'s chain', !!seatChain && m.chain === seatChain, seatChain ? (m.chain === seatChain ? m.chain : `${m.chain}, and this seat reads ${seatChain}`) : 'this seat names no chain');
  // THE FEDERATION INVITE: it reads (bech32m checksum), names its guardians, and its federation is the manifest's
  let inv = null;
  try { inv = readInvite(pkg.invite); } catch (e) { inv = { why: e.message }; }
  add('its federation invite reads', !!(inv && inv.federationId), inv && inv.federationId ? `${inv.guardians.length} guardian(s)` : (inv && inv.why) || 'no invite');
  add('the invite\'s federation is the one its manifest names', !!(inv && inv.federationId) && inv.federationId === m.federationId,
    inv && inv.federationId ? `${inv.federationId.slice(0, 16)}…${inv.federationId === m.federationId ? '' : `, and the manifest names ${String(m.federationId).slice(0, 16)}…`}` : '');
  const keys = nid && nid.length === 32 ? donationKeysForNetworkId(nid) : null;
  add('its network has a donation authority this build knows', !!keys, keys ? `${toHex(keys.authority).slice(0, 16)}…` : '');
  // ROTATIONS, by the recovery key only
  const rotations = [];
  const namedRot = new Set(m.rotations || []);
  for (const [i, r] of (pkg.rotations || []).entries()) {
    let rot; try { rot = { ...decodeAuthorityRotation(fromHex(String(r.body))), signature: fromHex(String(r.signature)) }; } catch (e) { add(`rotation ${i} reads`, false, e.message); continue; }
    const rid = toHex(authorityRotationId(rot));
    add(`rotation serial ${rot.serial} is the one its manifest names`, namedRot.has(rid), rid.slice(0, 16));
    const s = keys ? rotationSignedBy(rot, { recovery: keys.recovery, verify }) : { ok: false, why: 'no recovery key' };
    add(`rotation serial ${rot.serial} is signed by the network's recovery key`, s.ok, s.why);
    rotations.push(rot);
  }
  // THE DONATION SETS: each the manifest's, each standing, each signed by the authority in force at its valid_from
  const sets = [];
  const namedSets = new Set(m.donationSets || []);
  for (const [i, d] of (pkg.donationSets || []).entries()) {
    let set; try { set = { ...decodeDonationSetBody(fromHex(String(d.body))), signature: fromHex(String(d.signature)) }; } catch (e) { add(`donation set ${i} reads`, false, e.message); continue; }
    const bid = toHex(donationSetBodyId(set));
    add(`donation set serial ${set.serial} is the one its manifest names`, namedSets.has(bid), bid.slice(0, 16) + '…');
    add(`donation set serial ${set.serial} is for this network`, nid && toHex(set.networkId) === toHex(nid));
    const st = donationSetStands(set.recipients);
    add(`donation set serial ${set.serial} stands`, st.ok, st.ok ? `${set.recipients.length} recipient(s)` : st.why);
    let signed = { ok: false, why: 'no donation authority' };
    if (keys) {
      try {
        const at = authorityAt({ networkId: nid, authority: keys.authority, recovery: keys.recovery, rotations, height: set.validFrom, verify });
        signed = donationSetSignedBy(set, { authority: at.authority, verify });
      } catch (e) { signed = { ok: false, why: e.message }; }
    }
    add(`donation set serial ${set.serial} is signed by the network's donation authority`, signed.ok, signed.why);
    sets.push(set);
  }
  // THE SERIES: the manifest's, on this network and federation, naming the set in force at its census height, on the
  // genesis grid with its lead, of a game this seat hosts
  const series = [];
  const namedSeries = new Set(m.series || []);
  for (const [i, s] of (pkg.series || []).entries()) {
    let t; try { t = templateOf(s); } catch (e) { add(`series ${i} reads`, false, e.message); continue; }
    const sid = toHex(seriesId(t)), tag = sid.slice(0, 12) + '…';
    add(`series ${tag} is the one its manifest names`, namedSeries.has(sid));
    add(`series ${tag} is on this network`, nid && toHex(t.networkId) === toHex(nid));
    add(`series ${tag} uses the invite's federation`, toHex(t.federationId) === m.federationId, toHex(t.federationId).slice(0, 16) + '…');
    const want = toHex(t.donationSetId);
    const carried = sets.find((x) => { try { return toHex(donationSetId(x.recipients)) === want; } catch { return false; } });
    let inForce = null;
    if (keys && sets.length) {
      try { inForce = donationSetInForce({ networkId: nid, authority: keys.authority, recovery: keys.recovery, sets, rotations, height: t.censusHeight, verify }); } catch { inForce = null; }
    }
    const forcedId = inForce && inForce.ok ? toHex(donationSetId(inForce.recipients)) : null;
    add(`series ${tag} names a donation set this package carries, the one in force at its census height`, !!carried && forcedId === want,
      !carried ? `it names ${want.slice(0, 16)}…, which this package does not carry` : forcedId === want ? `serial ${inForce.serial}` : `serial ${inForce && inForce.serial} is in force at ${t.censusHeight}`);
    const lead = seriesLeadIsValid(t);
    add(`series ${tag} starts on the genesis grid with its lead`, lead.ok, lead.ok ? `starts ${new Date(Number(t.startTimeMs)).toISOString().slice(0, 16)}Z` : lead.why);
    const game = t.gameId instanceof Uint8Array ? toHex(t.gameId) : '';
    add(`series ${tag} is of a game this seat hosts`, !!game && hostsGame(game), game.slice(0, 16) + '…');
    series.push(t);
  }
  add('it carries what its manifest names, and nothing else',
    (m.donationSets || []).length === sets.length && (m.rotations || []).length === rotations.length && (m.series || []).length === series.length,
    `${sets.length} set(s), ${rotations.length} rotation(s), ${series.length} series`);
  return out({ ...who, sets, rotations, series, invite: pkg.invite });
}

/**
 * AN UPDATE IS THE SAME NETWORK, NOT ROLLED BACK: the installed package's chain and network id, and no donation set serial
 * lower than the highest one installed (the highest validly signed serial wins, §27A.4 - an older one changes nothing).
 */
export function checkNetworkUpdate(installed, next) {
  if (!installed || !next) return { ok: false, why: 'an update names the network it replaces' };
  if (installed.networkId !== next.networkId || installed.chain !== next.chain) return { ok: false, why: `that package is network ${String(next.networkId).slice(0, 16)} on ${next.chain}, not the installed ${String(installed.networkId).slice(0, 16)} on ${installed.chain}` };
  const top = (xs) => xs.reduce((a, s) => (s.serial > a ? s.serial : a), -1n);
  const was = BigInt(installed.topSerial ?? -1), now = top(next.sets || []);
  if (now < was) return { ok: false, why: `its newest donation set is serial ${now}, older than the installed serial ${was}: a set is never rolled back` };
  return { ok: true };
}
