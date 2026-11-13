// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THIS CLIENT BELIEVES ABOUT A FEDERATION (spec §23A.4): its guardians' newest signed record, read from
// the round's nodes (GET /federations) and checked against the census this client checked itself (committee.js) -
// at least the threshold of the federation's bonded guardians, the invite naming that federation. Nothing else: "a client
// trusts nothing about a federation that has no record it can verify".
//   OPEN      everything as before
//   DRAINING  no deposit into it (said by name); everything else runs, withdrawals included
//   CRITICAL  Withdraw and Move only
//   HALTED    everything frozen, said so
//   CLOSED    its successor holds everything
//   unverified  no record that stands: shown, and nothing about it is taken on trust
import { majorityThenGrace, COMPARE_GRACE_MS } from './committee.js';
import { verifyFederationRecord, newestRecord, loadReserveOf, splitSignedRecord, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { MAINNET_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { readInvite } from '../../arena-node/src/invite.js';
import { readWithOneRetry } from './reread.js';
import { noteRecordInvite } from './guardian-invites.js';

// HEX BY TABLE (kanban #1391, profiled on stage UI 603: the regex-and-map decode of each seat's signed records took 1.1 s of every minute of an RPS page):
// the same bytes for hex; a character that is not hex reads as 0, as parseInt's NaN did
const HEX_VALUE = (() => { const t = new Int8Array(128).fill(-1); for (let i = 0; i < 10; i++) t[48 + i] = i; for (let i = 0; i < 6; i++) { t[97 + i] = 10 + i; t[65 + i] = 10 + i; } return t; })();
const hexToBytes = (h) => {
  const s = String(h), out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) { const a = HEX_VALUE[s.charCodeAt(2 * i)], b = HEX_VALUE[s.charCodeAt(2 * i + 1)]; out[i] = a >= 0 && b >= 0 ? (a << 4) | b : a >= 0 ? a : 0; }
  return out;
};
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const inviteFederationId = (invite) => { const f = readInvite(invite).federationId; return f ? hexToBytes(f) : null; };

/** What a page may do with a federation in each status. */
export const FEDERATION_ALLOWS = Object.freeze({
  OPEN: { deposit: true, join: true, withdraw: true, move: true },
  DRAINING: { deposit: false, join: true, withdraw: true, move: true },
  CRITICAL: { deposit: false, join: false, withdraw: true, move: true },
  HALTED: { deposit: false, join: false, withdraw: false, move: false },
  CLOSED: { deposit: false, join: false, withdraw: true, move: true },
  unverified: { deposit: true, join: true, withdraw: true, move: true },
});

/**
 * NO RECORD STANDS, AND ONE REFUSED SAYS THE FEDERATION IS IN TROUBLE (kanban #2603, feedback #037): a genuine HALTED record refused here
 * (four bonded strangers naming the federation in their adverts lifted its threshold past its seven signers) made the federation
 * 'unverified', which allowed everything - deposits and joins into a halted federation. When every record of a federation was refused
 * and one of them names DRAINING, CRITICAL, HALTED or CLOSED, it stays 'unverified' (nothing taken on trust), with no deposit and no
 * join; withdraw and move stay open, so a player is never held in a federation on an unverified word.
 */
export const UNVERIFIED_RESTRICTED = Object.freeze({ deposit: false, join: false, withdraw: true, move: true });
const RESTRICTIVE = new Set([FEDERATION_STATUS.DRAINING, FEDERATION_STATUS.CRITICAL, FEDERATION_STATUS.HALTED, FEDERATION_STATUS.CLOSED]);
const statusName = (v) => Object.keys(FEDERATION_STATUS).find((k) => FEDERATION_STATUS[k] === v) || null;
/** The restrictive status a refused record of `fid` names, or null (it does not decode, names another federation, or says OPEN). */
function refusedRestrictive(bytes, fid) {
  try {
    const r = splitSignedRecord(bytes).record;
    return bytesToHex(r.federationId) === fid && RESTRICTIVE.has(r.status) ? statusName(r.status) : null;
  } catch { return null; }
}

/**
 * THE FEDERATION'S STATUS AS THIS CLIENT CAN STAND BEHIND IT. `census` is the entries of a census this client checked
 * (with their advertisements); `verify` BIP-340. Answers { status, allows, signers, height, from, why }.
 */
export async function federationStatus({ federationIdHex, nodes, census, verify, fetcher = fetch, keptMs = 0, guardianKeysOf = null }) {
  const fid = String(federationIdHex).toLowerCase();
  // KEPT A WHILE WHEN ASKED (kanban #625, the owner's log 2026-10-24 20:30Z: each order read the status of every other federation the
  // browser holds notes in, 52-126 s while seats restarted): a status that stood is reused for `keptMs`
  const had = keptMs > 0 ? STATUS_KEPT.get(fid) : null;
  if (had && Date.now() - had.at < keptMs) return had.status;
  const all = await federationStatuses({ nodes, census, verify, fetcher, only: fid, guardianKeysOf });
  const st = all.get(fid) || { status: 'unverified', allows: FEDERATION_ALLOWS.unverified, why: all.why || 'no node holds a record of this federation' };
  if (st.status !== 'unverified') STATUS_KEPT.set(fid, { status: st, at: Date.now() });
  return st;
}
const STATUS_KEPT = new Map();
const STATUS_ASK_MS = 6000;
const FEDERATION_ROWS_PER_SEAT = 2, FEDERATIONS_PER_SEAT = 16;   // kanban #1684: what one seat's GET /federations may cost

/**
 * EVERY FEDERATION THE SEATS LIST, EACH AS federationStatus ANSWERS IT (§23A.3,: Move is offered against the
 * others' loads): one read of each seat's /federations, every record checked against the same census. A Map, federation
 * id hex -> status with `federation`; `only` keeps one. `.why` says why none stood when the map is empty.
 */
// `guardianKeysOf(fidHex)` (optional): the federation config's guardian keys when the page holds that config (its lock client's
// guardians().keys) - every record of that federation is then held to them (verifyFederationRecord guardianKeys, kanban #2603)
export async function federationStatuses({ nodes, census, verify, fetcher = fetch, only = null, guardianKeysOf = null }) {
  const verified = new Map(), refused = new Map(), failed = [], alarms = new Map(), firsts = new Map(), checked = new Map(), restrictive = new Map();
  const keysOf = (fid) => { if (typeof guardianKeysOf !== 'function') return null; try { const k = guardianKeysOf(fid); return Array.isArray(k) && k.length ? k : null; } catch { return null; } };
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  // NOT HELD FOR THE SLOWEST SEAT, NOR FOR A HUNG ONE (kanban #625: asked with no limit, a restarting seat held an order 26 s a read): each
  // seat within STATUS_ASK_MS, and once more than half answered the rest get COMPARE_GRACE_MS - the records are signed, the newest that stands is taken
  let closed = false;
  await majorityThenGrace((nodes || []).map(async (u) => {
    try {
      const r = await readWithOneRetry(fetcher, `${String(u).replace(/\/+$/, '')}/federations`, { signal: AbortSignal.timeout(STATUS_ASK_MS) });
      if (closed) return;
      if (!r.ok) { failed.push(`${u}: ${r.status}`); return; }
      const j = await r.json();
      // ONE SEAT'S ANSWER IS BOUNDED (kanban #1684): a seat that listed one federation's record thousands of times, each copy with 32
      // made-up signatures under the bonded guardians' public keys, cost the page 64,000 schnorr verifies a read on its main thread (minutes
      // frozen, every order with it). From each seat at most FEDERATION_ROWS_PER_SEAT rows of one federation and FEDERATIONS_PER_SEAT
      // federations are checked, and a record (its exact bytes) already checked in this read is not checked again
      const rows = new Map();
      for (const f of Array.isArray(j.federations) ? j.federations : []) {
        const fid = String(f && f.federation).toLowerCase();
        if (only && fid !== only) continue;
        // A RESERVE ALARM (kanban #1093 part 5): a seat that saw a mark of theft in the federation's signed history names it; one seat is
        // enough to stop deposits - stopping is the safe side, and the mark carries its own proof for anyone who acts on it
        if (!f) continue;
        if (f.alarm && typeof f.alarm === 'object' && !alarms.has(fid)) alarms.set(fid, { ...f.alarm, from: u });
        const n = rows.get(fid) || 0;
        if (n >= FEDERATION_ROWS_PER_SEAT || (!n && rows.size >= FEDERATIONS_PER_SEAT)) continue;
        rows.set(fid, n + 1);
        if (Number.isInteger(f.firstHeight)) add(firsts, fid, f.firstHeight);
        const hex = String(f.record);
        let v = checked.get(hex);
        if (!v) { v = verifyFederationRecord(hexToBytes(hex), { census, verify, inviteFederationId, guardianKeys: keysOf(fid) }); checked.set(hex, v); }
        // ITS GUARDIANS, for a join one guardian cannot serve (guardian-invites.js) - ONLY ONCE THE RECORD VERIFIES (kanban #1556: one seat
        // answering first with an unsigned record naming the player's federation took every peer slot, so the join fallback named only its hosts)
        if (v.ok) { noteRecordInvite(f.record); add(verified, fid, { ...v, from: u }); }
        else {
          add(refused, fid, `${u}: ${v.why}`);
          const says = restrictive.has(fid) ? null : refusedRestrictive(hexToBytes(hex), fid);
          if (says) restrictive.set(fid, says);
        }
      }
    } catch (e) { if (!closed) failed.push(`${u}: ${e.message}`); }
  }), COMPARE_GRACE_MS);
  closed = true;
  const out = new Map();
  for (const fid of new Set([...verified.keys(), ...refused.keys()])) {
    const best = newestRecord(verified.get(fid) || []);
    const why = (refused.get(fid) || failed)[0];
    const says = best ? null : restrictive.get(fid) || null;
    const st = best ? { ...statusOfRecord(best), federation: fid }
      : { status: 'unverified', allows: says ? UNVERIFIED_RESTRICTED : FEDERATION_ALLOWS.unverified, federation: fid,
        ...(says ? { refusedSays: says } : {}),
        why: `${why ? `no record stands: ${why}` : 'no node holds a record of this federation'}${says ? ` - a refused record says ${says}, so no deposit or join` : ''}` };
    // ITS AGE (§23A.2, kanban #1323): the median of the first heights the seats hold of it - one seat cannot make a young federation look old
    const fh = (firsts.get(fid) || []).slice().sort((a, b) => a - b);
    const aged = fh.length ? { ...st, firstHeight: fh[Math.floor((fh.length - 1) / 2)] } : st;
    out.set(fid, alarms.has(fid) ? { ...aged, alarm: alarms.get(fid), allows: { ...aged.allows, deposit: false } } : aged);
  }
  if (!out.size && failed.length) out.why = `no record stands: ${failed[0]}`;
  return out;
}

function statusOfRecord(best) {
  // LOAD AGAINST THE PLAYERS' MONEY (§23A.3a RULED 2026-11-07, kanban #1322): the record's player reserve when it names one
  const load = best.record.exposureCapSats > 0n ? Number((loadReserveOf(best.record) * 10000n) / best.record.exposureCapSats) / 10000 : null;
  const refusesDeposit = loadRefusesDeposit({ load, networkId: best.record.networkId });
  return { status: best.status, allows: refusesDeposit ? { ...FEDERATION_ALLOWS[best.status], deposit: false } : FEDERATION_ALLOWS[best.status],
    loadRefusesDeposit: refusesDeposit, signers: best.signers, height: best.record.height, from: best.from, network: networkOf(best.record.networkId),
    nominal: best.record.nominal, threshold: best.record.threshold, exposureCapSats: String(best.record.exposureCapSats),
    // THE LOAD (§23A.3): the signed reserve over the signed exposure cap - what the federation holds against what
    // its smallest set of leavers' bonds covers; null when the record names no cap
    reserveSats: String(best.record.reserveSats ?? 0n),
    load,
    // THE SUCCESSION (§23A.6): the successor the guardians named (hex, or null) and this federation's own invite,
    // so a page can open the player's wallet in the successor from the successor's record
    successorId: best.record.successorId && best.record.successorId.some((x) => x) ? bytesToHex(best.record.successorId) : null,
    invite: best.record.invite || null,
    // THE GATEWAY FEE CAP (§23A.9, kanban #1324): a swap's or a migration's leg in this federation goes only through a gateway at or under it
    gatewayFeeMax: best.record.gatewayFeeMax || null };
}

/**
 * A DEPOSIT REFUSED FOR THE LOAD (§23A.3: "A deposit into a federation at load >= 1 is refused by the client") - RULED
 * 2026-10-12 (option A): on mainnet only. A test network (regtest, testnet4) shows the load and warns,
 * and refuses nothing: testnet4's one federation holds 4.33x its cover, and its bonds are not raised for it.
 */
const TEST_NETWORKS = new Set(['regtest', 'testnet4']);
export function loadRefusesDeposit({ load, networkId }) {
  return typeof load === 'number' && load >= 1 && !TEST_NETWORKS.has(networkOf(networkId));
}

/**
 * WHICH FEDERATION A FIRST DEPOSIT GOES INTO (§23A.3, RULED: "the one holding least"): among the checked statuses
 * (`federationStatus` answers, each with its `federation` id), the OPEN ones on the known-good list (`known(fid)`), the
 * lowest load; ties by the newest record (its height). A federation whose load the record does not say comes after every
 * one that says it. Null when none is OPEN.
 */
export function pickFederation(statuses, { known = () => true } = {}) {
  // a federation whose deposits are stopped (an alarm, or its load on mainnet) is not picked (kanban #1093 part 5, #807)
  const open = (statuses || []).filter((f) => f && f.status === 'OPEN' && known(f.federation) && !f.alarm && !(f.allows && f.allows.deposit === false));
  if (!open.length) return null;
  const loadOf = (f) => (typeof f.load === 'number' ? f.load : Infinity);
  return [...open].sort((a, b) => loadOf(a) - loadOf(b) || (b.height || 0) - (a.height || 0))[0];
}

/**
 * THE FEDERATION A DEPOSIT GOES INTO (§23A.3 "First deposit. The client takes the OPEN federations of the census, drops those
 * not on its known-good list ..., and picks the one with the lowest load"). A FIRST deposit - this
 * browser holds no federation's wallet yet (`held` empty) - goes to pickFederation's answer over the verified statuses whose
 * record names an invite; a returning player stays ("A returning player stays in his federation"; Move is offered apart).
 * Otherwise, or when nothing better is verified, the lobby's federation.
 *   lobbyInvite        the lobby round's federation invite
 *   statuses           federationStatuses' answers (each with federation, status, load, invite)
 *   held               federation ids hex this browser holds a wallet in (ledgerFederations)
 *   known(fid)         on the known-good list or confirmed here
 *   sameFederation(invite, fid)   whether an invite names that federation (inviteNamesFederation)
 * Answers { invite, federation, lowest, why }.
 */
/**
 * TOO YOUNG FOR A FIRST DEPOSIT (§23A.2 RULED 2026-11-07, kanban #1297/#1323): "no federation younger than drain_blocks receives first deposits by
 * default" - its newest record's height less its first height (the seats' median) under its network's drain_blocks. A federation whose first
 * height no seat says is not held back (seats before this rule).
 */
export const drainBlocksOf = (network) => { try { return genesisFor(network).drainBlocks; } catch { return MAINNET_CLOCKS.drainBlocks; } };
export function tooYoung(f, { drainBlocks = null } = {}) {
  if (!f || !Number.isInteger(f.firstHeight) || !Number.isInteger(f.height)) return false;
  const d = Number.isInteger(drainBlocks) ? drainBlocks : drainBlocksOf(f.network);
  return f.height - f.firstHeight < d;
}
// `chosen` a federation id the player picked himself: a young one is taken then
export function depositFederation({ lobbyInvite, statuses = [], held = [], known = () => true, sameFederation = () => false, always = true, chosen = null, drainBlocks = null }) {
  const lobby = (why) => ({ invite: lobbyInvite, federation: null, lowest: false, why });
  // EVERY DEPOSIT TO THE LOWEST LOAD (RULED 2026-10-13 ~11:50Z: "It should always take the federation with less funds so
  // it's evened out"): a returning player too - the page sums every federation's wallet (ARENA_SUM_BALANCES), so where the money
  // sits is no longer the player's concern. `always: false` is §23A.3's earlier rule, a returning player staying where it holds.
  if (!always && held && held.length) {
    const mine = (statuses || []).find((f) => f && f.invite && takesDeposits(f.federation) && held.includes(String(f.federation).toLowerCase()));
    if (mine && !sameFederation(lobbyInvite, mine.federation)) return { invite: mine.invite, federation: mine.federation, lowest: false, why: 'a returning player stays in the federation it holds' };
    return lobby('a returning player stays in the federation it holds');
  }
  // A FEDERATION THAT TAKES NO NEW DEPOSITS IS NOT PICKED, whatever its load (kanban #807): at load 2 it won every pick from A at load 1338
  const pickedHere = chosen ? String(chosen).toLowerCase() : null;
  const open = (statuses || []).filter((f) => f && f.invite && takesDeposits(f.federation)
    && (String(f.federation).toLowerCase() === pickedHere || !tooYoung(f, { drainBlocks })));
  const pick = (pickedHere && pickFederation(open.filter((f) => String(f.federation).toLowerCase() === pickedHere), { known })) || pickFederation(open, { known });
  if (!pick) return lobby('no OPEN, known federation with a signed load');
  if (sameFederation(lobbyInvite, pick.federation)) return { invite: lobbyInvite, federation: pick.federation, lowest: true, why: 'the lobby federation is the lowest-load one' };
  return { invite: pick.invite, federation: pick.federation, lowest: true,
    why: `deposit: federation ${String(pick.federation).slice(0, 16)} has the lowest load (${typeof pick.load === 'number' ? pick.load.toFixed(2) : '-'})` };
}

/**
 * WHERE A STAKE IS LOCKED FOR A ROUND THAT TAKES ANY FEDERATION (2026.0.3 step 72026-10-13: "Es muss möglich
 * sein für alle Spiele über alle Federation zu zahlen", "It should always take the federation with less funds so it's evened out").
 * A lock spends notes of one federation, so only a federation whose wallet here covers the stake can hold it; among those the
 * lowest-load OPEN, known one (pickFederation). `parts` [{ federation, msat }] the wallet per federation (the summed balance's
 * parts); `statuses` federationStatuses' answers with invites. Answers { federation, invite, why } or { federation: null, why }.
 */
export function lockFederation({ stakeMsat, parts = [], statuses = [], known = () => true } = {}) {
  const need = BigInt(stakeMsat || 0);
  const covers = new Set((parts || []).filter((p) => p && p.federation && BigInt(p.msat ?? 0) >= need).map((p) => String(p.federation).toLowerCase()));
  if (!covers.size) return { federation: null, why: `no federation's wallet here holds the ${need / 1000n} sat stake: deposit first (it goes to the lowest-load federation)` };
  const pick = pickFederation((statuses || []).filter((f) => f && f.invite && covers.has(String(f.federation).toLowerCase())), { known });
  if (!pick) return { federation: null, why: 'no federation that holds the stake here is OPEN and known' };
  return { federation: String(pick.federation).toLowerCase(), invite: pick.invite,
    why: `lock in federation ${String(pick.federation).slice(0, 16)}: it holds the stake here and has the lowest load of those that do (${typeof pick.load === 'number' ? pick.load.toFixed(2) : '-'})` };
}

/**
 * MOVE, OFFERED (§23A.3): a returning player stays in their federation; Move is offered when it is above 90 % load and
 * another OPEN federation is below 50 % - that one named. (DRAINING and CRITICAL are not offers: §23A.6 moves by itself.)
 */
export function moveOffer(own, others = []) {
  if (!own || own.status !== 'OPEN' || typeof own.load !== 'number' || own.load <= 0.9) return null;
  const to = pickFederation((others || []).filter((f) => f && f.federation !== own.federation && typeof f.load === 'number' && f.load < 0.5));
  return to ? { from: own.federation, to: to.federation, fromLoad: own.load, toLoad: to.load } : null;
}

/** The sentence a page shows when a federation holds more than its guardians' bonds cover (load >= 1), else ''. */
export function loadSays(fed) {
  if (!fed || typeof fed.load !== 'number' || fed.load < 1) return '';
  const sat = (x) => `${Number(BigInt(x || 0)).toLocaleString('en-US')} sat`;
  return `Load ${fed.load.toFixed(2)}: this federation holds ${sat(fed.reserveSats)}, more than the ${sat(fed.exposureCapSats)} its guardians' bonds cover.`
    + (fed.loadRefusesDeposit ? ' No deposit goes into it; play in another federation.' : '');
}

/**
 * ALL FEDERATIONS TOGETHER, FOR THE DEPOSIT SCREEN (2026-10-12: "show the total amount of funds in all
 * federations, number of federations we have and total health before we will stop accepting deposits ... green/yellow/red
 * ... Show the total possible capacity"). From the verified statuses (federationStatuses), the ones with a signed cap:
 *   reserveSats  every federation's signed reserve, summed (the funds held)
 *   capSats      every federation's exposure cap, summed (the possible capacity)
 *   freeSats     what OPEN federations can still take before each reaches load 1 - where a deposit stops (§23A.3, ruled A:
 *                on mainnet; a test network shows and refuses nothing)
 *   load         reserve / cap over all of them; band green below 0.7, yellow from 0.7, red from 0.9 (Move is offered there)
 */
export function custodySummary(statuses, { networkTest = false } = {}) {
  const list = [...(statuses || [])].filter((f) => f && f.status !== 'unverified' && f.exposureCapSats !== undefined);
  let reserve = 0n, cap = 0n, free = 0n;
  for (const f of list) {
    const r = BigInt(f.reserveSats || 0), c = BigInt(f.exposureCapSats || 0);
    reserve += r; cap += c;
    if (f.status === 'OPEN' && c > r) free += c - r;
  }
  const load = cap > 0n ? Number((reserve * 10000n) / cap) / 10000 : null;
  const band = load === null ? 'unknown' : load >= 0.9 ? 'red' : load >= 0.7 ? 'yellow' : 'green';
  return { federations: list.length, open: list.filter((f) => f.status === 'OPEN').length, reserveSats: String(reserve), capSats: String(cap),
    freeSats: String(free), load, band, networkTest };
}

/** The deposit screen's line and its tooltip for a custodySummary. */
export function custodySays(c) {
  if (!c || !c.federations) return { line: 'Federations: none verified yet', tip: 'No federation record could be checked yet.', band: 'unknown' };
  const sat = (x) => `${Number(BigInt(x)).toLocaleString('en-US')} sat`;
  const pct = c.load === null ? '-' : `${Math.round(c.load * 100)} %`;
  const line = `${c.federations} federation${c.federations === 1 ? '' : 's'} · ${sat(c.reserveSats)} held · health ${pct} · capacity ${sat(c.capSats)} (${sat(c.freeSats)} free)`;
  const tip = `Funds held in all federations: ${sat(c.reserveSats)}. Possible capacity, what the guardians' bonds cover: ${sat(c.capSats)}. `
    + `Still free before deposits stop: ${sat(c.freeSats)}. A federation takes no deposit once its load reaches 100 % (its funds equal its cover). `
    + `Green below 70 %, yellow from 70 %, red from 90 % (Move is offered there).`
    + (c.networkTest ? ' This is a test network: the load is shown, and no deposit is refused for it.' : '');
  return { line, tip, band: c.band };
}

/** The sentence a page shows when Move is offered (moveOffer's answer), else ''. */
export function moveSays(offer) {
  if (!offer) return '';
  const pct = (x) => `${Math.round(x * 100)} %`;
  return `This federation is at ${pct(offer.fromLoad)} load; federation ${String(offer.to).slice(0, 16)} is at ${pct(offer.toLoad)}. Move is offered: your money can go there.`;
}

/** The sentence a page shows for a federation with a reserve alarm (kanban #1093 part 5), else ''. */
export function alarmSays(fed) {
  if (!fed || !fed.alarm) return '';
  const what = fed.alarm.kind === 'inflation' ? 'more e-cash was redeemed than was ever issued'
    : fed.alarm.kind === 'unbacked-spend' ? 'its reserve was spent on the chain with no peg-out its guardians signed' : 'a mark of theft was seen';
  return `Deposits into this federation are stopped: in its own signed history, ${what}. Your notes in it are covered by its guardians' bonds; Withdraw and Move stay open while they work.`;
}

/** The sentence a page shows for a status that holds something back. */
export function federationSays(status) {
  return ({
    DRAINING: 'This federation is being replaced: no new deposit goes into it. Play, Withdraw and Move work as before.',
    CRITICAL: 'This federation is one guardian away from halting: only Withdraw and Move are open.',
    HALTED: 'This federation has halted: every note and lock is frozen until its guardians return or it is liquidated.',
    CLOSED: 'This federation is closed: its successor holds everything.',
    unverified: 'No signed record of this federation could be checked: nothing about it is taken on trust.',
  })[status] || '';
}

// ---- the known-good list and the player's own confirmation (spec §23.6) ----
import { federationIsKnown, knownFederation, takesDeposits } from '../../arena-protocol/src/known-federations.js';
export { federationIsKnown, knownFederation };

/** Every guardian of `federationIdHex` in a census this client checked: operator, node key, guardian endpoint, bond. */
export function guardianRowsOf(census, federationIdHex) {
  const fid = String(federationIdHex).toLowerCase();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const rows = [];
  for (const e of census || []) {
    const g = ((e.advert && e.advert.guardianOf) || []).find((x) => hex(x.federationId) === fid);
    if (g) rows.push({ operator: (e.advert && e.advert.operatorId) || '', nodeKey: hex(e.pubkey), guardianKey: hex(g.guardianKey),
      endpoint: (e.advert && e.advert.guardianEndpoint) || '', bondSats: String(e.bondSats) });
  }
  return rows.sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : 1));
}

