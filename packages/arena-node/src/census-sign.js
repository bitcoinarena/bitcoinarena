// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY SIGNS (spec 5A.3B, kanban #972). FROST over BIP-340, one nonce pair per node for its several shares (frost-bip340.js signNodeShare340). Two rounds, seat to seat. A holder answers the first only after its own
// `check` of the request: for a slash start, that it pays the hold output its node signed to, and that the proof holds on this holder's own replay. Whatever it answers is bound to that digest. A nonce is used once, whatever
// comes back: the session goes before anything is signed, and a restart loses it, which costs a filer one more try. Nothing here is a secret on the wire.
// THE SIGNING SET IS BOUND (kanban #1155): the x each node brings set the Lagrange coefficients, so a holder signs only for a set of real shares of the key (its own record says
// which), with its own shares exactly, and the xs go into the binding factors with the nonces: a list whose xs were changed after R is another signature, and adds up to nothing.
//
// A NONCE IS DRAWN FOR A BOUNDED NUMBER OF ASKS (kanban #1187): the door is anyone's, and a request that passes the checks once (a real started bond, public bytes) passed them every time, so each ask
// drew a nonce pair and a session that lived 10 minutes. Now a holder keeps at most `limits.perDigest` open sessions for one digest, `limits.perKey` for one key and `limits.total` in all, and checks
// at most `limits.checking` requests at once; past any of these it refuses before it draws a nonce, and past the total or the checking it refuses before the check, so no replay is spent on it either.
// A filer that gives up hands back the sessions it will not use (a share asked with no signers ends a session), so its own retries do not fill the cap.
//
//   POST /census-sign/commit   a request -> { ok, session, node, xs, hiding, binding, bind } or { ok: false, why }
//   POST /census-sign/share    { session, signers: [{ id, node, xs, hiding, binding }] } -> { ok, z }
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { decodeCensusKeyRecord } from '../../arena-protocol/src/census-key.js';
import { feldmanGroup } from './curve.js';
import { censusKeyInWorker } from './census-key-work.js';

const random = (n) => new Uint8Array(randomBytes(n));
const SESSION_MS = 600000;
/** How many signing sessions a holder keeps open, and how many requests it checks at once (kanban #1187). A filer asks each holder once per try and hands back what it does not use. */
export const SESSION_LIMITS = Object.freeze({ perDigest: 4, perKey: 32, total: 256, checking: 16 });
const scalarHex = (z) => z.toString(16).padStart(64, '0');
/**
 * The wire's commitment list as the signers hash it: by id, whatever order it came in, each node with the x of the shares it signs for. The xs are in the
 * binding factors (frost.js encodeCommitmentList, kanban #1155), so the Lagrange set is fixed with R.
 */
const commitmentsOf = (signers) => signers.map((s) => ({ id: s.id, hiding: fromHex(s.hiding), binding: fromHex(s.binding), xs: s.xs })).sort((a, b) => a.id - b.id);
/** What a holder that binds the xs says at its commit. A filer leaves out one that does not: its share would not add up with the others'. */
export const CENSUS_SIGN_BIND = 1;

/**
 * ONE SIGNING SESSION'S STATE, AND THE ONE WAY IT MOVES (kanban #1155). none -> committed (a nonce pair drawn, in memory only) -> used (gone before
 * anything is signed, whatever comes of it). Nothing moves back, and a restart is none: the nonce was never written down.
 */
export const SESSION = Object.freeze({ NONE: 'none', COMMITTED: 'committed', USED: 'used' });
const MOVES = Object.freeze({ [SESSION.NONE]: [SESSION.COMMITTED], [SESSION.COMMITTED]: [SESSION.USED], [SESSION.USED]: [] });

const isHex = (v, bytes) => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
/**
 * THE SIGNING SET A HOLDER ACCEPTS (kanban #1155): a list from the wire, read against what this holder knows of the key. Every x is an integer share
 * of the key, 1..total, brought once; this node's entry carries its own commitment and exactly the x it holds; together they reach the threshold.
 * Answers { ok, mine } or { ok: false, why }.
 */
