// THE FEDERATION RECORDS A SEAT SIGNS, GATHERS AND MIRRORS (spec §23A.4, kanban #321).
//
// The body is built from what every seat of a series reads the same: the census of the newest round it holds (the
// census nodes whose bond advertisements name the federation in guardian_of[]), at that round's census height - so seats
// on one series build byte-identical bodies and their signatures add up. A guardian is GONE when its own node says it is
// leaving (the owner's leave, owner-leave.js), signed with the node key beside its record signature. ABANDONED - 2f + 1
// absence attestations for abandon_blocks - needs each guardian's per-peer consensus view from the federation client and
// is not counted yet; the record says nothing it cannot back.
//
// A seat that is a guardian signs the body (GET /federation-record); every seat gathers the guardians' signatures from
// their endpoints and, at the threshold, keeps the signed record and mirrors it at GET /federations. A record whose status
// is DRAINING, CRITICAL or CLOSED makes the federation draining at this seat (no new round names it).
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { abandonmentProof } from '../../arena-protocol/src/absence.js';
import { absenceHex, readAbsenceHex, departureHex, readDepartureHex, dueDeparture } from './absences.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, verifyFederationRecord,
  FEDERATION_STATUS, GONE } from '../../arena-protocol/src/federation-record.js';

/** The census nodes guarding `federationId`, as the record lists them. */
export function guardiansOf(census, federationId) {
  const fid = toHex(federationId);
  const out = [];
  for (const e of census.entries || []) {
    const g = ((e.advert && e.advert.guardianOf) || []).find((x) => toHex(x.federationId) === fid);
    if (!g) continue;
    out.push({ peerKey: g.guardianKey, nodePubkey: e.pubkey, operatorId: (e.advert && e.advert.operatorId) || '', bondTxid: e.txid, bondVout: e.vout,
      endpoint: (e.advert && e.advert.guardianEndpoint) || '', bondSats: e.bondSats, advertEndpoint: (e.advert && e.advert.endpoint) || '' });
  }
  return out;
}

/** The federations a census knows: every federation some census node guards. */
export function federationsOf(census) {
  const ids = new Map();
  for (const e of census.entries || []) for (const g of (e.advert && e.advert.guardianOf) || []) ids.set(toHex(g.federationId), g.federationId);
  return [...ids.values()];
}

/** The leave statement a node signs beside its record signature: (record id || 0x01 leaving | 0x00 staying). */
const leaveMessage = (id, leaving) => Uint8Array.from([...id, leaving ? 1 : 0]);

