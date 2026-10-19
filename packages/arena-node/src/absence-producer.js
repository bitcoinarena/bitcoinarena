// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN'S OWN ABSENCE ATTESTATIONS (spec §23A.4: "Each guardian signs, once a day while it lasts, (federation_id, peer,
// last_seen_height, height) for every peer it has not seen in consensus"), the producing slice - absence.js holds the
// signed objects and absences.js the seat's store. The node runs its guardian (§23A.2), so it asks it: the admin `status` of the
// stock API names, per peer id, its connection and the last session it contributed to (measured on testnet4 A at 07:0xZ: six
// peers connected, last_contribution 5082 = session_count). A peer is SEEN while it contributed to the newest or the previous
// session; the height at which this node last saw it so is its last_seen_height. While a peer is not seen, the node signs an
// attestation for it - the first at once, then one per `every` blocks (a day: 144) - with its node key.
//
// Peer ids are mapped to the peer keys a federation record lists through the federation's own config: its
// `broadcast_public_keys`, by peer id (federation.js: the guardian keys are the config's broadcast keys).
import { signAbsence, signDeparture } from '../../arena-protocol/src/absence.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

export function createAbsenceProducer({ federationId, peerKeyOf, ownPeerId, status, height, attester, sign, every = 144, load = () => null, save = () => {} }) {
  const lastSeen = new Map();                // peer id -> chain height at which it was last seen contributing
  const lastSigned = new Map();              // peer id -> the height of this node's last attestation for it
  // KEPT ACROSS RESTARTS (a restart must not move a peer's last_seen_height forward): { seen: {id: h}, signed: {id: h} }
  try { const was = load() || {}; for (const [k, v] of Object.entries(was.seen || {})) lastSeen.set(Number(k), Number(v)); for (const [k, v] of Object.entries(was.signed || {})) lastSigned.set(Number(k), Number(v)); } catch { /* a stored view that no longer reads */ }
  /** One look at the guardian; answers { session, seen: [id], absent: [{ id, lastSeenHeight }], signed: [attestation] }. */
  async function pass() {
    const st = await status();
    const fed = st && st.federation;
    if (!fed || !Number.isInteger(fed.session_count)) return { ok: false, why: 'the guardian runs no consensus to read' };
    const tip = await height();
    const session = fed.session_count;
    const seen = []; const absent = []; const signed = [];
    for (const [id, p] of Object.entries(fed.status_by_peer || {})) {
      const pid = Number(id);
      if (pid === ownPeerId) continue;
      const contributed = Number.isInteger(p && p.last_contribution) ? p.last_contribution : -1;
      if (contributed >= session - 1) { lastSeen.set(pid, tip); lastSigned.delete(pid); seen.push(pid); continue; }
      // never seen by this node since it started: from now, not earlier (an attestation names no absence it did not watch)
      if (!lastSeen.has(pid)) lastSeen.set(pid, tip);
      const since = lastSeen.get(pid);
      absent.push({ id: pid, lastSeenHeight: since, lastContribution: contributed });
      const prev = lastSigned.get(pid);
      if (tip <= since || (prev !== undefined && tip - prev < every)) continue;
      const peerKey = peerKeyOf(pid);
      if (!peerKey) continue;
      signed.push(signAbsence({ federationId: fromHex(federationId), peerKey, lastSeenHeight: since, height: tip, attester }, sign));
      lastSigned.set(pid, tip);
    }
    if (absent.length || signed.length || seen.length) save({ seen: Object.fromEntries(lastSeen), signed: Object.fromEntries(lastSigned) });
    return { ok: true, session, height: tip, seen, absent, signed };
  }
  return { pass };
}

/** The guardian's own peer id and its federation's broadcast keys by peer id (local.json, client.json in its data dir). */
export function guardianConfigOf(dir, readFile) {
  const local = JSON.parse(readFile(`${dir}/local.json`));
  const client = JSON.parse(readFile(`${dir}/client.json`));
  const keys = (client.global || client).broadcast_public_keys || {};
  return { ownPeerId: Number(local.identity), peerKeyOf: (id) => (keys[String(id)] ? fromHex(String(keys[String(id)])) : null) };
}

/** The guardian's admin status over its own API socket (the stock JSON-RPC `status`, authenticated with its admin password). */
export async function wsAdminStatus(port, password, { timeoutMs = 10000, WebSocketImpl = null } = {}) {
  const WS = WebSocketImpl || (await import('ws')).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${port}/`);
    const done = (f, v) => { clearTimeout(t); try { ws.close(); } catch { /* closed */ } f(v); };
    const t = setTimeout(() => done(reject, new Error('no answer in time')), timeoutMs);
    ws.on('error', (e) => done(reject, e));
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [{ auth: password, params: null }] })));
    ws.on('message', (m) => { try { const j = JSON.parse(String(m)); if (j.id === 1) done(j.result ? resolve : reject, j.result || new Error(JSON.stringify(j.error || j))); } catch (e) { done(reject, e); } });
  });
}

/**
 * A GUARDIAN'S OWN DEPARTURE NOTICE (§23A.5, RULED 2026-09-21 "Leaving is legitimate"): when its owner signs Leave, the
 * node signs (federation_id, its peer key, leave_after = tip + departure_notice, posted_at = tip) with its node key - the
 * shortest notice that stands. `own` is { federation (hex), peerKey } of the record that names this node a guardian.
 */
export function ownDeparture({ own, tip, departureNotice, nodePubkey, sign }) {
  if (!Number.isInteger(tip) || !Number.isInteger(departureNotice)) throw new Error('a departure notice needs the chain tip and the departure_notice clock');
  return signDeparture({ federationId: fromHex(own.federation), peerKey: own.peerKey, leaveAfterHeight: tip + departureNotice, postedAt: tip, nodePubkey }, sign);
}