export function signingSetOf(signers, { me, hiding, binding, held, total, threshold }) {
  if (!Array.isArray(signers) || !signers.length) return { ok: false, why: 'name the signers' };
  if (signers.length > total) return { ok: false, why: `${signers.length} signers of a key of ${total} shares` };
  const ids = new Set(), nodes = new Set(), xs = new Set();
  for (const x of signers) {
    if (!x || typeof x !== 'object') return { ok: false, why: 'a signer is an object' };
    if (!Number.isInteger(x.id) || x.id < 1 || x.id > signers.length || ids.has(x.id)) return { ok: false, why: `signer id ${x.id} is not one of 1..${signers.length}, once` };
    if (!isHex(x.node, 32) || nodes.has(x.node)) return { ok: false, why: 'a signer names a node key, once' };
    if (!isHex(x.hiding, 33) || !isHex(x.binding, 33)) return { ok: false, why: `signer ${x.id} carries no commitment` };
    if (!Array.isArray(x.xs) || !x.xs.length) return { ok: false, why: `signer ${x.id} names no shares` };
    for (const v of x.xs) {
      if (!Number.isInteger(v) || v < 1 || v > total) return { ok: false, why: `${v} is not a share of this key: they are 1..${total}` };
      if (xs.has(v)) return { ok: false, why: `the share at ${v} is named twice` };
      xs.add(v);
    }
    ids.add(x.id); nodes.add(x.node);
  }
  const mine = signers.find((x) => x.node === me);
  if (!mine || mine.hiding !== hiding || mine.binding !== binding) return { ok: false, why: 'that list does not carry this node\'s commitment' };
  if (mine.xs.length !== held.size || mine.xs.some((v) => !held.has(v))) return { ok: false, why: 'that list names other shares for this node than it holds' };
  if (xs.size < threshold) return { ok: false, why: `${xs.size} of the ${threshold} shares that key takes` };
  return { ok: true, mine };
}

/** What this holder knows of a key it holds: its shares' range and threshold, from the record its own keygen kept (CensusKeyStore). Null for none (key 0 is kept without one). */
export const rosterOfRecord = (publicKey, shares) => {
  if (!shares.record || !shares.record.length) return null;
  const r = decodeCensusKeyRecord(shares.record);
  if (toHex(r.publicKey) !== toHex(publicKey)) return null;
  return { total: r.totalShares, threshold: r.threshold };
};

/**
 * THE HOLDER'S SIDE. `check(request)` -> { ok, digest, publicKey } or { ok: false, why }; `held(publicKey)` CensusKeyStore's. `work` the worker's job, as in a run.
 * `rosterOf(publicKey, held)` -> { total, threshold } this holder trusts for that key, by default its own record of it.
 */