// `successorOf(fidHex)`: the successor this seat was told of (hex) or null; `closedOf(fidHex)`: whether the drain is over
// (§23A.6 steps 2 and 4, kanban #325) - both read into the body every guardian seat builds the same way
export function federationRecords({ round, roster, inviteFor, networkId, leavingAtMs = () => null, fetcher = fetch, nowMs = () => Date.now(), newest = null,
  successorOf = () => null, closedOf = () => false, reserveOf = null, absences = null, abandonBlocks = null, departureNotice = null }) {
  const kept = new Map();                    // federation id hex -> { bytes, record, status, height, signers, atMs }
  const draining = new Map();                // federation id hex -> status name
  // THE HALT A LIQUIDATION COUNTS FROM (§23A.5, kanban #323): the lowest-height signed HALTED record of the run of HALTED records
  // this seat holds - kept with its bytes, so anyone checks it - and forgotten once a newer record is not HALTED (a recovery)
  const halted = new Map();                  // federation id hex -> { height, bytes }
  function keep(fid, bytes, v) {
    const had = kept.get(fid);
    if (had && had.height > v.record.height) return;
    kept.set(fid, { bytes, record: v.record, status: v.status, height: v.record.height, signers: v.signers, atMs: nowMs() });
    if (['DRAINING', 'CRITICAL', 'CLOSED', 'HALTED'].includes(v.status)) draining.set(fid, v.status); else draining.delete(fid);
    if (v.status !== 'HALTED') halted.delete(fid);
    else if (!halted.has(fid) || halted.get(fid).height > v.record.height) halted.set(fid, { height: v.record.height, bytes });
  }

  // ROUNDS BY CENSUS HEIGHT, each read once (kanban #321, measured on testnet4 2026-10-12: a seat holds thousands of rounds,
  // and reading them all at every ask held the loop 3-6 s per GET /federation-record) - AND NEWEST FIRST, only as far as a basis
  // is found (kanban #355, measured 2026-10-14: the first GET /federation-record after a start read and decoded all 86,607 stored
  // rounds, 66 MB of contracts, holding the seat's loop 4.9-9.7 s; the census it wants is a recent round's, among the newest rows)
  const byHeight = new Map();                // census height -> [{ rid, contract }]
  const CHUNK = 500, MAX_CHUNKS = 4;
  let highRow = null, lowRow = null, exhausted = false;
  const keepRow = (r) => {
    let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { return; }
    if (!byHeight.has(c.censusHeight)) byHeight.set(c.censusHeight, []);
    const at = byHeight.get(c.censusHeight);
    if (at.length < 4) at.push({ rid: new Uint8Array(r.round_id), contract: c });
  };
  /** The rows stored since the last read (none on the first: that starts at the top and reads down, `older`). */
  const newer = () => {
    if (highRow === null) {
      const top = round.db.prepare('SELECT max(rowid) AS m FROM rounds').get();
      highRow = top && top.m !== null ? Number(top.m) : 0; lowRow = highRow + 1;
      return;
    }
    for (const r of round.db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(highRow)) { highRow = r.rowid; keepRow(r); }
  };
  /** The next CHUNK rows below the lowest read so far, newest first. */
  const older = () => {
    if (exhausted) return;
    const rows = round.db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid < ? ORDER BY rowid DESC LIMIT ?').all(lowRow, CHUNK);
    for (const r of rows) { lowRow = r.rowid; keepRow(r); }
    if (rows.length < CHUNK) exhausted = true;
  };
  /**
   * THE CENSUS A RECORD IS BUILT FROM, and its height. Without `atHeight`: the newest held round whose census this seat can
   * read. With it (a gathering seat names its height, kanban #321): a held round at exactly that census height - so every
   * guardian seat builds the gatherer's body, never one of its own. Measured live before: seats 2-7 of testnet4 each took
   * their own newest round, a round posted ahead whose census they could not read yet ("this node has no chain view for
   * that round"), and no record ever had more than 1 signature of the 5 it needs.
   */
  function basis(atHeight = null) {
    if (newest) {
      const best = newest();
      if (!best) return { ok: false, why: 'this seat holds no round, so it reads no census' };
      if (atHeight !== null && best.contract.censusHeight !== atHeight) return { ok: false, why: `this seat holds no round with census height ${atHeight}` };
      const census = roster.censusFor(best.rid);
      return census.ok ? { ok: true, census, height: best.contract.censusHeight, networkId: best.contract.networkId } : census;
    }
    newer();
    if (!byHeight.size) older();
    const tried = new Set();
    let why = null, chunks = 0;
    for (;;) {
      const heights = atHeight !== null ? (byHeight.has(atHeight) ? [atHeight] : []) : [...byHeight.keys()].sort((a, b) => b - a).slice(0, 64);
      for (const h of heights) {
        if (tried.has(h)) continue;
        tried.add(h);
        for (const x of byHeight.get(h) || []) {
          const census = roster.censusFor(x.rid);
          // A CENSUS THAT HOLDS NO NODE IS NO BASIS (kanban #348, the owner's playtest 2026-10-13 07:42: "No federation info"): the
          // first v2 grids carried an empty census (fixed in e8f039d8), and as the highest census height they hid every record
          if (census.ok && (census.entries || []).length) return { ok: true, census, height: h, networkId: x.contract.networkId };
          why = census.ok ? `the census at height ${h} holds no node` : census.why;
          // A SEAT STILL READING ITS CHAIN (measured 2026-10-14 12:32Z, the first call 37 s after a start: every census answered
          // "still reading", and reading older rows for one held the loop 4.6 s to a 404) - older rows cannot help: said at once
          if (!census.ok && /still reading its chain view/.test(String(census.why))) return { ok: false, why: census.why };
        }
      }
      // older rows only while nothing read so far gives a basis - at most MAX_CHUNKS a call, and not past 64 heights tried
      if (exhausted || chunks >= MAX_CHUNKS || (atHeight === null && tried.size >= 64)) break;
      older(); chunks++;
    }
    if (atHeight !== null) return { ok: false, why: why ? `census height ${atHeight}: ${why}` : `this seat holds no round with census height ${atHeight}` };
    return { ok: false, why: why || 'this seat holds no round, so it reads no census' };
  }

  /** The body for one federation from a basis, with `gone` - the guardians whose nodes said they are leaving. */
  function bodyFor(b, federationId, gone = [], reserveSats = 0n) {
    const fid = toHex(federationId);
    const invite = inviteFor(fid);
    if (!invite) return { ok: false, why: 'this seat names no invite for that federation' };
    const guardians = guardiansOf(b.census, federationId);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const succ = successorOf(fid);
    const r = buildFederationRecord({ federationId, networkId: b.networkId || networkId, invite, nominal: guardians.length, guardians, gone, height: b.height, reserveSats,
      ...(succ ? { successorId: fromHex(succ), closed: !!closedOf(fid) } : {}) });
    return { ok: true, record: r, guardians };
  }

  /** THIS SEAT'S SIGNATURE (GET /federation-record): only a guardian of the federation signs, over the body it builds. */
  // THE RESERVE IN THE BODY (§23A.3, kanban #324): the gatherer reads it from the guardians (`reserveOf`, a threshold of them
  // naming one sum) and names it; a seat signs a body naming a reserve only when its own reading is the same
  async function reserveFor(federationIdHex, guardians, named = null) {
    if (!reserveOf) return named === null || BigInt(named) === 0n ? { ok: true, reserveSats: 0n } : { ok: false, why: 'this seat reads no reserve, so it signs none' };
    const r = await reserveOf(federationIdHex, guardians);
    if (!r.ok) return { ok: false, why: `the reserve: ${r.why}` };
    if (named !== null && r.reserveSats !== BigInt(named)) return { ok: false, why: `this seat reads a reserve of ${r.reserveSats} sat, not ${named}` };
    return { ok: true, reserveSats: r.reserveSats };
  }
  async function mySignature(federationIdHex, atHeight = null, reserveNamed = null) {
    const b = basis(atHeight);
    if (!b.ok) return b;
    const first = bodyFor(b, fromHex(federationIdHex));
    if (!first.ok) return first;
    const res = await reserveFor(federationIdHex, first.guardians, reserveNamed);
    if (!res.ok) return res;
    const built = bodyFor(b, fromHex(federationIdHex), [], res.reserveSats);
    if (!built.guardians.some((g) => toHex(g.nodePubkey) === toHex(round.pubkey))) return { ok: false, why: 'this node does not guard that federation' };
    const leaving = leavingAtMs() !== null;
    const id = federationRecordId(built.record);
    return { ok: true, height: b.height, nodePubkey: toHex(round.pubkey), body: toHex(encodeFederationRecord(built.record)),
      signature: toHex(schnorr.sign(id, round.identity.secret)), leaving, leaveSig: toHex(schnorr.sign(leaveMessage(id, leaving), round.identity.secret)) };
  }

  /** GATHER: every guardian's signature for the federation; the gone are the ones whose own signed word says leaving. */
  async function gather(federationId, inviteFederationId) {
    const b = basis();
    if (!b.ok) return b;
    const first = bodyFor(b, federationId);
    if (!first.ok) return first;
    // THE RESERVE, read once here and named to every guardian seat, each of which signs only on its own same reading
    const res = await reserveFor(toHex(federationId), first.guardians);
    if (!res.ok) return res;
    const reserveSats = res.reserveSats;
    const plain = bodyFor(b, federationId, [], reserveSats);
    const asked = await Promise.all(plain.guardians.map(async (g) => {
      const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
      if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: await mySignature(toHex(federationId), null, reserveSats) };
      try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&reserve=${reserveSats}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
      catch { return { g, said: null }; }
    }));
    // WHO SAYS IT IS LEAVING, each by its own key over the plain body's id
    const plainId = federationRecordId(plain.record);
    const gone = [];
    for (const { g, said } of asked) {
      if (!said || !said.ok || !said.leaving) continue;
      let good = false; try { good = schnorr.verify(fromHex(said.leaveSig), leaveMessage(plainId, true), g.nodePubkey); } catch { good = false; }
      if (good) gone.push({ peerKey: g.peerKey, sinceHeight: b.height, kind: GONE.DEPARTED, proofRef: plainId });
    }
    // WHO IS PROVEN ABANDONED (§23A.4, kanban #322): 2f + 1 guardians' absence attestations this seat holds, for at least
    // abandon_blocks - gone ABANDONED since the proof's height, under the proof's id; the attestations go along on the second
    // ask, so every guardian seat checks exactly that set
    // AND WHO GAVE NOTICE (§23A.5): a standing departure notice due at this height - DEPARTED from its leave_after, under its id
    // BOTH HELD for one guardian (FEDERATION.md rehearsal 14, kanban #326): "a departure that stops serving before its leave_after"
    // is abandonment (§23A.5) - the proof wins when the absence it attests began before the notice's leave_after
    const departed = [];
    const absent = [];
    if (absences) for (const g of plain.guardians) {
      if (gone.some((x) => toHex(x.peerKey) === toHex(g.peerKey))) continue;
      const d = Number.isInteger(departureNotice) ? absences.departureFor(plain.record, g.peerKey, departureNotice, b.height) : { ok: false };
      const p = Number.isInteger(abandonBlocks) ? absences.proofFor(plain.record, g.peerKey, abandonBlocks) : { ok: false };
      if (p.ok && (!d.ok || p.sinceHeight < d.sinceHeight)) { gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: GONE.ABANDONED, proofRef: p.id }); absent.push(...p.attestations); }
      else if (d.ok) { gone.push({ peerKey: g.peerKey, sinceHeight: d.sinceHeight, kind: GONE.DEPARTED, proofRef: d.id }); departed.push(d.notice); }
    }
    // THE BODY WITH THEM GONE, and the signatures over exactly it: a guardian's signature counts for the body it signed,
    // so with anyone gone every seat signs again - the leave statements move the body, and the seat asks once more
    const final = gone.length ? bodyFor(b, federationId, gone, reserveSats) : plain;
    const finalBytes = encodeFederationRecord(final.record);
    const id = federationRecordId(final.record);
    let answers = asked;
    if (gone.length) {
      answers = await Promise.all(plain.guardians.map(async (g) => {
        if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: signBody(final.record) };
        const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
        try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&reserve=${reserveSats}&gone=${gone.map((x) => toHex(x.peerKey)).join(',')}${absent.length ? `&absent=${absent.map(absenceHex).join(',')}` : ''}${departed.length ? `&departed=${departed.map(departureHex).join(',')}` : ''}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
        catch { return { g, said: null }; }
      }));
    }
    const signatures = [];
    for (const { g, said } of answers) {
      if (!said || !said.ok || said.body !== toHex(finalBytes)) continue;
      let good = false; try { good = schnorr.verify(fromHex(said.signature), id, g.nodePubkey); } catch { good = false; }
      if (good) signatures.push({ nodePubkey: g.nodePubkey, signature: fromHex(said.signature) });
    }
    const signed = joinSignedRecord(finalBytes, signatures);
    const v = verifyFederationRecord(signed, { census: b.census.entries, verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, inviteFederationId });
    if (!v.ok) return { ok: false, why: v.why, signatures: signatures.length, of: plain.guardians.length };
    keep(toHex(federationId), signed, v);
    return { ok: true, status: v.status, signers: v.signers, height: v.record.height, gone: gone.length, of: plain.guardians.length };
  }

  /** MIRROR: the newest signed record of `federationId` its guardians' nodes hold, checked against this seat's census `b`. */
  async function mirror(federationId, b, inviteFederationId) {
    const fid = toHex(federationId);
    const guardians = guardiansOf(b.census, federationId);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
    let best = null; let why = 'none of its guardians holds a record';
    await Promise.all(guardians.map(async (g) => {
      const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
      if (!base) return;
      try {
        const r = await fetcher(`${base}/federations`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const j = await r.json();
        for (const x of j.federations || []) {
          if (String(x.federation).toLowerCase() !== fid) continue;
          const v = verifyFederationRecord(fromHex(String(x.record)), { census: b.census.entries, verify, inviteFederationId });
          if (!v.ok) { why = v.why; continue; }
          if (!best || v.record.height > best.v.record.height) best = { v, bytes: fromHex(String(x.record)) };
        }
      } catch { /* the next guardian */ }
    }));
    if (!best) return { ok: false, why, mirrored: false };
    keep(fid, best.bytes, best.v);
    return { ok: true, mirrored: true, status: best.v.status, signers: best.v.signers, height: best.v.record.height };
  }

  /** A body this seat builds anyway (with the gone it was told), signed: the second ask of `gather`. */
  function signBody(record) {
    const id = federationRecordId(record);
    return { ok: true, nodePubkey: toHex(round.pubkey), body: toHex(encodeFederationRecord(record)), signature: toHex(schnorr.sign(id, round.identity.secret)) };
  }

  /** GET /federation-record with `gone` named: the same body with those peer keys gone, signed - if they are its guardians. */
  async function mySignatureWithGone(federationIdHex, goneHex, atHeight = null, reserveNamed = null, absentHex = [], departedHex = []) {
    const b = basis(atHeight);
    if (!b.ok) return b;
    const first = bodyFor(b, fromHex(federationIdHex));
    if (!first.ok) return first;
    const res = await reserveFor(federationIdHex, first.guardians, reserveNamed);
    if (!res.ok) return res;
    const plain = bodyFor(b, fromHex(federationIdHex), [], res.reserveSats);
    if (!plain.guardians.some((g) => toHex(g.nodePubkey) === toHex(round.pubkey))) return { ok: false, why: 'this node does not guard that federation' };
    const keys = new Set(plain.guardians.map((g) => toHex(g.peerKey)));
    if (!goneHex.every((k) => keys.has(k))) return { ok: false, why: 'that names a guardian this federation does not have' };
    const plainId = federationRecordId(plain.record);
    // a peer the attestations handed along are about is ABANDONED - only if they prove it to this seat, on its own record
    let absent; let notices;
    try { absent = absentHex.map(readAbsenceHex); notices = departedHex.map(readDepartureHex); } catch (e) { return { ok: false, why: e.message }; }
    const sv = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
    const gone = [];
    for (const g of plain.guardians.filter((x) => goneHex.includes(toHex(x.peerKey)))) {
      // a notice handed along for this peer: DEPARTED from its leave_after - only if it stands here and is due at this height
      if (notices.some((d) => toHex(d.peerKey) === toHex(g.peerKey))) {
        if (!Number.isInteger(departureNotice)) return { ok: false, why: 'this seat runs no departure_notice clock' };
        const d = dueDeparture(notices, { record: plain.record, peerKey: g.peerKey, departureNotice, height: b.height, verify: sv });
        if (!d.ok) return { ok: false, why: `that departure does not stand here: ${d.why}` };
        gone.push({ peerKey: g.peerKey, sinceHeight: d.sinceHeight, kind: GONE.DEPARTED, proofRef: d.id }); continue;
      }
      const about = absent.filter((a) => toHex(a.peerKey) === toHex(g.peerKey));
      if (!about.length) { gone.push({ peerKey: g.peerKey, sinceHeight: b.height, kind: GONE.DEPARTED, proofRef: plainId }); continue; }
      if (!Number.isInteger(abandonBlocks)) return { ok: false, why: 'this seat runs no abandon_blocks clock' };
      const p = abandonmentProof(about, { record: plain.record, peerKey: g.peerKey, abandonBlocks, verify: (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } } });
      if (!p.ok) return { ok: false, why: `that abandonment does not stand here: ${p.why}` };
      gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: GONE.ABANDONED, proofRef: p.id });
    }
    return signBody(bodyFor(b, fromHex(federationIdHex), gone, res.reserveSats).record);
  }

  return {
    mySignature, mySignatureWithGone, gather,
    async gatherAll(inviteFederationId) {
      const b = basis();
      if (!b.ok) return [b];
      const out = [];
      // A FEDERATION THIS SEAT HAS NO INVITE FOR IS MIRRORED, NOT SKIPPED (kanban #348, the owner 2026-10-12: "Make it happen
      // automatically so we don't have to update nodes, it needs to find federations"): its guardians' own nodes - their bond
      // adverts' endpoints in this census - are asked for its signed record, which stands only against this seat's census
      for (const fid of federationsOf(b.census)) { try { out.push({ federation: toHex(fid), ...(inviteFor(toHex(fid)) ? await gather(fid, inviteFederationId) : await mirror(fid, b, inviteFederationId)) }); } catch (e) { out.push({ federation: toHex(fid), ok: false, why: e.message }); } }
      return out;
    },
    list: () => [...kept.entries()].map(([federation, k]) => ({ federation, status: k.status, height: k.height, signers: k.signers, record: toHex(k.bytes),
      // THE LOAD (§23A.3, kanban #324): the signed record's reserve over its signed exposure cap
      ...(k.record ? { reserveSats: String(k.record.reserveSats), exposureCapSats: String(k.record.exposureCapSats),
        load: k.record.exposureCapSats > 0n ? Number((k.record.reserveSats * 10000n) / k.record.exposureCapSats) / 10000 : null } : {}),
      // the successor's guardian pool takes this drain's seated guardians (predecessorGuardians), shown with the record
      ...(k.record && k.record.successorId && k.record.successorId.some((x) => x) ? { successor: toHex(k.record.successorId) } : {}) })),
    draining: (fidHex) => draining.get(fidHex) || null,
    /** THE INVITE A FEDERATION'S SIGNED RECORD CARRIES (kanban #348): how this node joins a federation it did not found. */
    inviteOf: (fidHex) => { const k = kept.get(String(fidHex).toLowerCase()); return k && k.record && k.record.invite ? String(k.record.invite) : null; },
    /** The kept record of a federation ({ record, status, height }) and, while it is HALTED, the halt it counts from. */
    /** THE ACTIVE SEATS OF THIS SEAT'S CENSUS, by node key (halts.js, kanban #323): who may observe a halt. */
    censusKeys: () => { const b = basis(); return b.ok ? (b.census.entries || []).map((e) => e.pubkey).filter(Boolean) : []; },
    recordOf: (fidHex) => { const k = kept.get(String(fidHex).toLowerCase()); return k ? { record: k.record, status: k.status, height: k.height } : null; },
    haltOf: (fidHex) => halted.get(String(fidHex).toLowerCase()) || null,
    haltedFederations: () => [...halted.keys()],
    // THE DRAIN IS PAID (§23A.6 step 5, kanban #325): the seated guardians of every federation whose verified record says
    // DRAINING and names `fidHex` as its successor - not gone, by node key. A CLOSED predecessor names nobody. One that fell to
    // CRITICAL while draining is still drained by its seated guardians, and paid ("until its record is CLOSED"); a HALTED one
    // serves nothing
    predecessorGuardians(fidHex) {
      const out = [];
      for (const [, k] of kept) {
        if (!['DRAINING', 'CRITICAL'].includes(k.status) || !k.record || toHex(k.record.successorId) !== String(fidHex).toLowerCase()) continue;
        const gone = new Set((k.record.gone || []).map((g) => toHex(g.peerKey)));
        for (const g of k.record.guardians || []) if (!gone.has(toHex(g.peerKey))) out.push(g.nodePubkey);
      }
      return out;
    },
    FEDERATION_STATUS,
  };
}
