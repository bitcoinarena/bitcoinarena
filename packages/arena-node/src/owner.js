// THE NODE'S OWNER (kanban #276, the owner 2026-10-09: "Under Node /Dashboard, a separate owner area. The owner must
// authenticate. First time: 24 Bitcoin words for restore, stored in local storage").
//
// The owner is a key, not an account. The browser makes 32 random bytes, shows them as 24 BIP-39 words to write down,
// keeps them in its local storage, and derives the owner key from them (`ownerSecretFromSeed`); the same words in any
// other browser are the same owner. The node keeps only the owner's public key (a JSON file beside its database).
//
// NO SESSION, NO COOKIE, as everywhere on this daemon: every owner request carries its own BIP-340 signature over a
// tagged hash of [node key, action, arguments, time] (`ownerMessage`). The node key in it means a request signed for one
// node does nothing at another; the time and the kept signatures mean a request cannot be sent twice.
//
// WHO MAY BECOME THE OWNER: whoever holds the node's claim code. A node with no owner makes one at start, prints it in
// its log and writes it beside its database (readable by its operator only); the first signed claim with that code binds
// the owner and the code is gone. Nobody reaching the public address can claim a node without access to its machine.
//
// This file is shared: the node checks with it, and the owner page signs with it (bundled into pages/owner-client.js).
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { utf8Encode } from '../../arena-protocol/src/utf8.js';

export const OWNER_MESSAGE_TAG = 'arena/node-owner/v1';
export const OWNER_KEY_TAG = 'arena/node-owner/key/v1';
export const OWNER_WINDOW_MS = 120000;       // a signed request older or newer than this is refused
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The owner's secret key from the 32 bytes the 24 words encode. */
export const ownerSecretFromSeed = (seed) => taggedHash(OWNER_KEY_TAG, seed);

/** What the owner signs: [node key hex, action, args, atMs] as JSON, tagged. */
export const ownerMessage = ({ node, action, args = {}, atMs }) =>
  taggedHash(OWNER_MESSAGE_TAG, utf8Encode(JSON.stringify([String(node), String(action), args, Number(atMs)])));

/** A signed owner request, as the page sends it. `sign(message, secret)` and `pubkeyOf(secret)` are BIP-340. */
export function signOwnerRequest({ node, action, args = {}, atMs = Date.now(), secret, sign, pubkeyOf }) {
  const sig = sign(ownerMessage({ node, action, args, atMs }), secret);
  return { pubkey: toHex(pubkeyOf(secret)), action, args, atMs, sig: toHex(sig) };
}

const newCode = () => {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
};

/**
 * The node's side. `store`: { read() -> object|null, write(object), writeCode(code|null) } (files in main.js, memory in
 * tests). `verify(sig, msg, key)`: BIP-340. `node`: this node's key, hex.
 */