export function createCensusSigner({ key, check, held, work = censusKeyInWorker, now = Date.now, rosterOf = rosterOfRecord, limits = SESSION_LIMITS }) {
  const me = toHex(key);
  let checking = 0;
  const sessions = new Map();                    // session id -> { state: committed, ... }; none and used are not in it
  const stateOf = (id) => (sessions.get(id) || { state: SESSION.NONE }).state;
  /** THE ONE TRANSITION. Compare and set: `from` must be the state now, or nothing moves and the answer is null. To used drops the nonce first. */
  function move(id, from, to, data = {}) {
    const s = sessions.get(id) || { state: SESSION.NONE };
    if (s.state !== from || !MOVES[from].includes(to)) return null;
    if (to === SESSION.COMMITTED) { const next = { ...data, state: to }; sessions.set(id, next); return next; }
    sessions.delete(id);
    return { ...s, state: to };
  }
  const prune = () => { for (const [id, s] of sessions) if (now() - s.atMs > SESSION_MS) move(id, SESSION.COMMITTED, SESSION.USED); };
  /** THE ADMISSION (kanban #1187): whether one more session may open, counted over the sessions open now. Synchronous with the move that opens it, so no two asks pass on one free place. */
  const fullFor = (publicKey, digest) => {
    const k = toHex(publicKey), d = toHex(digest);
    let ofKey = 0, ofDigest = 0;
    for (const s of sessions.values()) if (toHex(s.publicKey) === k) { ofKey += 1; if (toHex(s.digest) === d) ofDigest += 1; }
    if (ofDigest >= limits.perDigest) return `this holder has ${ofDigest} signing sessions open for that very request: one is used or expires first`;
    if (ofKey >= limits.perKey) return `this holder has ${ofKey} signing sessions open for that key: one is used or expires first`;
    return null;
  };
  async function takeCommit(request) {
    prune();
    // BEFORE THE CHECK, since the check may cost a replay: a holder full in all, or busy checking, spends nothing on the ask
    if (sessions.size >= limits.total) return { ok: false, why: `this holder has ${sessions.size} signing sessions open: one is used or expires first`, busy: true };
    if (checking >= limits.checking) return { ok: false, why: `this holder is checking ${checking} requests already`, busy: true };
    let checked;
    checking += 1;
    try { checked = await check(request); } finally { checking -= 1; }
    if (!checked.ok) return checked;
    const shares = held(checked.publicKey);
    if (!shares) return { ok: false, why: 'this node holds no shares of that key' };
    const roster = rosterOf(checked.publicKey, shares);
    if (!roster || !Number.isInteger(roster.total) || !Number.isInteger(roster.threshold) || roster.threshold < 1 || roster.threshold > roster.total)
      return { ok: false, why: 'this node keeps no record of that key to sign by' };
    if ([...shares.shares.keys()].some((x) => !Number.isInteger(x) || x < 1 || x > roster.total)) return { ok: false, why: 'this node\'s shares are not that key\'s' };
    prune();
    const full = sessions.size >= limits.total ? `this holder has ${sessions.size} signing sessions open: one is used or expires first` : fullFor(checked.publicKey, checked.digest);
    if (full) return { ok: false, why: full, busy: true };
    const anyShare = [...shares.shares.values()][0];
    const nonces = { hiding: nonceGenerate340(random(32), anyShare), binding: nonceGenerate340(random(32), anyShare) };
    const session = toHex(random(16)), hiding = toHex(feldmanGroup.pointFromScalar(nonces.hiding)), binding = toHex(feldmanGroup.pointFromScalar(nonces.binding));
    if (!move(session, SESSION.NONE, SESSION.COMMITTED, { nonces, digest: checked.digest, publicKey: checked.publicKey, shares, roster, hiding, binding, atMs: now() }))
      return { ok: false, why: 'that session is taken' };
    return { ok: true, session, node: me, xs: [...shares.shares.keys()], hiding, binding, bind: CENSUS_SIGN_BIND };
  }
  async function takeShare({ session, signers } = {}) {
    const s = move(session, SESSION.COMMITTED, SESSION.USED);   // ONE USE, whatever comes of it
    if (!s) return { ok: false, why: 'no such session here' };
    const set = signingSetOf(signers, { me, hiding: s.hiding, binding: s.binding, held: s.shares.shares, total: s.roster.total, threshold: s.roster.threshold });
    if (!set.ok) return set;
    const z = await work({ kind: 'frostShare', id: set.mine.id, held: s.shares.shares, groupPublicKey: Uint8Array.from([0x02, ...s.publicKey]), nonces: s.nonces, message: s.digest, commitments: commitmentsOf(signers) });
    if (!z.ok) return z;
    return { ok: true, z: scalarHex(z.z) };
  }
  return { takeCommit, takeShare, sessions: () => sessions.size, stateOf };
}

/**
 * THE FILER'S SIDE: asks holders until the threshold of shares has committed, then each of those for its share, and answers { ok, signature } or { ok: false, why, refused }. A share that does not add up shows in the
 * signature, which is checked here before anything is sent. `urls` the seats to ask, `own` this node's signer or null, `request` as `check` reads it. A holder that refuses is named in `refused`, with its reason.
 */
