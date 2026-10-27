// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEARTBEAT (§5A.3, protocol 22, kanban #727, the owner 2026-10-27). The testnet4 day of 2026-10-27 again - 28 bonded nodes, 20 of them
// stopped with their bonds still locked - now with a heartbeat: every round of a 15-min grid has 3 heartbeat slots 5 min apart, each
// with a committee of 9 drawn on the round's census and beacon, and a certificate of 5 of them proves every node they did not hear
// missed at that slot. A node is out on 3 missed closes at least 1 h apart, present at none. Every certificate a check reads is signed
// for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { drawCommittee } from '../src/sortition.js';
import { toHex, fromHex } from '../src/hash.js';
import { PRESENCE_VERSION, ABSENCE_PROOF_SEATINGS, HEARTBEAT_THRESHOLD, HEARTBEAT_DRAWN, HEARTBEAT_SLOTS_PER_ROUND } from '../src/constants.js';
import { drawHeartbeat, signHeartbeat, verifyHeartbeat, decodeHeartbeat, signHeard, encodeHeartbeatCertificate, decodeHeartbeatCertificate,
  verifyHeartbeatCertificate, heartbeatRole, heartbeatSlotOf, hasHeartbeats, heartbeatCloseMs, HEARTBEAT_BYTES, HEARTBEAT_ROLES } from '../src/heartbeat.js';
import { absentFrom, withoutAbsent, checkAbsenceProof, presenceWindow, PRESENCE_WINDOW_MS, spacedCloses, provenProof } from '../src/presence.js';
import { seatingCloseMs, signSeating, signSeen, seatingId, encodeSeatingCertificate } from '../src/seating.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const keyOf = new Map();
const key = (k) => { if (!keyOf.has(k)) keyOf.set(k, schnorr.getPublicKey(b32(k))); return keyOf.get(k); };
const hex = (k) => toHex(key(k));
const byHex = new Map();
const entry = (k) => { const txid = b32(k); txid[0] = 0x70; byHex.set(hex(k), k); return { txid, vout: 0, pubkey: key(k), bondSats: 100000n, height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], spent: false, advertId: b32(0xad) }; };
const contract = { gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST, gameId: NEXTBLOCK_GAME_ID, protocolVersion: PRESENCE_VERSION };
const DEAD = Array.from({ length: 20 }, (_, i) => i + 1);
const LIVE = Array.from({ length: 8 }, (_, i) => i + 21);
const census = [...DEAD, ...LIVE].map(entry);
const chainKeys = census.map((e) => toHex(e.pubkey));
const liveSet = new Set(LIVE.map(hex));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const signBy = (h) => (m) => schnorr.sign(m, b32(byHex.get(h)));
const seed = (s, d) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; b[2] = 0x27; b[3] = d; b[4] = 0xbe; return b; };
const T0 = 1793145600000n;

/** A heartbeat certificate, signed for real: each of `signers` signs `heard` (or its own list in `lists`). */
function certify({ roundId, slot, signers, heard, leftOut = [], lists = {}, signAs = (h) => signBy(h) }) {
  const rid = fromHex(roundId);
  const groups = new Map();
  for (const h of signers) {
    const list = lists[h] || heard;
    const k = `${[...list].sort().join(',')}|${[...leftOut].sort().join(',')}`;
    if (!groups.has(k)) groups.set(k, { heard: list, leftOut, signatures: [] });
    groups.get(k).signatures.push({ nodePubkey: fromHex(h), signature: signHeard({ roundId: rid, slot, heard: list, leftOut }, signAs(h)) });
  }
  return encodeHeartbeatCertificate({ roundId: rid, slot, groups: [...groups.values()] });
}

/**
 * ONE DAY OF A 15-MIN GRID ON `entries`: 96 rounds, each with its seating (the 9 drawn; seated when 5 are live) and its 3 heartbeat
 * slots (a committee of 9 each; a certificate when 5 members are live, listing every live node - each hands its heartbeat to all 9).
 * `silent(h, closeMs)`: a live node not heard at that moment (flooded, restarting). Answers every proof slot with what a checker draws.
 */
