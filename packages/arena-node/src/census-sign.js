// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY SIGNS (spec 5A.3B, kanban #972). FROST over BIP-340, one nonce pair per node for its several shares (frost-bip340.js signNodeShare340). Two rounds, seat to seat. A holder answers the first only after its own
// `check` of the request: for a slash start, that it pays the hold output its node signed to, and that the proof holds on this holder's own replay. Whatever it answers is bound to that digest. A nonce is used once, whatever
// comes back: the session goes before anything is signed, and a restart loses it, which costs a filer one more try. Nothing here is a secret on the wire.
//
//   POST /census-sign/commit   a request -> { ok, session, node, xs, hiding, binding } or { ok: false, why }
//   POST /census-sign/share    { session, signers: [{ id, node, xs, hiding, binding }] } -> { ok, z }
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from './curve.js';
import { censusKeyInWorker } from './census-key-work.js';

const random = (n) => new Uint8Array(randomBytes(n));
const SESSION_MS = 600000;
const scalarHex = (z) => z.toString(16).padStart(64, '0');
/** The wire's commitment list as the signers hash it: by id, whatever order it came in. */
const commitmentsOf = (signers) => signers.map((s) => ({ id: s.id, hiding: fromHex(s.hiding), binding: fromHex(s.binding) })).sort((a, b) => a.id - b.id);

/**
 * THE HOLDER'S SIDE. `check(request)` -> { ok, digest, publicKey } or { ok: false, why }; `held(publicKey)` CensusKeyStore's. `work` the worker's job, as in a run.
 */
export function createCensusSigner({ key, check, held, work = censusKeyInWorker, now = Date.now }) {
  const me = toHex(key);
  const sessions = new Map();
  const prune = () => { for (const [id, s] of sessions) if (now() - s.atMs > SESSION_MS) sessions.delete(id); };
  async function takeCommit(request) {
    const checked = await check(request);
    if (!checked.ok) return checked;
    const shares = held(checked.publicKey);
    if (!shares) return { ok: false, why: 'this node holds no shares of that key' };
    prune();
    const anyShare = [...shares.shares.values()][0];
    const nonces = { hiding: nonceGenerate340(random(32), anyShare), binding: nonceGenerate340(random(32), anyShare) };
    const session = toHex(random(16)), hiding = toHex(feldmanGroup.pointFromScalar(nonces.hiding)), binding = toHex(feldmanGroup.pointFromScalar(nonces.binding));
    sessions.set(session, { nonces, digest: checked.digest, publicKey: checked.publicKey, shares, hiding, binding, atMs: now() });
    return { ok: true, session, node: me, xs: [...shares.shares.keys()], hiding, binding };
  }
  async function takeShare({ session, signers }) {
    const s = sessions.get(session);
    sessions.delete(session);                    // ONE USE, whatever comes of it
    if (!s) return { ok: false, why: 'no such session here' };
    if (!Array.isArray(signers)) return { ok: false, why: 'name the signers' };
    const mine = signers.find((x) => x.node === me);
    if (!mine || mine.hiding !== s.hiding || mine.binding !== s.binding) return { ok: false, why: 'that list does not carry this node\'s commitment' };
    const z = await work({ kind: 'frostShare', id: mine.id, held: s.shares.shares, all: signers.flatMap((x) => x.xs), groupPublicKey: Uint8Array.from([0x02, ...s.publicKey]), nonces: s.nonces, message: s.digest, commitments: commitmentsOf(signers) });
    if (!z.ok) return z;
    return { ok: true, z: scalarHex(z.z) };
  }
  return { takeCommit, takeShare, sessions: () => sessions.size };
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
  const said = [], refused = [];
  let have = 0;
  const take = (who, c) => {
    if (c && c.ok && !said.some((x) => x.node === c.node)) { said.push({ ...c, ask: who }); have += c.xs.length; } else if (c && !c.ok) refused.push({ who: who || 'this node', why: c.why });
  };
  if (own) take(null, await own.takeCommit(request).catch((e) => ({ ok: false, why: e.message })));
  const left = [...urls];
  while (have < threshold && left.length) {
    await Promise.all(left.splice(0, atOnce).map(async (u) => take(u, await post(u, '/census-sign/commit', request).catch((e) => ({ ok: false, why: e.message })))));
  }
  if (have < threshold) return { ok: false, why: `${have} of the ${threshold} shares of that key answered`, refused };
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