export async function gatherCensusSignature({ request, digest, publicKey, threshold, urls, own = null, fetchFn = fetch, timeoutMs = 60000, atOnce = 8 }) {
  const post = async (url, path, body) => {
    const r = await fetchFn(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return r.json();
  };
  const said = [], refused = [], taken = new Set();
  let have = 0;
  // A COMMIT COUNTS ONCE PER NODE AND PER x, and only from a holder that binds its xs (kanban #1155): an older one would sign another list
  const take = (who, c) => {
    if (c && c.ok && c.bind !== CENSUS_SIGN_BIND) { refused.push({ who: who || 'this node', why: 'that holder does not bind its shares into the signature (kanban #1155): it needs the update' }); return; }
    const fresh = c && c.ok && Array.isArray(c.xs) && c.xs.length && new Set(c.xs).size === c.xs.length && c.xs.every((x) => Number.isInteger(x) && x > 0 && !taken.has(x));
    if (fresh && !said.some((x) => x.node === c.node)) { said.push({ ...c, ask: who }); have += c.xs.length; for (const x of c.xs) taken.add(x); } else if (c && !c.ok) refused.push({ who: who || 'this node', why: c.why });
  };
  // A SESSION THIS FILER WILL NOT USE IS HANDED BACK (kanban #1187): a share asked with no signers ends it at the holder, so a try that comes to nothing leaves nothing open there
  const unused = [];
  const handBack = (list) => Promise.all(list.map((c) => (c.ask ? post(c.ask, '/census-sign/share', { session: c.session, signers: [] }) : own.takeShare({ session: c.session, signers: [] })).catch(() => null)));
  const takeOrHandBack = (who, c) => { const before = said.length; take(who, c); if (c && c.ok && typeof c.session === 'string' && said.length === before) unused.push({ ...c, ask: who }); };
  if (own) takeOrHandBack(null, await own.takeCommit(request).catch((e) => ({ ok: false, why: e.message })));
  const left = [...urls];
  while (have < threshold && left.length) {
    await Promise.all(left.splice(0, atOnce).map(async (u) => takeOrHandBack(u, await post(u, '/census-sign/commit', request).catch((e) => ({ ok: false, why: e.message })))));
  }
  if (have < threshold) { await handBack([...said, ...unused]); return { ok: false, why: `${have} of the ${threshold} shares of that key answered`, refused }; }
  if (unused.length) await handBack(unused);
  const signers = [...said].sort((a, b) => (a.node < b.node ? -1 : 1)).map((c, i) => ({ id: i + 1, node: c.node, xs: c.xs, hiding: c.hiding, binding: c.binding, session: c.session, ask: c.ask }));
  const wire = signers.map(({ id, node, xs, hiding, binding }) => ({ id, node, xs, hiding, binding }));
  const answers = await Promise.all(signers.map(async (s) => {
    const body = { session: s.session, signers: wire };
    return s.ask ? post(s.ask, '/census-sign/share', body).catch((e) => ({ ok: false, why: e.message })) : own.takeShare(body).catch((e) => ({ ok: false, why: e.message }));
  }));
  const bad = answers.findIndex((a) => !a || !a.ok);
  if (bad >= 0) return { ok: false, why: `${signers[bad].node.slice(0, 16)} gave no share: ${answers[bad] && answers[bad].why}`, refused };
  const groupPublicKey = Uint8Array.from([0x02, ...publicKey]);
  const { signature } = aggregate340({ commitments: commitmentsOf(signers), message: digest, groupPublicKey, shares: answers.map((a) => BigInt(`0x${a.z}`)), curve: feldmanGroup });
  let good = false; try { good = schnorr.verify(signature, digest, publicKey); } catch { good = false; }
  if (!good) return { ok: false, why: `the ${signers.length} shares do not add up to a signature of that key`, refused };
  return { ok: true, signature, signers: signers.map((s) => s.node), shares: have, refused };
}