function day(entries, d, w, { silent = () => false } = {}) {
  const inCensus = entries.map((e) => toHex(e.pubkey));
  const leftOut = chainKeys.filter((h) => !inCensus.includes(h));
  const out = [];
  for (let i = 0; i < 96; i++) {
    const roundId = toHex(seed(1000 + i, d));
    const closeMs = w.fromMs + BigInt(i + 1) * 900000n;
    const roundSeed = seed(i, d);
    const drawn = drawCommittee({ entries, contract, role: 'settlement', committeeSeed: roundSeed }).map((e) => toHex(e.pubkey));
    const heardAt = (c) => [...liveSet].filter((h) => !silent(h, c));
    const present = drawn.filter((h) => heardAt(closeMs).includes(h));
    const seated = present.slice(0, 7);
    out.push({ kind: 'seating', roundId, role: 'settlement', closeMs, drawn, slots: 7, present, leftOut, seated: seated.length >= 5 ? seated : null });
    for (let j = 0; j < HEARTBEAT_SLOTS_PER_ROUND; j++) {
      const c = closeMs - BigInt(j) * 300000n;
      const committee = drawHeartbeat({ entries, contract, committeeSeed: roundSeed, slot: j }).map((e) => toHex(e.pubkey));
      const heard = heardAt(c);
      const signers = committee.filter((h) => heard.includes(h));
      out.push({ kind: 'heartbeat', roundId, role: heartbeatRole(j), slot: j, closeMs: c, drawn: committee, expected: inCensus, census: inCensus,
        present: heard, leftOut, seated: signers.length >= HEARTBEAT_THRESHOLD ? signers : null });
    }
  }
  return out;
}
/** What a posting node holds: the slots a certificate stands for, as presence.js reads them. */
const proven = (slots) => slots.filter((s) => s.seated).map((s) => ({ roundId: s.roundId, role: s.role, closeMs: s.closeMs, drawn: s.drawn,
  ...(s.expected ? { expected: s.expected } : {}), seated: s.seated, present: [...new Set([...s.present, ...s.seated])], leftOut: s.leftOut }));
/** A 22 seating certificate, signed for real by its seated: each signs the seating and a SEEN of who was present. */
function seatingCert({ roundId, role, seated, present, leftOut }) {
  const rid = fromHex(roundId), keys = seated.map(fromHex);
  const id = seatingId({ roundId: rid, role, seated: keys });
  return encodeSeatingCertificate({ roundId: rid, role, seated: keys,
    signatures: seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeating({ roundId: rid, role, seated: keys }, signBy(h)) })),
    seen: [{ present, leftOut, signatures: seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeen({ roundId: rid, role, seating: id, present, leftOut }, signBy(h)) })) }] });
}
/** What a checker has: its own draw of each slot, and the certificates (signed when first asked). */
function checker(slots) {
  const by = new Map(slots.map((s) => [`${s.roundId}:${s.role}`, s]));
  const certs = new Map();
  return {
    drawOf: (rid, role) => {
      const s = by.get(`${rid}:${role}`);
      if (!s) return null;
      return s.kind === 'heartbeat' ? { heartbeat: s.slot, drawn: s.drawn, census: s.census, closeMs: s.closeMs } : { drawn: s.drawn, slots: 7, closeMs: s.closeMs };
    },
    certOf: (rid, role) => {
      const k = `${rid}:${role}`;
      if (!certs.has(k)) {
        const s = by.get(k);
        certs.set(k, !s || !s.seated ? null : s.kind === 'heartbeat' ? certify({ roundId: s.roundId, slot: s.slot, signers: s.seated, heard: s.present, leftOut: s.leftOut })
          : seatingCert(s));
      }
      return certs.get(k);
    },
  };
}

