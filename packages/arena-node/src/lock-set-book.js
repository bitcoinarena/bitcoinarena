// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S PART IN THE CERTIFIED LOCK SET (protocol 28, kanban #2561, ruling #2116 (b); arena-protocol lock-set.js; multiplayer_p2p.md §17A).
//
// From a paying head-to-head round's entry close (by this seat's clock):
//   1. VIEW. The seat signs the entries whose stake it saw before the close (its `viewOf`), under the view tag, once.
//   2. GOSSIP. Views, set signatures and a certificate go to every peer of the round (POST /lock-set) and are pulled (GET /lock-set).
//   3. SIGN ONCE. When it holds every committee seat's view - or at the close + LOCK_SET_VIEW_WAIT_MS with a threshold of views - it signs ONE
//      set: its own view's entries that a threshold of views name (lockSetToSign). Kept in the store before it is served, and never another
//      for that round, after a restart too: two sets can then never both gather a threshold of honest signatures.
//   4. CERTIFY. A threshold of signatures over one set, each at a time inside [close, close + LOCK_SET_WINDOW_MS], is the certificate; kept.
// No reveal is taken or served here before it (server.js POST /reveal, GET /reveals), and only its entries are seated and decided
// (verify.js #headToHeadClose). None standing anywhere by the close + window: the round is VOID.
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import {
  LOCK_SET_WINDOW_MS, LOCK_SET_VIEW_WAIT_MS, LOCK_SET_MAX_ENTRIES, lockSetOf, lockSetId, lockSetSignatureId, lockSetViewId,
  encodeLockSetCertificate, lockSetCertificateStands, lockSetToSign,
} from '../../arena-protocol/src/lock-set.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
/** How often a seat pulls its peers while a round's set is open, and how long it waits for one peer. */
export const LOCK_SET_PULL_MS = 150;
export const LOCK_SET_PEER_MS = 2500;
/**
 * WHEN A LOCK OUTSIDE THE CERTIFICATE GOES BACK (kanban #2585): not before the close + LOCK_SET_WINDOW_MS + this. A seat steps a round's set until
 * the close + the window + 2 s and pushes a certificate to every peer the moment it holds one, so by then any other certificate of the round
 * that stands has reached this seat (and one pull more is made before the first such return).
 */
export const LOCK_SET_RETURN_AFTER_MS = 2000 + LOCK_SET_PEER_MS;
/**
 * WHEN A ROUND'S SET IS FINAL HERE (kanban #2588): the close + LOCK_SET_WINDOW_MS + this - the gossip a seat steps a round's set for. A set
 * signature's time is its signer's own word, so a signature dated inside the window can be made at any time: taken later, one dishonest seat
 * certified a round every seat had answered VOID (the honest player's page stops there and never reveals - he FORFEITS). From then on no
 * signature or certificate is taken while none is held, and VOID is said only from then (before it the set is pending): VOID is never taken back.
 */
export const LOCK_SET_FINAL_AFTER_MS = 2000;
const lsVerify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

