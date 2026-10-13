// A HALTED FEDERATION'S NOTES, CHECKED OFFLINE (§23A.5 step 3, kanban #323): "A claim is valid if the note carries the
// federation's signature" - the stock mint client's own check, run by the arbitration set against a client of that federation it
// joined while it was OPEN (its config holds the mint's keys per amount tier, so nothing is asked of a guardian):
//
//   fedimint-cli --data-dir <that client> module mint validate <ecash>   every note's signature and spend key -> { amount_msat }
//   fedimint-cli --data-dir <that client> dev decode notes <ecash>       the notes by amount tier, each with its spend key
//
// A note's nonce is its spend key's public key (the mint's `Nonce(spend_key.public_key())`), 33 bytes compressed - the same
// bytes the spent set lists. Answers what liquidation-claims.js `validate` takes: { ok, amountMsat, notes: [{ nonce, amountMsat }] }.
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
    const v = await run(cli, ['--data-dir', dir, 'module', 'mint', 'validate', ecash]);
    if (!v.ok) return { ok: false, why: (v.err || v.out).trim().split('\n').pop().slice(0, 200) };
    let amountMsat; try { amountMsat = BigInt(JSON.parse(v.out).amount_msat); } catch { return { ok: false, why: 'the validation named no amount' }; }
    const d = await run(cli, ['--data-dir', dir, 'dev', 'decode', 'notes', ecash]);
    if (!d.ok) return { ok: false, why: `the notes did not decode: ${(d.err || d.out).trim().slice(0, 200)}` };
    let notes; try { notes = notesOfDecoded(JSON.parse(d.out)); } catch (e) { return { ok: false, why: e.message }; }
    const sum = notes.reduce((a, n) => a + n.amountMsat, 0n);
    if (sum !== amountMsat) return { ok: false, why: `the decoded notes come to ${sum} msat, the validation to ${amountMsat}` };
    return { ok: true, amountMsat, notes: notes.map((n) => ({ nonce: n.nonce, amountMsat: n.amountMsat })) };
  };
}
