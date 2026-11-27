// LOGIN WITH NOSTR (2026-10-09/10: "Nostr is the account ... the user must save the nsec ... If they
// already have an nsec, connect a remote signer: Bunker, Amber, Alby"; 2026-10-10: "All is approved ... Figure out how that
// works properly"). The game's wallet is one 32-byte seed (the 24 words); Nostr gives it back on any device:
//   - THE SEED LIVES IN ONE EVENT: kind 30078 (NIP-78 app data), d = "bitcoin-arena/seed", its content the seed encrypted
//     to the player's OWN key (NIP-44) - only that key can read it. Kept on our relay and a few public ones.
//   - FIRST LOGIN, NO SUCH EVENT YET: with an nsec the seed is DERIVED from it (a tagged hash), so the nsec alone brings it
//     back even if every relay forgot the event; with a signer (extension, bunker, Amber) the secret never leaves the
//     signer, so the seed is random and the event is the only copy - the page then shows the 24 words to write down.
//   - AN EXISTING EVENT IS NEVER OVERWRITTEN: one that does not decrypt is an error, not a reason to make a new seed; and no
//     new seed is made unless a relay answered (an offline page must not mint a second wallet for an account that has one).
// Three ways in, one interface { method, pubkey, signEvent(template), encrypt(peer, text), decrypt(peer, text), close() }:
//   nsec (pasted, or a new account made here), extension (NIP-07: Alby, nos2x...), bunker (NIP-46: bunker:// pasted, or
//   nostrconnect:// shown as a QR for Amber and similar).
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import { BunkerSigner, parseBunkerInput, createNostrConnectURI } from 'nostr-tools/nip46';
import { SimplePool } from 'nostr-tools/pool';
import { minePow } from 'nostr-tools/nip13';

/**
 * PUBLISH, AND PAY THE PROOF OF WORK A RELAY ASKS FOR (kanban #2847, ruling 2026-11-16): the game's relay asks an author it has never kept for
 * NIP-13 proof of work while it is nearly full ('pow: difficulty N required'). The event is mined here to the highest difficulty asked (`onMining`
 * says so meanwhile: "preparing your profile ..."), signed again and sent to those relays. Answers the relays that took it.
 */
/** The most proof of work the page mines for one event (kanban #3030): the game relay's POW_MAX. */
export const POW_MINE_MAX = 28;
export async function publishWithPow(pool, relays, ev, signer, { onMining = () => {} } = {}) {
  const res = await Promise.allSettled(pool.publish([...relays], ev));
  const took = [], asked = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') { took.push(relays[i]); return; }
    const m = /pow: difficulty (\d+) required/.exec(String((r.reason && r.reason.message) || r.reason || ''));
    if (m) asked.push([relays[i], Number(m[1])]);
  });
  // A CAPPED DIFFICULTY (kanban #3030, audit nostr r2-1): minePow is a synchronous loop on the page's one thread, and the highest difficulty any
  // relay of the list asked was mined - one public relay answering 'pow: difficulty 64 required' froze the first Nostr login for good. The game's
  // relay never asks more than POW_MINE_MAX (its POW_MAX, 28); a relay asking more is taken as refusing and is not mined for
  const fair = asked.filter(([, n]) => Number.isInteger(n) && n >= 0 && n <= POW_MINE_MAX);
  asked.length = 0; asked.push(...fair);
  if (!asked.length) return took;
  const need = Math.max(...asked.map(([, n]) => n));
  onMining(need);
  const mined = minePow({ kind: ev.kind, created_at: ev.created_at, tags: (ev.tags || []).filter((t) => t[0] !== 'nonce'), content: ev.content, pubkey: ev.pubkey }, need);
  const signed = await signer.signEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content });
  const again = await Promise.allSettled(pool.publish(asked.map(([u]) => u), signed));
  again.forEach((r, i) => { if (r.status === 'fulfilled') took.push(asked[i][0]); });
  return took;
}
import { sha256 } from '@noble/hashes/sha2.js';
import { ARENA_RELAY } from '../../arena-protocol/src/nostr-relays.js';

