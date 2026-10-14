// A HALTED FEDERATION'S NOTES, CHECKED OFFLINE (§23A.5 step 3, kanban #323): "A claim is valid if the note carries the
// federation's signature" - checked by the arbitration set against a client of that federation it joined while it was OPEN (its
// config holds the mint's keys per denomination, so nothing is asked of a guardian).
//
// Our federations run MINTV2 (measured in rehearsal 17: the regtest probe, testnet4 A and B all list mintv2, no mint). Its stock
// CLI has no check, so the fork adds one (tools/fedimint-spent-nonces.patch):
//   fedimint-cli --data-dir <that client> module mintv2 validate <ecash>
//     -> { federation_id, ours, amount_msat, valid, notes: [{ nonce, amount_msat, valid }] }
// each note's signature checked against the aggregate key of its denomination, its nonce the note key's public key (33 bytes
// compressed, the bytes the spent set lists). A federation on the old mint module is read the stock way instead:
//   fedimint-cli --data-dir <that client> module mint validate <ecash>   every note's signature -> { amount_msat }
//   fedimint-cli --data-dir <that client> dev decode notes <ecash>       the notes by amount tier, each with its spend key
// Answers what liquidation-claims.js `validate` takes: { ok, amountMsat, notes: [{ nonce, amountMsat }] }.
import { execFile } from 'node:child_process';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The notes of `dev decode notes` output: { "<msat>": [note, ...] } or [[msat, note], ...], each note's spend key a secret (hex). */
export function notesOfDecoded(decoded) {
  const tiers = decoded && (decoded.notes !== undefined ? decoded.notes : decoded);
  const pairs = Array.isArray(tiers) ? tiers.flatMap((t) => (Array.isArray(t) && t.length === 2 && Array.isArray(t[1]) ? t[1].map((n) => [t[0], n]) : Array.isArray(t) && t.length === 2 ? [[t[0], t[1]]] : []))
    : Object.entries(tiers || {}).flatMap(([amt, list]) => (Array.isArray(list) ? list : [list]).map((n) => [amt, n]));
  return pairs.map(([amt, n]) => {
    const secret = String(n && (n.spend_key || n.spendKey) || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('a decoded note carries no 32-byte spend key');
    const amountMsat = BigInt(String(amt).replace(/_?msat$/, ''));
    return { nonce: hexOf(secp256k1.getPublicKey(Uint8Array.from(secret.match(/../g).map((x) => parseInt(x, 16))), true)), amountMsat };
  });
}

export function fedimintNoteValidator({ cli, dataDirFor, home = process.env.HOME, run = (bin, args) => new Promise((done) =>
  execFile(bin, args, { timeout: 60000, env: { ...process.env, HOME: home } }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') }))) }) {
  return async (federationHex, ecash) => {
    const dir = dataDirFor(federationHex);
    if (!dir) return { ok: false, why: 'the arbitration set holds no client of that federation to check its notes with' };
    const last = (r) => (r.err || r.out).trim().split('\n').pop().slice(0, 200);
    const v2 = await run(cli, ['--data-dir', dir, 'module', 'mintv2', 'validate', ecash]);
    if (v2.ok || !/No module with this kind/.test(v2.err + v2.out)) {
      if (!v2.ok) return { ok: false, why: last(v2) };
      let j; try { j = JSON.parse(v2.out); } catch { return { ok: false, why: 'the validation did not read' }; }
      if (!j.ours) return { ok: false, why: `those notes are of another federation (${j.federation_id})` };
      const bad = (j.notes || []).filter((n) => !n.valid);
      if (!j.valid || bad.length) return { ok: false, why: `${bad.length} of ${(j.notes || []).length} notes do not carry the federation's signature` };
      const notes = j.notes.map((n) => ({ nonce: String(n.nonce).toLowerCase(), amountMsat: BigInt(n.amount_msat) }));
      if (notes.some((n) => !/^0[23][0-9a-f]{64}$/.test(n.nonce))) return { ok: false, why: 'a note\'s nonce is not a 33-byte key' };
      const sum = notes.reduce((a, n) => a + n.amountMsat, 0n);
      if (sum !== BigInt(j.amount_msat)) return { ok: false, why: `the notes come to ${sum} msat, the e-cash to ${j.amount_msat}` };
      return { ok: true, amountMsat: sum, notes };
    }
    const v = await run(cli, ['--data-dir', dir, 'module', 'mint', 'validate', ecash]);
    if (!v.ok) return { ok: false, why: last(v) };
    let amountMsat; try { amountMsat = BigInt(JSON.parse(v.out).amount_msat); } catch { return { ok: false, why: 'the validation named no amount' }; }
    const d = await run(cli, ['--data-dir', dir, 'dev', 'decode', 'notes', ecash]);
    if (!d.ok) return { ok: false, why: `the notes did not decode: ${(d.err || d.out).trim().slice(0, 200)}` };
    let notes; try { notes = notesOfDecoded(JSON.parse(d.out)); } catch (e) { return { ok: false, why: e.message }; }
    const sum = notes.reduce((a, n) => a + n.amountMsat, 0n);
    if (sum !== amountMsat) return { ok: false, why: `the decoded notes come to ${sum} msat, the validation to ${amountMsat}` };
    return { ok: true, amountMsat, notes: notes.map((n) => ({ nonce: n.nonce, amountMsat: n.amountMsat })) };
  };
}

/**
 * A PENDING OUTPUT, CHECKED OFFLINE (§23A.5 "Notes still in issuance at the halt", RULED 2026-10-14): the fork's
 *   fedimint-cli --data-dir <that client> module mintv2 check-pending <issuance request hex>
 * recomputes the note nonce, the hash160 of the blinded message (the issued set's nonce_hash) and the amount. Answers what
 * liquidation-claims.js `checkPending` takes: { ok, nonce, nonceHash, amountMsat } or why not.
 */
export function fedimintPendingChecker({ cli, dataDirFor, home = process.env.HOME, run = (bin, args) => new Promise((done) =>
  execFile(bin, args, { timeout: 60000, env: { ...process.env, HOME: home } }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') }))) }) {
  return async (federationHex, requestHex) => {
    if (!/^[0-9a-f]+$/i.test(String(requestHex))) return { ok: false, why: 'an issuance request is hex' };
    const dir = dataDirFor(federationHex);
    if (!dir) return { ok: false, why: 'the arbitration set holds no client of that federation to check it with' };
    const r = await run(cli, ['--data-dir', dir, 'module', 'mintv2', 'check-pending', String(requestHex)]);
    if (!r.ok) return { ok: false, why: (r.err || r.out).trim().split('\n').pop().slice(0, 200) };
    let j; try { j = JSON.parse(r.out); } catch { return { ok: false, why: 'the check did not read' }; }
    if (!/^0[23][0-9a-f]{64}$/.test(String(j.nonce)) || !/^[0-9a-f]{40}$/.test(String(j.nonce_hash))) return { ok: false, why: 'the check named no nonce' };
    return { ok: true, nonce: String(j.nonce), nonceHash: String(j.nonce_hash), amountMsat: BigInt(j.amount_msat) };
  };
}
