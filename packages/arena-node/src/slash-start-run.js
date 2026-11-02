// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT FILES A SLASH START (spec 5A.3B, kanban #972). It holds a proof, the accused's bond is template 3 and unstarted, so it takes the presig (the round's, else the one at bonding), a fee coin of its own and the proof's OP_RETURN,
// and asks the key's holders. Each holder replays the proof itself (`judge`) and holds the request to its own census and its own hold outputs before it commits a nonce, so a filer can claim nothing. Bitcoin takes the result
// or refuses it. A filer earns nothing here and the release pays its fee back, so seats that hold one proof wait their turn by a hash, and what one files the others see on the chain.
import { schnorr } from '@noble/curves/secp256k1.js';
import { BOND_TEMPLATE_V3, HOLD_INTERNAL_KEY, TAPLEAF_VERSION, controlBlockFor, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { scriptPathWitness, tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { buildSlashStart, checkSlashStart, signedSlashStart, slashStartDigest } from '../../arena-protocol/src/slash-start.js';
import { slashHeightIsValid, slashProofId } from '../../arena-protocol/src/slash.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { tweakPoint } from './curve.js';
import { bondKeyOf } from './bond-withdraw.js';
import { createCensusSigner, gatherCensusSignature } from './census-sign.js';

const verifySig = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const HINT = new TextEncoder().encode('arena');
const txJson = (tx) => ({ version: tx.version, locktime: tx.locktime, inputs: tx.inputs.map((i) => ({ txid: toHex(i.txid), vout: i.vout, sequence: i.sequence })), outputs: tx.outputs.map((o) => ({ value: String(o.value), script: toHex(o.script) })) });
const txOfJson = (t) => ({ version: t.version, locktime: t.locktime, inputs: t.inputs.map((i) => ({ txid: fromHex(i.txid), vout: i.vout, sequence: i.sequence })), outputs: t.outputs.map((o) => ({ value: BigInt(o.value), script: fromHex(o.script) })) });
const coinsJson = (p) => p.map((x) => ({ value: String(x.value), script: toHex(x.script) }));
const coinsOfJson = (p) => p.map((x) => ({ value: BigInt(x.value), script: fromHex(x.script) }));
const bondOf = (e) => ({ txid: e.txid, vout: e.vout, value: BigInt(e.bondSats), script: e.script });

/** Which seat files first, of the seats a proof reached: a hash of the proof and the key, so nobody picks its place. */
export const filerRank = (proofId, keys, me) => [...keys].sort((a, b) => (toHex(taggedHash('ARENA/v1/SlashFiler', Uint8Array.from([...proofId, ...fromHex(a)]))) < toHex(taggedHash('ARENA/v1/SlashFiler', Uint8Array.from([...proofId, ...fromHex(b)]))) ? -1 : 1)).indexOf(me);

/**
 * `key`; `db`; `store` CensusKeyStore; `thresholdOf(keyHex)`; `tipHeight()`; `entriesAtTip()` the census at the tip; `heldProofs()` [{ roundId, proofId, bytes, seenMs }] of the proofs this seat holds; `judge(evidence, contract)` this seat's own
 * replay: { verdict: true | false | undefined, why, proof, contract }; `holdsFor(entry, roundId, contract)` -> { holds: [{ script }], presig?(bytes), holdScript? } by this seat's own reckoning, `presig`/`holdScript` naming the one a filer uses;
 * `feeCoin(spk, value)`, `send(hex)`, `urlsOf(entries)`.
 */
export function createSlashStarter({ key, network, db, store, thresholdOf, tipHeight, entriesAtTip, heldProofs, judge, holdsFor, encodeContract, decodeContract, feeCoin, send, urlsOf, stepMs = 600000, feeSats = 700n, fetchFn = fetch, now = Date.now, log = () => {} }) {
  const me = toHex(key);
  db.exec(`CREATE TABLE IF NOT EXISTS slash_starts (proof_id BLOB PRIMARY KEY, bond TEXT NOT NULL, txid TEXT NOT NULL, kept_ms INTEGER NOT NULL)`);
  const filed = (id) => !!db.prepare('SELECT 1 FROM slash_starts WHERE proof_id = ?').get(id);
  const entryOf = (entries, proof) => entries.find((e) => toHex(e.txid) === toHex(proof.bondTxid) && e.vout === proof.bondVout) || null;

  /** A HOLDER'S CHECK of a filer's request: the proof on this seat's own replay, then the bond, its hold and the transaction by this seat's own census. */
  async function check(request) {
    let tx, prevouts, evidence, presig, contract = null;
    try {
      tx = txOfJson(request.tx); prevouts = coinsOfJson(request.prevouts); evidence = fromHex(request.evidence); presig = fromHex(request.presig);
      if (request.contract) contract = decodeContract(fromHex(request.contract));
    } catch (e) { return { ok: false, why: `that is no request: ${e.message}` }; }
    const j = await judge(evidence, contract);
    if (j.verdict !== true) return { ok: false, why: j.why };
    const entry = entryOf((await entriesAtTip()) || [], j.proof);
    if (!entry || entry.advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V3) return { ok: false, why: 'no unspent template-3 bond of this census is that proof\'s' };
    if (entry.hold) return { ok: false, why: 'that bond was started already' };
    const { holds, why } = holdsFor(entry, j.proof.roundId, j.contract);
    if (!holds.length) return { ok: false, why: why || 'that bond has no hold output here yet' };
    const c = checkSlashStart({ tx, prevouts, bond: bondOf(entry), nodeKey: entry.pubkey, censusKey: entry.advert.censusKey, holds, presig, proofId: slashProofId(j.proof), verify: verifySig });
    if (!c.ok) return c;
    const height = slashHeightIsValid({ slashHeight: c.slashHeight, censusHeight: j.contract.censusHeight, tipHeight: await tipHeight() });
    if (!height.ok) return height;
    return { ok: true, digest: c.digest, publicKey: entry.advert.censusKey };
  }
  const signer = createCensusSigner({ key, check, held: (publicKey) => store.held(publicKey) });

  const feeHeld = new Map();                     // proof id hex -> the coin funded for it, so a start tried again pays once
  async function feeFor(idHex) {
    if (feeHeld.has(idHex)) return feeHeld.get(idHex);
    const secret = schnorr.utils.randomSecretKey(), leaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(secret), 0xac]), leafHash = tapLeafHash(leaf);
    const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, leafHash)), script = fromHex(`5120${toHex(q.outputKey)}`);
    const got = await feeCoin(script, feeSats);
    if (!got.ok) return got;
    const coin = { ok: true, txid: fromHex(got.txid).reverse(), vout: got.vout, value: got.value, script, secret, leaf, leafHash, control: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) };
    feeHeld.set(idHex, coin);
    return coin;
  }

  /** One filing: { ok, txid, signers } or { ok: false, why, refused }. */
  async function file({ evidence, judged, entry, entries }) {
    const proof = judged.proof, idHex = toHex(slashProofId(proof));
    const { presig, holdScript, why } = holdsFor(entry, proof.roundId, judged.contract);
    if (!presig) return { ok: false, why: why || 'this seat holds no slash_presig of that bond' };
    const fee = await feeFor(idHex);
    if (!fee.ok) return fee;
    const censusKey = entry.advert.censusKey, nodeKey = entry.pubkey, keyHex = toHex(censusKey);
    const tip = await tipHeight();
    const { tx, prevouts } = buildSlashStart({ bond: bondOf(entry), holdScript, proofId: slashProofId(proof), slashHeight: tip, hint: HINT, fee });
    const threshold = thresholdOf(keyHex);
    if (!threshold) return { ok: false, why: `this seat reads no threshold for key ${keyHex.slice(0, 16)}` };
    const request = { evidence: toHex(evidence), contract: toHex(encodeContract(judged.contract)), presig: toHex(presig), tx: txJson(tx), prevouts: coinsJson(prevouts) };
    const digest = slashStartDigest({ tx, prevouts, nodeKey, censusKey });
    const got = await gatherCensusSignature({ request, digest, publicKey: censusKey, threshold, urls: urlsOf(entries), own: store.held(censusKey) ? signer : null, fetchFn });
    if (!got.ok) return got;
    const feeWitness = scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: fee.leafHash }), fee.secret)], script: fee.leaf, controlBlock: fee.control });
    const control = controlBlockFor('slash', bondKeyOf(nodeKey, entry.advert.bondMaturityHeight, network, censusKey)).controlBlock;
    const raw = signedSlashStart({ tx, nodeKey, censusKey, censusSignature: got.signature, presig, control, feeWitness });
    const txid = await send(toHex(raw));
    db.prepare('INSERT OR IGNORE INTO slash_starts (proof_id, bond, txid, kept_ms) VALUES (?, ?, ?, ?)').run(slashProofId(proof), `${toHex(entry.txid)}:${entry.vout}`, String(txid), now());
    feeHeld.delete(idHex);
    return { ok: true, txid: String(txid), signers: got.signers, shares: got.shares, refused: got.refused, size: parseTransaction(raw).outputs.length };
  }

  /** One pass over the proofs this seat holds. Only a proof this seat's own replay holds to is filed, and each seat waits for its turn. */
  async function pass() {
    const done = [];
    const proofs = heldProofs().filter((p) => !filed(p.proofId));
    if (!proofs.length) return done;
    const entries = await entriesAtTip();
    if (!entries) return done;
    for (const p of proofs) {
      const judged = await judge(p.bytes, null);
      if (judged.verdict !== true) continue;
      const entry = entryOf(entries, judged.proof);
      if (!entry || entry.hold || entry.advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V3) continue;
      const keys = [...new Set(entries.map((e) => toHex(e.pubkey)))];
      if (now() - p.seenMs < filerRank(p.proofId, keys, me) * stepMs) continue;
      let r; try { r = await file({ evidence: p.bytes, judged, entry, entries }); } catch (e) { r = { ok: false, why: e.message }; }
      log(r.ok ? `[slash] start filed against ${toHex(entry.pubkey).slice(0, 16)}: ${r.txid}, ${r.signers.length} holders, ${r.shares} shares` : `[slash] no start against ${toHex(entry.pubkey).slice(0, 16)} yet: ${r.why}${r.refused && r.refused.length ? ` (${r.refused.map((x) => x.why).join('; ')})` : ''}`);
      done.push(r);
    }
    return done;
  }
  return { pass, file, takeCommit: signer.takeCommit, takeShare: signer.takeShare, check };
}