const CONFIRM_KEY = 'arena.fed.confirmed.';
/** This browser's own confirmation of a federation not on the list: asked once, kept until Forget. */
export const federationConfirmed = (storage, fidHex) => { try { return !!storage.getItem(CONFIRM_KEY + String(fidHex).toLowerCase()); } catch { return false; } };
export function confirmFederation(storage, fidHex, nowMs = Date.now()) { storage.setItem(CONFIRM_KEY + String(fidHex).toLowerCase(), String(nowMs)); }
export function forgetFederation(storage, fidHex) { storage.removeItem(CONFIRM_KEY + String(fidHex).toLowerCase()); }
export function confirmedFederations(storage) {
  const out = [];
  try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(CONFIRM_KEY)) out.push({ federation: k.slice(CONFIRM_KEY.length), atMs: Number(storage.getItem(k)) }); } } catch { /* none */ }
  return out;
}

/** Does this invite name the round's federation? The stock Fedimint client checks the config hash itself when it joins. */
export function inviteNamesFederation(invite, federationIdHex) {
  let f; try { f = readInvite(invite).federationId; } catch { return false; }
  return !!f && String(f).toLowerCase() === String(federationIdHex).toLowerCase();
}

/**
 * THE FEDERATION A WITHDRAW READS (with every deposit going to the lowest load): the one of `parts` - the summed
 * balance's split, [{ federation, sats }] - holding the most, among those whose invite a verified status names; else the lobby's.
 * One federation per withdraw; a withdraw over several federations at once is a later step.
 */
