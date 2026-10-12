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
  successorOf = () => null, closedOf = () => false }) {
  const kept = new Map();                    // federation id hex -> { bytes, record, status, height, signers, atMs }
  const draining = new Map();                // federation id hex -> status name

  // ROUNDS BY CENSUS HEIGHT, each read once (kanban #321, measured on testnet4 2026-10-12: a seat holds thousands of rounds,
  // and reading them all at every ask held the loop 3-6 s per GET /federation-record)
  const byHeight = new Map();                // census height -> [{ rid, contract }]
  let lastRow = 0;
  const indexRounds = () => {
    for (const r of round.db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(lastRow)) {
      lastRow = r.rowid;
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (!byHeight.has(c.censusHeight)) byHeight.set(c.censusHeight, []);
      const at = byHeight.get(c.censusHeight);
      if (at.length < 4) at.push({ rid: new Uint8Array(r.round_id), contract: c });
    }
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
    indexRounds();
    const heights = atHeight !== null ? [atHeight] : [...byHeight.keys()].sort((a, b) => b - a);
    let why = null;
    for (const h of heights.slice(0, 64)) {
      for (const x of byHeight.get(h) || []) {
        const census = roster.censusFor(x.rid);
        if (census.ok) return { ok: true, census, height: h, networkId: x.contract.networkId };
        why = census.why;
      }
    }
    if (atHeight !== null) return { ok: false, why: why ? `census height ${atHeight}: ${why}` : `this seat holds no round with census height ${atHeight}` };
    return { ok: false, why: why || 'this seat holds no round, so it reads no census' };
  }

  /** The body for one federation from a basis, with `gone` - the guardians whose nodes said they are leaving. */
  function bodyFor(b, federationId, gone = []) {
    const fid = toHex(federationId);
    const invite = inviteFor(fid);
    if (!invite) return { ok: false, why: 'this seat names no invite for that federation' };
    const guardians = guardiansOf(b.census, federationId);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const succ = successorOf(fid);
    const r = buildFederationRecord({ federationId, networkId: b.networkId || networkId, invite, nominal: guardians.length, guardians, gone, height: b.height,
      ...(succ ? { successorId: fromHex(succ), closed: !!closedOf(fid) } : {}) });
    return { ok: true, record: r, guardians };
  }

  /** THIS SEAT'S SIGNATURE (GET /federation-record): only a guardian of the federation signs, over the body it builds. */
  function mySignature(federationIdHex, atHeight = null) {
    const b = basis(atHeight);
    if (!b.ok) return b;
    const built = bodyFor(b, fromHex(federationIdHex));
    if (!built.ok) return built;
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
    const plain = bodyFor(b, federationId);
    if (!plain.ok) return plain;
    const asked = await Promise.all(plain.guardians.map(async (g) => {
      const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
      if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: mySignature(toHex(federationId)) };
      try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
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
    // THE BODY WITH THEM GONE, and the signatures over exactly it: a guardian's signature counts for the body it signed,
    // so with anyone gone every seat signs again - the leave statements move the body, and the seat asks once more
    const final = gone.length ? bodyFor(b, federationId, gone) : plain;
    const finalBytes = encodeFederationRecord(final.record);
    const id = federationRecordId(final.record);
    let answers = asked;
    if (gone.length) {
      answers = await Promise.all(plain.guardians.map(async (g) => {
        if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: signBody(final.record) };
        const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
        try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&gone=${gone.map((x) => toHex(x.peerKey)).join(',')}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
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
    const fid = toHex(federationId);
    const had = kept.get(fid);
    if (!had || had.height <= v.record.height) kept.set(fid, { bytes: signed, record: v.record, status: v.status, height: v.record.height, signers: v.signers, atMs: nowMs() });
    if (['DRAINING', 'CRITICAL', 'CLOSED', 'HALTED'].includes(v.status)) draining.set(fid, v.status); else draining.delete(fid);
    return { ok: true, status: v.status, signers: v.signers, height: v.record.height, gone: gone.length, of: plain.guardians.length };
  }

  /** A body this seat builds anyway (with the gone it was told), signed: the second ask of `gather`. */
  function signBody(record) {
    const id = federationRecordId(record);
    return { ok: true, nodePubkey: toHex(round.pubkey), body: toHex(encodeFederationRecord(record)), signature: toHex(schnorr.sign(id, round.identity.secret)) };
  }

  /** GET /federation-record with `gone` named: the same body with those peer keys gone, signed - if they are its guardians. */
  function mySignatureWithGone(federationIdHex, goneHex, atHeight = null) {
    const b = basis(atHeight);
    if (!b.ok) return b;
    const plain = bodyFor(b, fromHex(federationIdHex));
    if (!plain.ok) return plain;
    if (!plain.guardians.some((g) => toHex(g.nodePubkey) === toHex(round.pubkey))) return { ok: false, why: 'this node does not guard that federation' };
    const keys = new Set(plain.guardians.map((g) => toHex(g.peerKey)));
    if (!goneHex.every((k) => keys.has(k))) return { ok: false, why: 'that names a guardian this federation does not have' };
    const plainId = federationRecordId(plain.record);
    const gone = plain.guardians.filter((g) => goneHex.includes(toHex(g.peerKey))).map((g) => ({ peerKey: g.peerKey, sinceHeight: b.height, kind: GONE.DEPARTED, proofRef: plainId }));
    return signBody(bodyFor(b, fromHex(federationIdHex), gone).record);
  }

  return {
    mySignature, mySignatureWithGone, gather,
    async gatherAll(inviteFederationId) {
      const b = basis();
      if (!b.ok) return [b];
      const out = [];
      for (const fid of federationsOf(b.census)) { try { out.push({ federation: toHex(fid), ...(await gather(fid, inviteFederationId)) }); } catch (e) { out.push({ federation: toHex(fid), ok: false, why: e.message }); } }
      return out;
    },
    list: () => [...kept.entries()].map(([federation, k]) => ({ federation, status: k.status, height: k.height, signers: k.signers, record: toHex(k.bytes),
      // the successor's guardian pool takes this drain's seated guardians (predecessorGuardians), shown with the record
      ...(k.record && k.record.successorId && k.record.successorId.some((x) => x) ? { successor: toHex(k.record.successorId) } : {}) })),
    draining: (fidHex) => draining.get(fidHex) || null,
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