export class LockSetBook {
  /**
   * `round` the store (identity, signerNodes, now, db); `peersOf(rid)` the round's other seats' base URLs; `roundOf(rid)` the round's decoded
   * contract when it plays under the certified lock set (certifiesLockSet), else null; `viewOf(rid, contract)` the entry ids (hex) whose stake
   * this seat saw before the close. `fetchFn` for tests.
   */
  constructor({ round, peersOf, roundOf, viewOf, fetchFn = (u, o) => fetch(u, o), log = () => {} }) {
    this.round = round; this.peersOf = peersOf; this.roundOf = roundOf; this.viewOf = viewOf; this.fetch = fetchFn; this.log = log;
    /** rid hex -> { views: Map(key -> view), sigs: Map(key -> sig), cert, pulledAt, pulling, pushed: Set } (what this seat heard; memory) */
    this.rooms = new Map();
    /** Test hooks: a seat that answers its peers this much later, or not at all (`silent`). */
    this.answerDelayMs = 0;
    this.db = round.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS lock_set_signed (round_id BLOB PRIMARY KEY, entries TEXT NOT NULL, at_ms INTEGER NOT NULL, sig BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS lock_set_certs (round_id BLOB PRIMARY KEY, cert BLOB NOT NULL, at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lock_set_conflicts (round_id BLOB PRIMARY KEY, cert BLOB NOT NULL, at_ms INTEGER NOT NULL)`);
    /** rid hex -> the one pull made before a lock outside the certificate is first returned (kanban #2585) */
    this.returnPulls = new Map();
  }

  #room(ridHex) {
    let r = this.rooms.get(ridHex);
    if (!r) {
      r = { views: new Map(), sigs: new Map(), cert: null, pulledAt: new Map(), pulling: new Map(), pushed: new Set(), answeredAt: new Map() };
      this.rooms.set(ridHex, r);
      if (this.rooms.size > 512) this.rooms.delete(this.rooms.keys().next().value);
    }
    return r;
  }

  #committee(rid) { return this.round.signerNodes(rid).map(toHex); }
  #threshold(committee) { try { return receiptsNeeded(committee.length); } catch { return Math.floor(committee.length / 2) + 1; } }
  #now() { return Math.floor(Number(this.round.now())); }

  /** The certificate this seat holds for the round: { ok, entries (hex), atMs, bytes } or null. */
  certified(rid) {
    const ridHex = toHex(rid);
    const room = this.rooms.get(ridHex);
    if (room && room.cert) return room.cert;
    const row = this.db.prepare('SELECT cert, at_ms FROM lock_set_certs WHERE round_id = ?').get(rid);
    if (!row) return null;
    const c = this.roundOf(rid);
    if (!c) return null;
    const committee = this.#committee(rid);
    const got = lockSetCertificateStands(new Uint8Array(row.cert), { roundId: rid, committee, threshold: this.#threshold(committee), entryCloseMs: c.entryCloseMs, verify: lsVerify });
    if (!got.ok) return null;
    const cert = { ...got, bytes: new Uint8Array(row.cert) };
    this.#room(ridHex).cert = cert;
    return cert;
  }

  /** Is the round VOID for want of a certificate? Only once the window is past and no certificate is held here. */
  voidNow(rid, c = this.roundOf(rid)) {
    if (!c) return false;
    return !this.certified(rid) && this.#now() > Number(c.entryCloseMs) + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS;
  }

  #signed(rid) {
    const row = this.db.prepare('SELECT entries, at_ms, sig FROM lock_set_signed WHERE round_id = ?').get(rid);
    return row ? { key: toHex(this.round.pubkey), atMs: Number(row.at_ms), entries: JSON.parse(row.entries), sig: toHex(new Uint8Array(row.sig)) } : null;
  }

  /** GET /lock-set's answer. */
  state(rid) {
    const c = this.roundOf(rid);
    if (!c) return { round: toHex(rid), required: false };
    const room = this.#room(toHex(rid));
    const cert = this.certified(rid);
    const own = this.#signed(rid);
    if (own) room.sigs.set(own.key, own);
    return {
      round: toHex(rid), required: true, closeMs: Number(c.entryCloseMs), windowMs: LOCK_SET_WINDOW_MS,
      views: [...room.views.values()], signatures: [...room.sigs.values()],
      certificate: cert ? toHex(cert.bytes) : null, entries: cert ? cert.entries : null, certifiedAtMs: cert ? cert.atMs : null,
      void: this.voidNow(rid, c),
    };
  }

  /** A peer's (or a player's) view, signature or certificate: each taken only if it verifies against the round's committee. */
  take(rid, body) {
    const c = this.roundOf(rid);
    if (!c) return { ok: false, status: 409, why: 'that round does not play under the certified lock set (a paying head-to-head round of protocol 28)' };
    const committee = this.#committee(rid), members = new Set(committee), threshold = this.#threshold(committee);
    const close = Number(c.entryCloseMs), room = this.#room(toHex(rid));
    const got = { views: 0, signatures: 0, certificate: false };
    // THE SET IS FINAL (kanban #2588): nothing taken past the gossip while no certificate is held - only a second one over another set (#2585)
    if (this.#now() > close + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS && !this.certified(rid)) return { ok: true, ...got, final: true };
    const read = (x, idOf) => {
      if (!x || !HEX64.test(String(x.key)) || !members.has(String(x.key)) || !HEX128.test(String(x.sig))) return null;
      const atMs = Number(x.atMs);
      if (!Number.isSafeInteger(atMs) || atMs < close || atMs > close + LOCK_SET_WINDOW_MS) return null;
      if (!Array.isArray(x.entries) || x.entries.length > LOCK_SET_MAX_ENTRIES || !x.entries.every((e) => HEX64.test(String(e)))) return null;
      let set;
      try { set = lockSetOf({ roundId: rid, entries: x.entries }); } catch { return null; }
      const setId = lockSetId(set);
      if (!lsVerify(fromHex(x.sig), idOf({ setId, atMs }), fromHex(x.key))) return null;
      return { key: String(x.key), atMs, entries: set.entries.map(toHex), sig: String(x.sig), setId: toHex(setId) };
    };
    for (const v of (Array.isArray(body && body.views) ? body.views : []).slice(0, committee.length)) {
      if (room.views.has(String(v && v.key))) continue;
      const ok = read(v, lockSetViewId);
      if (ok) { room.views.set(ok.key, ok); got.views++; }
    }
    for (const s of (Array.isArray(body && body.signatures) ? body.signatures : []).slice(0, committee.length)) {
      if (room.sigs.has(String(s && s.key))) continue;   // one set signature a seat; a second (an equivocation) is never counted
      const ok = read(s, lockSetSignatureId);
      if (ok) { room.sigs.set(ok.key, ok); got.signatures++; }
    }
    if (body && typeof body.certificate === 'string' && /^[0-9a-f]+$/.test(body.certificate) && body.certificate.length <= 2 * 32768) {
      const held = this.certified(rid);
      let bytes = null; try { bytes = fromHex(body.certificate); } catch { bytes = null; }
      const st = bytes && !(held && toHex(held.bytes) === body.certificate)
        ? lockSetCertificateStands(bytes, { roundId: rid, committee, threshold, entryCloseMs: c.entryCloseMs, verify: lsVerify }) : { ok: false };
      if (st.ok && !held) { this.#keep(rid, { ...st, bytes }); got.certificate = true; }
      // A SECOND CERTIFICATE OVER ANOTHER SET (kanban #2585): kept as the round's conflict - see conflicted()
      else if (st.ok && st.setId !== held.setId) this.#conflict(rid, bytes);
    }
    const before = this.certified(rid), wasConflicted = this.conflicted(rid);
    this.#assemble(rid, c, committee, threshold);
    // A CERTIFICATE OR CONFLICT MADE HERE TRAVELS (feedback #035): step() returns at once once certified, so one assembled in take() was
    // never pushed and the conflict reached the other side only by a pull
    if ((!before && this.certified(rid)) || (!wasConflicted && this.conflicted(rid))) { try { this.#push(rid, this.peersOf(rid) || [], this.#room(toHex(rid))); } catch { /* best effort */ } }
    return { ok: true, ...got };
  }

  #keep(rid, cert) {
    this.db.prepare('INSERT OR IGNORE INTO lock_set_certs (round_id, cert, at_ms) VALUES (?, ?, ?)').run(rid, cert.bytes, cert.atMs);
    this.#room(toHex(rid)).cert = cert;
    this.log(`[lock-set] ${toHex(rid).slice(0, 16)}: certified ${cert.entries.length} entr${cert.entries.length === 1 ? 'y' : 'ies'} at close + ${cert.atMs - Number(this.roundOf(rid).entryCloseMs)} ms`);
  }

  /** A threshold of signatures over one set: the certificate (the earliest threshold of them, so its time is the earliest it could be). */
  #assemble(rid, c, committee, threshold) {
    const held = this.certified(rid);
    if (held && this.conflicted(rid)) return;
    const room = this.#room(toHex(rid));
    const bySet = new Map();
    for (const s of room.sigs.values()) { const l = bySet.get(s.setId) || []; l.push(s); bySet.set(s.setId, l); }
    for (const list of bySet.values()) {
      if (list.length < threshold || (held && list[0].setId === held.setId)) continue;
      const use = [...list].sort((a, b) => a.atMs - b.atMs).slice(0, threshold).sort((a, b) => (a.key < b.key ? -1 : 1));
      const set = lockSetOf({ roundId: rid, entries: use[0].entries });
      const bytes = encodeLockSetCertificate({ set, sigs: use.map((s) => ({ key: fromHex(s.key), atMs: BigInt(s.atMs), sig: fromHex(s.sig) })) });
      const st = lockSetCertificateStands(bytes, { roundId: rid, committee, threshold, entryCloseMs: c.entryCloseMs, verify: lsVerify });
      if (st.ok) { if (held) this.#conflict(rid, bytes); else this.#keep(rid, { ...st, bytes }); return; }
    }
  }

  /**
   * TWO CERTIFICATES OVER TWO SETS (kanban #2585). An honest seat signs one set, but honest seats sign different sets when their views differ (an
   * entry whose stake only some of them saw), and a committee of 2t - 1 (the draw: 9 for 7 slots, 3 for 2) has two thresholds overlapping in ONE
   * seat: one dishonest seat signing both sets makes two certificates, each held by the seats that signed it. A lock in one and not the other is
   * then claimed by the one side's settlement and was returned at once by the other's forfeit. Kept here once; the round's set is contested.
   */
  #conflict(rid, bytes) {
    this.db.prepare('INSERT OR IGNORE INTO lock_set_conflicts (round_id, cert, at_ms) VALUES (?, ?, ?)').run(rid, bytes, this.#now());
    this.log(`[lock-set] ${toHex(rid).slice(0, 16)}: a second certificate over another set - the round's set is contested (kanban #2585)`);
  }

  /** Whether a second standing certificate over another set of this round reached this seat (kanban #2585). */
  conflicted(rid) { return !!this.db.prepare('SELECT 1 FROM lock_set_conflicts WHERE round_id = ?').get(rid); }

  /**
   * WHY A LOCK OF THE ROUND GOES BACK AT ONCE (kanban #2561, the forfeit's lockSetOut), or null: outside the certified set, or every lock once the
   * round is VOID for want of a certificate (none held here past the close + the window, and none pulled from the peers now - the decide's own
   * rule, verify.js #headToHeadClose). OUTSIDE THE SET ONLY ONCE THE SET CANNOT BE CONTESTED (kanban #2585): after the close + the window +
   * LOCK_SET_RETURN_AFTER_MS and one more pull of the peers, and never while a second certificate over another set is held - the lock then waits
   * for its round (or its expiry), as a certified one does.
   */
  async lockOut(rid, entryIdHex) {
    const c = this.roundOf(rid);
    if (!c) return null;
    let cert = this.certified(rid);
    if (!cert && this.voidNow(rid, c)) cert = await this.settle(rid);
    if (!cert) return this.voidNow(rid, c) ? 'that round has no certified lock set and its window has closed: it is VOID, every lock goes back at once (kanban #2561)' : null;
    if (cert.entries.includes(String(entryIdHex).toLowerCase())) return null;
    if (this.#now() <= Number(c.entryCloseMs) + LOCK_SET_WINDOW_MS + LOCK_SET_RETURN_AFTER_MS) return null;
    // NOT ON ONE MISSED PULL (feedback #035): the pull before a return was made once per round and its misses swallowed, so a peer that
    // held the contesting certificate and missed that one GET let the lock go back for good. Now the peers that have not answered since
    // the window closed (+ 2 s of gossip) are asked again on each call (one pull per peer in flight), and the lock goes back only
    // once every peer answered (feedback #036: not n - t - the overlap seat may be the one that signed both sets).
    const room = this.#room(toHex(rid)), since = Number(c.entryCloseMs) + LOCK_SET_WINDOW_MS + 2000;
    const peers = this.peersOf(rid) || [];
    const fresh = (p) => (room.answeredAt.get(String(p)) || 0) >= since;
    await Promise.all(peers.filter((p) => !fresh(p)).map((p) => this.#pullOne(rid, p, room).catch(() => {})));   // one pull per peer at a time (#pullOne)
    if (this.conflicted(rid)) return null;
    // EVERY PEER, NOT n - t (feedback #036): in a draw of 2t - 1 the seat in the overlap of two thresholds is the one that can sign two
    // sets - the attacker's - so its answer met an n - t quorum by itself while the honest seat holding the other certificate stayed
    // unheard. A lock outside the set goes back only once every committee peer answered since the close + the window + 2 s; while one
    // is unheard it waits for its round (or its expiry), as a contested one does.
    if (peers.some((p) => !fresh(p))) return null;
    return 'that lock is not in the round\'s certified lock set: it is not in the round and goes back at once (kanban #2561)';
  }

  /** This seat's own view, made once from the close on. */
  #ownView(rid, c, room) {
    const me = toHex(this.round.pubkey);
    if (room.views.has(me)) return room.views.get(me);
    const now = this.#now(), close = Number(c.entryCloseMs);
    if (now < close || now > close + LOCK_SET_WINDOW_MS) return null;
    const set = lockSetOf({ roundId: rid, entries: this.viewOf(rid, c) });
    const setId = lockSetId(set);
    const v = { key: me, atMs: now, entries: set.entries.map(toHex), sig: toHex(schnorr.sign(lockSetViewId({ setId, atMs: now }), this.round.identity.secret)), setId: toHex(setId) };
    room.views.set(me, v);
    return v;
  }

  /** Sign the one set, if it is time: every view held, or the view wait passed with a threshold of them. */
  #signOnce(rid, c, committee, threshold, room) {
    const me = toHex(this.round.pubkey);
    const held = this.#signed(rid);
    if (held) { if (!room.sigs.has(me)) room.sigs.set(me, { ...held, setId: toHex(lockSetId(lockSetOf({ roundId: rid, entries: held.entries }))) }); return; }
    if (!committee.includes(me)) return;
    const now = this.#now(), close = Number(c.entryCloseMs);
    if (now < close || now > close + LOCK_SET_WINDOW_MS) return;
    const own = room.views.get(me);
    if (!own) return;
    const views = [...room.views.values()].filter((v) => committee.includes(v.key));
    if (views.length < threshold) return;
    if (views.length < committee.length && now < close + LOCK_SET_VIEW_WAIT_MS) return;
    const entries = lockSetToSign({ own: own.entries, views: views.map((v) => v.entries), threshold });
    const set = lockSetOf({ roundId: rid, entries });
    const setId = lockSetId(set);
    const sig = schnorr.sign(lockSetSignatureId({ setId, atMs: now }), this.round.identity.secret);
    // KEPT BEFORE IT IS SERVED, AND ONLY ONCE (INSERT OR IGNORE): a restart never signs a second set for the round
    const w = this.db.prepare('INSERT OR IGNORE INTO lock_set_signed (round_id, entries, at_ms, sig) VALUES (?, ?, ?, ?)').run(rid, JSON.stringify(set.entries.map(toHex)), now, sig);
    const mine = w.changes ? { key: me, atMs: now, entries: set.entries.map(toHex), sig: toHex(sig), setId: toHex(setId) } : { ...this.#signed(rid), setId: null };
    if (mine.setId === null) mine.setId = toHex(lockSetId(lockSetOf({ roundId: rid, entries: mine.entries })));
    room.sigs.set(me, mine);
    this.log(`[lock-set] ${toHex(rid).slice(0, 16)}: signed ${entries.length} of ${own.entries.length} verified entr${own.entries.length === 1 ? 'y' : 'ies'} at close + ${now - close} ms (${views.length} views)`);
  }

  /** What this seat says to a peer: its own view and signature, and the certificate if held. */
  #say(rid) {
    const me = toHex(this.round.pubkey), room = this.#room(toHex(rid));
    const cert = this.certified(rid);
    return { views: room.views.has(me) ? [room.views.get(me)] : [], signatures: room.sigs.has(me) ? [room.sigs.get(me)] : [], ...(cert ? { certificate: toHex(cert.bytes) } : {}) };
  }

  /** Push what is new to each peer (fire and forget) - one push per (peer, what). */
  #push(rid, peers, room) {
    const said = this.#say(rid);
    const tag = `${said.views.length}:${said.signatures.length}:${said.certificate ? 1 : 0}`;
    for (const p of peers) {
      const k = `${p}|${tag}`;
      if (room.pushed.has(k)) continue;
      room.pushed.add(k);
      this.fetch(`${String(p).replace(/\/+$/, '')}/lock-set?round=${toHex(rid)}`, { method: 'POST', body: JSON.stringify(said), signal: AbortSignal.timeout(LOCK_SET_PEER_MS) })
        .then((r) => r.body && r.body.cancel && r.body.cancel()).catch(() => {});
    }
  }

  /** Pull one peer (under LOCK_SET_PEER_MS): each peer on its own, so a slow one holds back no other. */
  async #pullOne(rid, p, room) {
    const k = String(p);
    if (room.pulling.has(k)) return room.pulling.get(k);
    const go = (async () => {
      try {
        const r = await this.fetch(`${k.replace(/\/+$/, '')}/lock-set?round=${toHex(rid)}`, { signal: AbortSignal.timeout(LOCK_SET_PEER_MS) });
        if (!r.ok) { try { await r.body?.cancel(); } catch { /* gone */ } return; }
        const text = await r.text();
        if (text.length > 262144) return;
        this.take(rid, JSON.parse(text));
        room.answeredAt.set(k, this.#now());   // feedback #035: this peer answered (its certificate, if any, is taken)
      } catch { /* a peer that is down or slow says nothing */ }
    })().finally(() => { room.pulling.delete(k); room.pulledAt.set(k, Date.now()); });
    room.pulling.set(k, go);
    return go;
  }

  /** Pull every peer once, in parallel. */
  async pull(rid) {
    const room = this.#room(toHex(rid));
    await Promise.all((this.peersOf(rid) || []).map((p) => this.#pullOne(rid, p, room)));
  }

  /** One pass over a round: view, sign, assemble, gossip. Cheap when there is nothing to do. */
  async step(rid) {
    const c = this.roundOf(rid);
    if (!c) return null;
    const now = this.#now(), close = Number(c.entryCloseMs);
    if (now < close || this.certified(rid)) return this.certified(rid);
    if (now > close + LOCK_SET_WINDOW_MS + 2000) return null;   // past the window: nothing more forms (a late pull still may find a certificate)
    const committee = this.#committee(rid), threshold = this.#threshold(committee), room = this.#room(toHex(rid));
    const peers = this.peersOf(rid) || [];
    if (committee.includes(toHex(this.round.pubkey))) this.#ownView(rid, c, room);
    this.#signOnce(rid, c, committee, threshold, room);
    this.#assemble(rid, c, committee, threshold);
    this.#push(rid, peers, room);
    for (const p of peers) {
      if (room.pulling.has(String(p)) || Date.now() - (room.pulledAt.get(String(p)) || 0) < LOCK_SET_PULL_MS) continue;
      this.#pullOne(rid, p, room).then(() => {
        this.#signOnce(rid, c, committee, threshold, room); this.#assemble(rid, c, committee, threshold); this.#push(rid, peers, room);
      }).catch(() => {});
    }
    return this.certified(rid);
  }

  /** The certificate for a decide: this seat's, else one pulled from the peers now; null when none stands anywhere it asked. */
  async settle(rid) {
    if (this.certified(rid)) return this.certified(rid);
    await this.pull(rid);
    return this.certified(rid);
  }
}