export const SEED_KIND = 30078;
export const SEED_D = 'bitcoin-arena/seed';
// OURS FIRST, then three public relays that keep app data and pass NIP-46 messages (measured from the test host 2026-10-10; relay.damus.io answers 520/521 since, kanban #854)
export const NOSTR_RELAYS = Object.freeze([ARENA_RELAY, 'wss://relay.snort.social', 'wss://nos.lol', 'wss://relay.primal.net']);
// a remote signer listens on these unless its bunker:// link names its own (nsec.app's relay is where most bunkers sit)
export const SIGNER_RELAYS = Object.freeze([ARENA_RELAY, 'wss://relay.nsec.app', 'wss://relay.snort.social']);

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));
const utf8 = (s) => new TextEncoder().encode(s);
const TAG = sha256(utf8('arena/nostr-seed/v1'));
/** The seed an nsec gives: SHA-256(tag || tag || secret), BIP-340's tagged hash, so it is no other use of the key. */
export const derivedSeed = (secret) => { const b = new Uint8Array(96); b.set(TAG, 0); b.set(TAG, 32); b.set(secret, 64); return sha256(b); };

/** A signer from a secret key held here. */
export function localSigner(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('a Nostr secret key is 32 bytes');
  const pubkey = getPublicKey(secret);
  const key = (peer) => nip44.getConversationKey(secret, peer);
  return { method: 'nsec', pubkey, secret,
    signEvent: async (t) => finalizeEvent({ ...t }, secret),
    encrypt: async (peer, text) => nip44.encrypt(text, key(peer)),
    decrypt: async (peer, text) => nip44.decrypt(text, key(peer)),
    close: async () => {} };
}
/** "nsec1..." or 64 hex: a signer, or why not. */
export function signerFromNsec(text) {
  const s = String(text || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return localSigner(unhex(s.toLowerCase()));
  let d; try { d = nip19.decode(s); } catch { throw new Error('that is not an nsec (nsec1...) or a 64-hex secret key'); }
  if (d.type !== 'nsec') throw new Error(d.type === 'npub' ? 'that is your public key (npub): log in with your secret key (nsec), a browser extension or a remote signer' : `that is a ${d.type}, not an nsec`);
  return localSigner(d.data);
}
/** A NEW NOSTR ACCOUNT made here: its signer and the nsec the player must write down (it IS the account). */
export function newAccount() {
  const secret = generateSecretKey();
  return { signer: localSigner(secret), nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
}
/** NIP-07: a browser extension (Alby, nos2x, ...). It must speak NIP-44. */
export async function extensionSigner(nostr = globalThis.nostr) {
  if (!nostr || typeof nostr.getPublicKey !== 'function') throw new Error('no Nostr extension in this browser (Alby, nos2x...): install one, or use a remote signer or your nsec');
  if (!nostr.nip44 || typeof nostr.nip44.encrypt !== 'function') throw new Error('this Nostr extension does not support NIP-44 encryption - update it, or use a remote signer');
  const pubkey = await nostr.getPublicKey();
  return { method: 'extension', pubkey, signEvent: (t) => nostr.signEvent({ ...t, pubkey }),
    encrypt: (peer, text) => nostr.nip44.encrypt(peer, text), decrypt: (peer, text) => nostr.nip44.decrypt(peer, text), close: async () => {} };
}
const wrapBunker = (b, pubkey) => ({ method: 'bunker', pubkey, bunker: b, signEvent: (t) => b.signEvent(t),
  encrypt: (peer, text) => b.nip44Encrypt(peer, text), decrypt: (peer, text) => b.nip44Decrypt(peer, text), close: () => b.close() });
/** NIP-46 from a bunker:// link (nsecBunker, nsec.app, Amber's "bunker" link) or a NIP-05 name that names one. */
export async function bunkerSigner(input, { pool, onauth, clientSecret = generateSecretKey() } = {}) {
  const bp = await parseBunkerInput(String(input || '').trim());
  if (!bp) throw new Error('that is not a bunker:// link or a name with a bunker');
  if (!bp.relays || !bp.relays.length) bp.relays = [...SIGNER_RELAYS];
  const b = BunkerSigner.fromBunker(clientSecret, bp, { pool, onauth });
  await b.connect();
  return wrapBunker(b, await b.getPublicKey());
}
/**
 * NIP-46 THE OTHER WAY (nostrconnect://, what Amber and most mobile signers scan): the page shows `uri` as a QR code and a
 * link; `signer` resolves once the player's signer answered on those relays.
 */
export function nostrConnect({ relays = SIGNER_RELAYS, name = 'Bitcoin Arena', url = 'https://bitcoinarena.io', pool, onauth, maxWait = 300000, clientSecret = generateSecretKey() } = {}) {
  const secret = hex(generateSecretKey()).slice(0, 16);
  const uri = createNostrConnectURI({ clientPubkey: getPublicKey(clientSecret), relays: [...relays], secret, name, url,
    perms: [`sign_event:${SEED_KIND}`, 'sign_event:0', 'nip44_encrypt', 'nip44_decrypt'] });
  const signer = BunkerSigner.fromURI(clientSecret, uri, { pool, onauth }, maxWait).then(async (b) => wrapBunker(b, await b.getPublicKey()));
  return { uri, signer };
}

/** The relays that answer, of `relays` (at most `ms` each): a seed is never made on a page no relay answered. */
async function reachable(pool, relays, ms) {
  const got = await Promise.all(relays.map((u) => Promise.race([pool.ensureRelay(u, { connectionTimeout: ms }).then(() => u, () => null), new Promise((r) => setTimeout(() => r(null), ms + 200))])));
  return got.filter(Boolean);
}

/**
 * Ask each relay of `up` (connected) for `filter` on its own: { events, unanswered: [relays that did not send EOSE within
 * `ms`, or closed the query] } (kanban #1574: querySync cannot tell "EOSE with nothing" from "no answer in time").
 */
async function askEach(pool, up, filter, ms) {
  const events = [], unanswered = [];
  await Promise.all(up.map(async (u) => {
    let relay; try { relay = await pool.ensureRelay(u, { connectionTimeout: ms }); } catch { unanswered.push(u); return; }
    await new Promise((resolve) => {
      let done = false, sub = null;
      const end = (ok) => { if (done) return; done = true; clearTimeout(t); if (!ok) unanswered.push(u); try { sub?.close(); } catch {} resolve(); };
      const t = setTimeout(() => end(false), ms);
      // the library's own EOSE timeout would call oneose; set it past ours so only a real EOSE counts
      try { sub = relay.subscribe([filter], { onevent: (e) => events.push(e), oneose: () => end(true), onclose: () => end(false), eoseTimeout: ms * 4 + 1000 }); } catch { end(false); }
    });
  }));
  return { events, unanswered };
}

/**
 * THE GAME SEED OF THIS NOSTR ACCOUNT: its seed event's, decrypted; else a new one - derived from an nsec, random for a
 * signer - encrypted to the account's own key, signed and published. Answers { seed (32 bytes), created, from ('relays' |
 * 'derived' | 'random'), relays: [those that took it] }.
 */
// FRESH: a key made on this page a moment ago (newAccount) has no seed event anywhere - the relays are not asked for one (kanban
//: the ask waited up to maxWait for every relay's answer before a new account's seed was made)
export async function seedFor(signer, { pool = new SimplePool(), relays = NOSTR_RELAYS, random = (n) => crypto.getRandomValues(new Uint8Array(n)), maxWait = 5000, fresh = false } = {}) {
  const up = await reachable(pool, relays, maxWait);
  if (!up.length) throw new Error('no Nostr relay answered: try again in a moment (your wallet is not made offline, so it cannot become a second one)');
  let found = null;
  if (!fresh) {
    const asked = await askEach(pool, up, { kinds: [SEED_KIND], authors: [signer.pubkey], '#d': [SEED_D] }, maxWait);
    // ONLY A SEED EVENT IS A SEED EVENT (kanban #3301, audit nostr-a5-1-1): a relay answering the ask with any newer event the player signed (the
    // kind 0 profile this page publishes, a note, another app's 30078) had it taken as the newest seed - it did not decrypt, and every login failed
    // while the game's relay held the real one. The relay's answer is checked against the filter it was asked: kind 30078 and d = bitcoin-arena/seed
    const isSeed = (e) => e && e.kind === SEED_KIND && Array.isArray(e.tags) && e.tags.some((t) => Array.isArray(t) && t[0] === 'd' && t[1] === SEED_D);
    found = asked.events.filter((e) => isSeed(e) && verifyEvent(e) && e.pubkey === signer.pubkey).sort((a, b) => b.created_at - a.created_at)[0];
    // kanban #1574: no seed event found is "a new account" only when EVERY relay reached finished its answer (EOSE) - one that
    // timed out or closed the query may hold the seed, and a new event would replace it (newest per author and d); and when
    // our relay is in the list it must be one of them (public relays prune NIP-78 app data, ours keeps it)
    if (!found && (asked.unanswered.length || (relays.includes(NOSTR_RELAYS[0]) && !up.includes(NOSTR_RELAYS[0]))))
      throw new Error(`your Nostr relays did not answer in time (${(asked.unanswered.length ? asked.unanswered : [NOSTR_RELAYS[0]]).join(', ')}): try again in a moment (no new wallet is made, so it cannot replace yours)`);
    // A SIGNER'S SEED IS RANDOM, SO THE GAME'S OWN RELAY MUST HAVE SAID "NOTHING" (kanban #2713, #1489 r4-nostr-6): the check above held
    // only for our default list - a list (the account's own relays) whose first relay, the one the seed is kept on, did not even connect let
    // another relay's empty answer mint a second random seed, published and taken by every later login: the wallet funded under the first
    // was no longer the account's. The list's first relay is the game's own (NOSTR_RELAYS[0] by default); without its answer no random seed
    // is made. An nsec's seed is derived (the same every time), so for it a relay out changes nothing.
    if (!found && signer.method !== 'nsec' && relays.length && !up.includes(relays[0]))
      throw new Error(`your game's Nostr relay (${relays[0]}) did not answer: try again in a moment (no new wallet is made, so it cannot replace yours)`);
  }
  if (found) {
    let plain;
    try { plain = await signer.decrypt(signer.pubkey, found.content); } catch (e) { throw new Error(`your game seed is on the relays but did not decrypt (${e.message}) - it is left as it is`); }
    let j; try { j = JSON.parse(plain); } catch { j = null; }
    if (!j || !/^[0-9a-f]{64}$/.test(j.seed || '')) throw new Error('your game seed event does not hold a seed - it is left as it is');
    return { seed: unhex(j.seed), created: false, from: 'relays', relays: up };
  }
  const seed = signer.method === 'nsec' ? derivedSeed(signer.secret) : random(32);
  const content = await signer.encrypt(signer.pubkey, JSON.stringify({ v: 1, game: 'bitcoin-arena', seed: hex(seed) }));
  const ev = await signer.signEvent({ kind: SEED_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', SEED_D]], content });
  // A SIGNER'S RANDOM SEED IS TAKEN INTO USE ONLY ONCE THE GAME'S OWN RELAY KEPT IT (kanban #3878, gap in #2713): #2713 made sure the list's first
  // relay ANSWERED the ask, not that it TOOK the new seed - with that relay answering 'rate-limited:' (its signature budget drained by a stranger)
  // or 'blocked: the relay is full' and one public relay taking it, the page showed and funded a wallet whose only copy sat on relays that prune
  // NIP-78 data, and the next login minted a second random seed. The game's relay is asked first and alone; only when it kept the event does it
  // go to the others, so a refused seed is spread nowhere and no relay can later hand it out. An nsec's seed is derived - any relay will do.
  let took;
  if (signer.method !== 'nsec' && relays.length) {
    took = await publishWithPow(pool, [relays[0]], ev, signer);   // kanban #2847: with proof of work where a relay asks for it
    if (!took.includes(relays[0])) throw new Error(`your game's Nostr relay (${relays[0]}) did not keep your new wallet seed: try again in a moment (no wallet was made)`);
    const rest = up.filter((u) => u !== relays[0]);
    if (rest.length) took.push(...await publishWithPow(pool, rest, ev, signer));
  } else took = await publishWithPow(pool, up, ev, signer);   // kanban #2847: with proof of work where a relay asks for it
  if (!took.length) throw new Error('no relay took your game seed: nothing was made, try again');
  return { seed, created: true, from: signer.method === 'nsec' ? 'derived' : 'random', relays: took };
}

/** The account's profile (kind 0): { name, picture } or null. */
export async function profileOf(pubkey, { pool = new SimplePool(), relays = NOSTR_RELAYS, maxWait = 3000 } = {}) {
  const ev = (await pool.querySync([...relays], { kinds: [0], authors: [pubkey] }, { maxWait })).filter((e) => verifyEvent(e)).sort((a, b) => b.created_at - a.created_at)[0];
  if (!ev) return null;
  try { const p = JSON.parse(ev.content); return { name: String(p.display_name || p.name || '').slice(0, 40), picture: /^https:\/\//.test(p.picture || '') ? p.picture : null }; } catch { return null; }
}
/** A new account's profile, so the lobby has a name to show: kind 0 { name }, published where the seed is. */
export async function publishProfile(signer, name, { pool = new SimplePool(), relays = NOSTR_RELAYS } = {}) {
  const ev = await signer.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: String(name).slice(0, 40) }) });
  return (await publishWithPow(pool, [...relays], ev, signer)).length;   // kanban #2847
}
export const npubOf = (pubkey) => nip19.npubEncode(pubkey);
export { SimplePool };