test('a HEARTBEAT is signed by its node; a certificate stands with 5 members of the slot\'s committee, and never with 4, a stranger or a member twice', () => {
  const rid = seed(1, 0), committee = LIVE.map(hex).concat([hex(1)]);
  const hb = signHeartbeat({ roundId: rid, slot: 2, nodePubkey: key(21) }, signBy(hex(21)));
  assert.equal(hb.length, HEARTBEAT_BYTES);
  assert.equal(verifyHeartbeat(hb, { roundId: rid, verify }).ok, true);
  assert.equal(decodeHeartbeat(hb).slot, 2);
  assert.match(verifyHeartbeat(signHeartbeat({ roundId: rid, slot: 0, nodePubkey: key(21) }, signBy(hex(22))), { verify }).why, /not signed by the node it names/);
  assert.match(verifyHeartbeat(hb, { roundId: seed(2, 0), verify }).why, /another round/);
  assert.throws(() => signHeartbeat({ roundId: rid, slot: 3, nodePubkey: key(21) }, signBy(hex(21))), /slot/);
  const heard = LIVE.map(hex);
  const check = { roundId: rid, slot: 1, committee, census: chainKeys, verify };
  const five = certify({ roundId: toHex(rid), slot: 1, signers: heard.slice(0, 5), heard });
  const v = verifyHeartbeatCertificate(five, check);
  assert.equal(v.ok, true, v.why);
  assert.deepEqual(v.heard, [...heard].sort());
  assert.equal(decodeHeartbeatCertificate(five).slot, 1);
  // a member that heard one more: present if ANY signer lists it
  const more = certify({ roundId: toHex(rid), slot: 1, signers: heard.slice(0, 5), heard, lists: { [heard[2]]: [...heard, hex(3)] } });
  assert.ok(verifyHeartbeatCertificate(more, check).heard.includes(hex(3)));
  assert.match(verifyHeartbeatCertificate(certify({ roundId: toHex(rid), slot: 1, signers: heard.slice(0, 4), heard }), check).why, /signed by 4 of the slot's committee, fewer than the 5/);
  assert.match(verifyHeartbeatCertificate(certify({ roundId: toHex(rid), slot: 1, signers: [...heard.slice(0, 4), hex(2)], heard }), check).why, /not drawn for its committee/);
  assert.match(verifyHeartbeatCertificate(certify({ roundId: toHex(rid), slot: 1, signers: heard.slice(0, 5), heard, signAs: (h) => (h === heard[0] ? signBy(heard[1]) : signBy(h)) }), check).why, /does not verify/);
  assert.match(verifyHeartbeatCertificate(certify({ roundId: toHex(rid), slot: 1, signers: heard.slice(0, 5), heard, leftOut: [hex(1)] }), check).why, /left out a node the census holds/);
  assert.match(verifyHeartbeatCertificate(five, { ...check, slot: 0 }).why, /for slot 1, not 0/);
  // one member's two lists in one certificate
  const rid1 = toHex(rid);
  const twice = encodeHeartbeatCertificate({ roundId: rid, slot: 1, groups: [
    { heard, leftOut: [], signatures: heard.slice(0, 5).map((h) => ({ nodePubkey: fromHex(h), signature: signHeard({ roundId: rid, slot: 1, heard, leftOut: [] }, signBy(h)) })) },
    { heard: heard.slice(1), leftOut: [], signatures: [{ nodePubkey: fromHex(heard[0]), signature: signHeard({ roundId: rid, slot: 1, heard: heard.slice(1), leftOut: [] }, signBy(heard[0])) }] }] });
  assert.match(verifyHeartbeatCertificate(twice, check).why, /signed two heard lists/);
  assert.ok(rid1);
  // slots and roles
  assert.deepEqual(HEARTBEAT_ROLES, ['heartbeat-0', 'heartbeat-1', 'heartbeat-2']);
  assert.equal(heartbeatSlotOf('heartbeat-2'), 2); assert.equal(heartbeatSlotOf('heartbeat-3'), null); assert.equal(heartbeatSlotOf('game'), null);
  const c = { ...contract, startTimeMs: T0 };
  assert.equal(hasHeartbeats(c), true);
  assert.equal(hasHeartbeats({ ...c, protocolVersion: 21 }), false, 'below 22: no heartbeat slots');
  assert.equal(heartbeatCloseMs(c, 2), seatingCloseMs(c) - 600000n, 'slot 2 closes 10 min before the seating');
  // a slot's committee: 9, one key one seat, its own draw per slot
  const a = drawHeartbeat({ entries: census, contract, committeeSeed: seed(5, 0), slot: 0 }).map((e) => toHex(e.pubkey));
  const b = drawHeartbeat({ entries: census, contract, committeeSeed: seed(5, 0), slot: 1 }).map((e) => toHex(e.pubkey));
  assert.equal(a.length, HEARTBEAT_DRAWN); assert.equal(new Set(a).size, HEARTBEAT_DRAWN);
  assert.notDeepEqual(a, b, 'each slot draws its own committee');
  assert.notDeepEqual(a, drawCommittee({ entries: census, contract, role: 'settlement', committeeSeed: seed(5, 0) }).map((e) => toHex(e.pubkey)), 'and not the round\'s seats');
});

// THE 10-27 SHAPE, WITH THE HEARTBEAT: day 0's certificates prove every stopped node out, so the first census already holds only the 8
// live nodes; no live node is ever proven absent; every round of every later day is seated.
test('the 10-27 shape with the heartbeat: all 20 stopped nodes are proven out by the first census, no live node ever is', () => {
  let entries = census;
  const facts = [];
  let T = T0, allOutAt = null;
  for (let d = 0; d < 3; d++) {
    const w = presenceWindow(T);
    const slots = day(entries, d, w);
    const seatedRounds = slots.filter((s) => s.kind === 'seating' && s.seated).length;
    const beats = slots.filter((s) => s.kind === 'heartbeat' && s.seated).length;
    const claims = absentFrom({ seatings: proven(slots), census: chainKeys, window: w });
    assert.ok(claims.every((c) => !liveSet.has(c.node)), `day ${d}: no live node is proven absent`);
    assert.ok(claims.every((c) => c.proofs.length === ABSENCE_PROOF_SEATINGS), 'each absence names 3 slots');
    const ch = checker(slots);
    assert.deepEqual(checkAbsenceProof(claims, { census: chainKeys, window: w, verify, ...ch }), { ok: true }, `day ${d}: the claim stands at a checker`);
    facts.push(`day ${d}: census ${entries.length}, seated ${seatedRounds}/96, heartbeat certificates ${beats}/288, proven absent ${claims.length}`);
    if (allOutAt === null && claims.length === DEAD.length) allOutAt = d;
    entries = withoutAbsent(census, claims);
    T += PRESENCE_WINDOW_MS;
  }
  console.log(`  FACTS: 28 bonded, 20 stopped, with the heartbeat; ${facts.join('; ')}`);
  assert.equal(allOutAt, 0, 'the first census after the stop already leaves out all 20 stopped nodes');
});

test('DoS and short outages: a node missed at 2 slots stays in; an outage under 2 h is never proof; 3 misses an hour apart are', () => {
  const w = presenceWindow(T0);
  const victim = hex(21);
  // a node flooded at 2 heartbeat slots 3 h apart, heard at every other: kept, by the posting node and at every checker
  const flood = new Set([w.fromMs + 4n * 3600000n, w.fromMs + 7n * 3600000n].map(String));
  // on the census of the 8 live nodes (the day after 10-27): every slot is certified
  const live = census.filter((e) => liveSet.has(toHex(e.pubkey)));
  const slots = day(live, 0, w, { silent: (h, c) => h === victim && [...flood].some((f) => BigInt(f) - c >= 0n && BigInt(f) - c < 900000n) });
  const proofs = proven(slots);
  assert.ok(!absentFrom({ seatings: proofs, census: chainKeys, window: w }).some((c) => c.node === victim), 'present at most slots of the day: kept');
  const missed = proofs.filter((s) => (s.expected || s.drawn).includes(victim) && !s.present.includes(victim));
  assert.ok(missed.length >= 1, 'it did miss some slots');
  assert.equal(spacedCloses(missed.map((s) => s.closeMs)), 2, 'at 2 moments an hour or more apart');
  const ch = checker(slots);
  const r = checkAbsenceProof([{ node: victim, proofs: missed.slice(0, 3).map((s) => ({ roundId: s.roundId, role: s.role })) }], { census: chainKeys, window: w, verify, ...ch });
  assert.equal(r.ok, false); assert.equal(r.proof, 'too-few');
  // an outage of 1 h 50 min (a restart that went badly): every slot of it missed - and still no proof, even naming only those slots
  const from = w.fromMs + 10n * 3600000n, to = from + 110n * 60000n;
  const out = day(live, 0, w, { silent: (h, c) => h === victim && c > from && c <= to });
  const inOutage = proven(out).filter((s) => s.closeMs > from && s.closeMs <= to);
  assert.ok(inOutage.filter((s) => !s.present.includes(victim)).length >= 3, 'it missed several slots in a row');
  assert.deepEqual(absentFrom({ seatings: inOutage, census: [victim], window: w }), [], 'one outage under 2 h: not 3 misses an hour apart');
  // three misses an hour apart and present nowhere else named: absent - that is the bar, and the honest posting node, holding the rest of
  // the day, never reaches it (above)
  const at = (h) => ({ roundId: toHex(seed(900 + Number(h), 0)), role: 'heartbeat-0', closeMs: w.fromMs + h * 3600000n, drawn: [], expected: [victim], seated: [], present: [], leftOut: [] });
  assert.deepEqual(absentFrom({ seatings: [1n, 2n, 3n].map(at), census: [victim], window: w }).map((c) => c.node), [victim]);
  assert.deepEqual(absentFrom({ seatings: [1n, 2n].map(at).concat([{ ...at(3n), closeMs: w.fromMs + 2n * 3600000n + 3599999n }]), census: [victim], window: w }), [], 'a second short of the hour: no');
});

test('a colluding minority cannot exclude an honest node: 4 members make no certificate; 5 colluders still need 5 seats of one random committee, at 3 moments an hour apart', () => {
  const w = presenceWindow(T0);
  const honest = hex(21);
  const slots = day(census, 0, w);
  const ch = checker(slots);
  // the colluders: 4 nodes, drawn into some committee; they sign HEARDs that leave the honest node out
  const COLL = [1, 2, 3, 4].map(hex);
  const run = (bytes, s) => checkAbsenceProof([{ node: honest, proofs: [{ roundId: s.roundId, role: s.role }] }], { census: chainKeys, window: w, verify,
    drawOf: ch.drawOf, certOf: () => bytes });
  const withThem = slots.filter((s) => s.kind === 'heartbeat' && COLL.filter((h) => s.drawn.includes(h)).length >= 2);
  assert.ok(withThem.length > 0);
  for (const s of withThem.slice(0, 5)) {
    const in4 = COLL.filter((h) => s.drawn.includes(h));
    // 1. only the colluders' HEARDs: fewer than 5 members - no certificate at all
    const own = certify({ roundId: s.roundId, slot: s.slot, signers: in4, heard: in4 });
    assert.equal(run(own, s).proof, 'certificate');
    // 2. padded with an honest member's HEARD to reach 5: that member heard the honest node - present
    const honestMembers = s.drawn.filter((h) => liveSet.has(h) && !in4.includes(h));
    if (in4.length + honestMembers.length < 5) continue;
    const padded = certify({ roundId: s.roundId, slot: s.slot, signers: [...in4, ...honestMembers.slice(0, 5 - in4.length)], heard: in4, lists: Object.fromEntries(honestMembers.map((h) => [h, [...liveSet]])) });
    assert.equal(run(padded, s).proof, 'present');
    // 3. an honest member's signature forged by a colluder: does not verify
    const forged = certify({ roundId: s.roundId, slot: s.slot, signers: [...in4, ...honestMembers.slice(0, 5 - in4.length)], heard: in4, signAs: (h) => signBy(in4.includes(h) ? h : in4[0]) });
    assert.equal(run(forged, s).proof, 'certificate');
    // 4. a non-member colluder signing a slot it was not drawn for
    const stranger = COLL.find((h) => !s.drawn.includes(h));
    if (stranger) assert.equal(run(certify({ roundId: s.roundId, slot: s.slot, signers: [...in4, stranger, ...honestMembers].slice(0, 5), heard: in4 }), s).proof, 'certificate');
  }
  // HOW OFTEN A GROUP HOLDS 5 OF A SLOT'S 9 SEATS, over 20 days of 288 slots on the 28-node census - the only way a group makes a certificate
  // without an honest member. Fewer than 5 never; the bar per day is 3 such slots an hour apart.
  const rates = {};
  for (const c of [4, 5, 6, 7]) {
    const group = new Set(Array.from({ length: c }, (_, i) => hex(i + 1)));
    let days3 = 0, total = 0;
    for (let d = 0; d < 20; d++) {
      const closes = [];
      for (let i = 0; i < 96; i++) for (let j = 0; j < 3; j++) {
        const m = drawHeartbeat({ entries: census, contract, committeeSeed: seed(i, 100 + d), slot: j }).filter((e) => group.has(toHex(e.pubkey))).length;
        if (m >= HEARTBEAT_THRESHOLD) closes.push(BigInt(i * 900000 - j * 300000));
      }
      total += closes.length;
      if (spacedCloses(closes) >= 3) days3++;
    }
    rates[c] = { perDay: total / 20, days: days3 };
  }
  console.log(`  FACTS: slots a colluding group fills 5 of 9 seats of, per day (20 days of 288 on 28 nodes): ${Object.entries(rates).map(([c, r]) => `${c} nodes ${r.perDay.toFixed(2)}/day, ${r.days}/20 days with 3 an hour apart`).join('; ')}`);
  assert.equal(rates[4].perDay, 0, 'a group of 4 never makes a certificate');
});

test('a proof names a seating or a heartbeat slot, and a draw of the wrong kind does not stand', () => {
  const w = presenceWindow(T0);
  const slots = day(census, 0, w);
  const s = slots.find((x) => x.kind === 'heartbeat' && x.seated);
  const ch = checker(slots);
  const bytes = ch.certOf(s.roundId, s.role);
  assert.equal(provenProof(bytes, { roundId: s.roundId, role: s.role, d: ch.drawOf(s.roundId, s.role), verify }).ok, true);
  assert.match(provenProof(bytes, { roundId: s.roundId, role: s.role, d: { drawn: s.drawn, slots: 7, closeMs: s.closeMs }, verify }).why, /not of heartbeat slot/);
  assert.equal(provenProof(bytes, { roundId: s.roundId, role: 'settlement', d: { drawn: s.drawn, slots: 7, closeMs: s.closeMs }, verify }).ok, false, 'a heartbeat certificate is no seating');
});

test('traffic: a node\'s heartbeat bytes per day, at 28 nodes and at 500', () => {
  const perDay = 96 * HEARTBEAT_SLOTS_PER_ROUND;
  const facts = [];
  for (const n of [28, 500]) {
    const keys = Array.from({ length: n }, (_, i) => b32(i + 1));
    const heard = encodeHeartbeatCertificate({ roundId: b32(9), slot: 0, groups: [{ heard: keys, leftOut: [], signatures: [] }] }).length - (1 + 2 + 32 + 1 + 2);
    const out = perDay * HEARTBEAT_DRAWN * HEARTBEAT_BYTES;                    // its HEARTBEAT to each of the 9 members of every slot
    const memberships = perDay * HEARTBEAT_DRAWN / n;                           // slots it is drawn for
    const inbound = memberships * n * HEARTBEAT_BYTES;                          // every node's HEARTBEAT, as a member
    const heardOut = memberships * (HEARTBEAT_DRAWN - 1) * (heard + 64 + 32);   // its HEARD to the 8 other members
    const cert = memberships * (heard + HEARTBEAT_DRAWN * 96 + 40);             // the certificates it keeps
    facts.push(`${n} nodes: out ${Math.round((out + heardOut) / 1024)} KB, in ${Math.round((inbound + heardOut) / 1024)} KB, kept ${Math.round(cert / 1024)} KB a day (${memberships.toFixed(1)} memberships)`);
    assert.ok(out + heardOut < 2 * 1024 * 1024, 'under 2 MB out a day');
  }
  console.log(`  FACTS: heartbeat traffic per node per day: ${facts.join('; ')}`);
});