export function withdrawFederation({ lobbyInvite, parts = [], statuses = [] }) {
  const inviteOf = (fid) => { const st = (statuses || []).find((f) => f && f.invite && String(f.federation).toLowerCase() === String(fid).toLowerCase()); return st ? st.invite : null; };
  const best = [...(parts || [])].filter((p) => p && p.sats > 0 && inviteOf(p.federation)).sort((a, b) => b.sats - a.sats)[0];
  return best ? { invite: inviteOf(best.federation), federation: best.federation, sats: best.sats, why: `withdraw from federation ${String(best.federation).slice(0, 16)}, which holds the most (${best.sats} sat)` }
    : { invite: lobbyInvite, federation: null, sats: null, why: 'the lobby\'s federation' };
}

/**
 * WHERE A DRAINING FEDERATION'S NOTES GO (2026-10-13 ~12:00Z: "When a federation is draining the client has automatically
 * to move it to a safe federation"): `from` is a federation's checked status ({ federation, status, successorId }). DRAINING or
 * CRITICAL only. Its named successor when that one is OPEN with an invite; else the lowest-load OPEN, known federation other
 * than itself (pickFederation). Null when there is nowhere safe - the notes stay and the next status read tries again.
 */
export function safeFederation(from, statuses = [], { known = () => true } = {}) {
  if (!from || !['DRAINING', 'CRITICAL'].includes(from.status)) return null;
  const me = String(from.federation || '').toLowerCase();
  const usable = (statuses || []).filter((f) => f && f.invite && String(f.federation).toLowerCase() !== me);
  const succ = from.successorId && !/^0+$/.test(String(from.successorId))
    ? usable.find((f) => String(f.federation).toLowerCase() === String(from.successorId).toLowerCase() && f.status === 'OPEN' && known(f.federation)) : null;
  return succ || pickFederation(usable, { known });
}