export function createOwner({ store, verify, node, nowMs = () => Date.now(), log = () => {} }) {
  let owner = store.read();                 // { pubkey, claimedAtMs } or null
  let code = null;
  const used = new Map();                   // sig hex -> atMs, kept for the window
  if (!owner) {
    code = newCode();
    store.writeCode(code);
    log(`[owner] this node has no owner yet. Claim it at /Dashboard/owner with the code ${code}`);
  }
  const check = (req, action) => {
    if (!req || typeof req !== 'object') return { ok: false, why: 'an owner request is a JSON object' };
    if (req.action !== action) return { ok: false, why: `this door takes the action "${action}"` };
    if (!/^[0-9a-f]{64}$/.test(String(req.pubkey)) || !/^[0-9a-f]{128}$/.test(String(req.sig))) return { ok: false, why: 'a pubkey (32 bytes) and a signature (64 bytes), hex' };
    const at = Number(req.atMs);
    if (!Number.isFinite(at) || Math.abs(nowMs() - at) > OWNER_WINDOW_MS) return { ok: false, why: 'the request is not from the last two minutes (check the clock)' };
    for (const [s, t] of used) if (nowMs() - t > 2 * OWNER_WINDOW_MS) used.delete(s);
    if (used.has(req.sig)) return { ok: false, why: 'this request was already sent' };
    let good = false;
    try { good = verify(fromHex(req.sig), ownerMessage({ node, action, args: req.args || {}, atMs: at }), fromHex(req.pubkey)); } catch { good = false; }
    if (!good) return { ok: false, why: 'the signature does not check' };
    used.set(req.sig, at);
    return { ok: true };
  };
  return {
    state: () => ({ node, claimed: !!owner, owner: owner ? owner.pubkey : null, claimedAtMs: owner ? owner.claimedAtMs : null, leavingAtMs: owner && owner.leaving ? owner.leaving.atMs : null }),
    /** The first owner, with the claim code from the node's log. */
    claim(req) {
      if (owner) return { ok: false, status: 409, why: 'this node already has an owner' };
      const c = check(req, 'claim');
      if (!c.ok) return { ...c, status: 401 };
      const given = String((req.args && req.args.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code || given !== code.replace(/-/g, '')) return { ok: false, status: 403, why: 'that is not this node\'s claim code (it is in the node\'s log)' };
      owner = { pubkey: req.pubkey, claimedAtMs: nowMs() };
      store.write(owner);
      store.writeCode(null);
      code = null;
      log(`[owner] claimed by ${req.pubkey}`);
      return { ok: true, owner: owner.pubkey };
    },
    /** LEAVE (kanban #276 step 2): from now this seat takes no new round; it serves the ones it holds. Kept with the owner. */
    leave(req) {
      const a = this.authorize(req, 'leave');
      if (!a.ok) return a;
      if (owner.leaving) return { ok: true, leavingAtMs: owner.leaving.atMs, already: true };
      owner = { ...owner, leaving: { atMs: nowMs() } };
      store.write(owner);
      log(`[owner] leaving from ${new Date(owner.leaving.atMs).toISOString()}: no new rounds; the held ones are served to their end`);
      return { ok: true, leavingAtMs: owner.leaving.atMs };
    },
    /** STAY: the leave taken back; new rounds are taken again. */
    stay(req) {
      const a = this.authorize(req, 'stay');
      if (!a.ok) return a;
      if (owner.leaving) { const { leaving, ...rest } = owner; owner = rest; store.write(owner); log('[owner] staying: new rounds are taken again'); void leaving; }
      return { ok: true, leavingAtMs: null };
    },
    leavingAtMs: () => (owner && owner.leaving ? owner.leaving.atMs : null),
    /** THE STORE'S SETTINGS (kanban #276 step 5, the owner 2026-10-10: "updates can be automatic, that is a setting"): signed. */
    settings(req) {
      const a = this.authorize(req, 'settings');
      if (!a.ok) return a;
      const args = req.args || {};
      const sources = Array.isArray(args.sources) ? args.sources.map(String).map((u) => u.trim().replace(/\/+$/, '')).filter((u) => /^https?:\/\/[^\s]+$/.test(u)).slice(0, 20) : [];
      owner = { ...owner, settings: { autoUpdate: !!args.autoUpdate, sources } };
      store.write(owner);
      log(`[owner] store settings: automatic updates ${owner.settings.autoUpdate ? 'on' : 'off'}, ${sources.length} source seat(s)`);
      return { ok: true, settings: owner.settings };
    },
    storeSettings: () => (owner && owner.settings ? owner.settings : { autoUpdate: false, sources: [] }),
    /** Any owner action: the signature, the time, and that the key is the owner's. */
    authorize(req, action) {
      if (!owner) return { ok: false, status: 409, why: 'this node has no owner yet' };
      const c = check(req, action);
      if (!c.ok) return { ...c, status: 401 };
      if (req.pubkey !== owner.pubkey) return { ok: false, status: 403, why: 'that key is not this node\'s owner' };
      return { ok: true };
    },
  };
}
