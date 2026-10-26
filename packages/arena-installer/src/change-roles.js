// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN INSTALLED NODE CHANGES ITS ROLES FROM ITS OWNER PAGE (kanban #563, 2026-10-21: "configure every role and service one by one
// ... on installed nodes too"): an advertisement update of its bond paid from the node's own wallet - the one the wizard funded - the
// advertisement rebuilt from the node's state as the bond and the custody agent build it (its endpoint, payout key, guardian endpoint,
// guardian seats and emergency key kept), with the roles asked and a new timestamp. Before this, POST /owner/roles answered 501 on every
// installed node ("changes its roles with the installer ... until its wallet is wired here").
//
// The advertisement's roles are game, verify, settlement and relay; the installer's state names game / verify as one role ('verify').
// Custody is not switched here: it needs Lightning, a gateway and a guardian set up (or handed over), not an advertisement alone - the
// installer's custody step adds it, and a guardian leaves with LEAVE. Answers { ok, plan } / { ok, plan, update } or { ok: false, why }.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { walletOf, payoutKeyOf, coinsOf, broadcast } from './wallet.js';
import { advertFor, advertRoles, buildAdvertUpdate, EMERGENCY_IN_ADVERT, NEXTBLOCK_GAME_ID } from './bond.js';
import { emergencyOf } from './seed.js';
import { nodeState, guardianSetupOf } from './state.js';
import { fromHex, toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';

export const ADVERT_ROLES = Object.freeze(['game', 'verify', 'settlement', 'relay']);

/** The installer's roles for the advertisement roles asked: game or verify is its one 'verify'; custody and liquidity as they were. */
export function stateRolesFor(asked, had) {
  const want = new Set(asked);
  const out = [];
  if (want.has('game') || want.has('verify')) out.push('verify');
  if (want.has('settlement')) out.push('settlement');
  if (want.has('relay')) out.push('relay');
  for (const keep of ['custody', 'liquidity']) if ((had || []).includes(keep)) out.push(keep);
  return out;
}

export async function changeRolesOnNode({ home, release, roles, custody, post = false, chainKit = { coinsOf, broadcast }, state = null, guardianOf = null, nowMs = Date.now() }) {
  const st = state || nodeState(home);
  const s = st.read();
  const asked = [...new Set((roles || []).map(String))];
  const bad = asked.filter((r) => !ADVERT_ROLES.includes(r));
  if (bad.length) return { ok: false, why: `${bad.join(', ')}: not a role an advertisement names (${ADVERT_ROLES.join(', ')})` };
  const had = s.roles || [];
  const custodyNow = had.includes('custody');
  if (custody !== undefined && !!custody !== custodyNow) {
    return { ok: false, why: custodyNow ? 'custody is left with LEAVE on this page: the guardian hands its seat over first' : 'custody needs Lightning, a gateway and a guardian: add it with the installer\'s custody step' };
  }
  if (!s.bond || !s.bond.txid) return { ok: false, why: 'this node has no bond whose advertisement could be updated: post its bond first' };
  const next = stateRolesFor(asked, had);
  const before = { roles: advertRoles(had).sort(), custody: custodyNow };
  const after = { roles: advertRoles(next).sort(), custody: custodyNow };
  // relay alone (always named, 2026-10-26) serves no round: a node needs another role or custody
  if (!after.roles.filter((r) => r !== 'relay').length && !custodyNow) return { ok: false, why: 'a node with no role at all serves nothing: keep at least one' };
  if (JSON.stringify(before) === JSON.stringify(after)) return { ok: false, why: 'those are the roles this node already advertises' };
  const built = await advertUpdateOf({ st, s, release, roles: next, guardianOf, nowMs, chainKit });
  if (!built.ok) return built;
  const u = built.update;
  const plan = { before, after, bond: `${s.bond.txid}:${s.bond.vout || 0}`, feeSats: String(u.fees.funding + u.fees.update), countsAfter: 6 };
  if (!post) return { ok: true, plan };
  await chainKit.broadcast(s.chain, u.funding.hex);
  const txid = await chainKit.broadcast(s.chain, u.update.hex);
  st.save({ roles: next, rolesUpdate: { txid, advertId: u.advertId, before, after, atMs: nowMs } });
  return { ok: true, plan, update: { txid } };
}

/**
 * THE NODE'S ADVERTISEMENT, REBUILT AND PUT IN AN UPDATE OF ITS BOND (shared by the roles change and the hosted games' refresh): its
 * endpoint, payout key, guardian endpoint and seats, emergency key and hosted games as the state says, `roles` and `hostedGames` as
 * asked, a new timestamp; paid from the node's own wallet. Answers { ok, update } (buildAdvertUpdate's) or { ok: false, why }.
 */
async function advertUpdateOf({ st, s, release, roles, hostedGames = s.hostedGames, guardianOf = null, nowMs = Date.now(), chainKit }) {
  const seedHex = st.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const seed = fromHex(seedHex);
  const db = new DatabaseSync(st.path('node.db'), { readOnly: true });
  let nodeSecret;
  try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
  let softwareHash; try { softwareHash = sha256(readFileSync(join(release, 'COMMIT'))); } catch { softwareHash = new Uint8Array(32); }
  // the guardian seats it names now: the custody agent's published one (its guardian's directory), else none
  let seats = guardianOf;
  if (!seats) {
    seats = [];
    if ((s.custody || {}).guardianOf) {
      try { const { guardianOfEntry } = await import('./custody-agent.js'); const g = guardianOfEntry(st.path('node.db.guardian'));
        if (g) seats = [{ federationId: fromHex(g.federationId), guardianKey: fromHex(g.guardianKey) }]; } catch { /* none to repeat */ }
    }
  }
  const advert = advertFor({ hostedGames, nodeKey: schnorr.getPublicKey(nodeSecret), operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles, endpoint: s.reach.url,
    payoutPubkey: payoutKeyOf(seed), maturity: s.bond.maturity, softwareHash, guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null, nowMs,
    emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null, guardianOf: seats });
  const w = walletOf(seed);
  const { coins } = await chainKit.coinsOf(s.chain, w.spk);
  let u;
  try { u = buildAdvertUpdate({ wallet: w, nodeSecret, coins, bond: { txid: s.bond.txid, vout: s.bond.vout || 0 }, advert }); }
  catch (e) { return { ok: false, why: e.message }; }
  return { ok: true, update: u };
}

/**
 * THE NEWEST GAMES AND PROTOCOLS IN THE ADVERTISEMENT (2026-10-25: "Make sure the installer and the nodes use the newest versions of games and
 * protocols"): an update can bring app versions the node's advertisement does not name yet, and the census draws a node only for the
 * games it names. The node's chosen apps in `release` (apps.js hostedGameIdsOf), against what it advertises (state hostedGames, else
 * Next Block's first version, as every installer node named before): the same - nothing to do; else an advertisement update naming
 * them, from the node's wallet. Answers { ok, unchanged } / { ok, plan } / { ok, plan, update } or { ok: false, why }.
 */
export async function refreshHostedGames({ home, release, post = false, chainKit = { coinsOf, broadcast }, state = null, nowMs = Date.now() }) {
  const st = state || nodeState(home);
  const s = st.read();
  if (!s.bond || !s.bond.txid) return { ok: false, why: 'no bond yet: its advertisement will name the games when it is posted' };
  const { appsIn, chosenApps, hostedGameIdsOf } = await import('./apps.js');
  const apps = appsIn(release);
  const now = await hostedGameIdsOf(release, chosenApps(s, apps), apps);
  if (!now.length) return { ok: false, why: 'this release hosts no game of the node\'s apps' };
  const had = [...new Set(s.hostedGames && s.hostedGames.length ? s.hostedGames : [toHex(NEXTBLOCK_GAME_ID)])].sort();
  // AND THE NEWEST PROTOCOLS: an advertisement declares the protocol versions its release spoke when it was posted (state advertProtocols;
  // unknown for a node bonded before it was kept); a release that speaks more is declared with the same update
  const protocols = [...SUPPORTED_PROTOCOL_VERSIONS];
  const protocolsHad = Array.isArray(s.advertProtocols) ? s.advertProtocols : null;
  const sameProtocols = !!protocolsHad && JSON.stringify(protocolsHad) === JSON.stringify(protocols);
  if (JSON.stringify(had) === JSON.stringify(now) && sameProtocols) return { ok: true, unchanged: true };
  const built = await advertUpdateOf({ st, s, release, roles: s.roles || [], hostedGames: now, nowMs, chainKit });
  if (!built.ok) return built;
  const u = built.update;
  const plan = { before: had.length, after: now.length, added: now.filter((g) => !had.includes(g)).length, protocols: Math.max(...protocols), protocolsBefore: protocolsHad ? Math.max(...protocolsHad) : null,
    feeSats: String(u.fees.funding + u.fees.update), countsAfter: 6 };
  if (!post) return { ok: true, plan };
  await chainKit.broadcast(s.chain, u.funding.hex);
  const txid = await chainKit.broadcast(s.chain, u.update.hex);
  st.save({ hostedGames: now, advertProtocols: protocols, gamesUpdate: { txid, advertId: u.advertId, before: had.length, after: now.length, protocols: Math.max(...protocols), atMs: nowMs } });
  return { ok: true, plan, update: { txid } };
}
