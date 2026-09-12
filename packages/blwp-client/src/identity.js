// WHO THIS TAB IS IN THE LOBBY (M3.3-34): a key the page generated, a name
// made from that key, and the name the player chose instead, if they did.
//
// THE KEY COMES FROM THE TAB'S SEED - the seed every round's player key is
// derived from (§24, F2) - under its own tag (`identitySecretFor`), so it is
// never a round's key, and the seed backup the page already shows is the backup
// of this key too. The private half never leaves this module: the page is
// handed the public key and its fingerprint. Two tabs are two players, as they
// always were, because the seed is kept per tab.
//
// THE NAME DECIDES NOTHING. It is in no entry, no mark and no result; nothing a
// node replays reads it. The generated name is a function of the public key, so
// one key always shows one name, and a custom name is kept in the tab beside
// the seed - cleared, the generated one comes back.
//
// AND THE OTHER PLAYERS OF A ROUND ARE SHOWN IT: once seated, the tab hands the
// round's seats one record - this round, the round key it is seated under, its
// identity key, the name it chose (empty for none) - signed with that round key
// (lobby-name.js). The other pages check each record before they draw its name,
// so a seat can leave a name out but cannot write one, and nobody is shown a
// key in place of a name: no record, no name, only a count.
import { tabSeed, playerFor } from './join.js';
import { identitySecretFor } from '../../protocol/src/player-key.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { encodeLobbyName, decodeLobbyName, lobbyNameId, lobbyNameIsValid, LOBBY_NAME_MAX } from '../../protocol/src/lobby-name.js';

/** Where a tab keeps the name its player chose. */
export const CUSTOM_NAME_KEY = 'blwp.player.name';

/** The longest name a player may choose, in characters - the seats' rule too. */
export const PLAYER_NAME_MAX = LOBBY_NAME_MAX;

const NAME_ADJECTIVES = ['Swift', 'Steady', 'Bold', 'Quiet', 'Rusty', 'Lucky', 'Brave', 'Sly',
  'Iron', 'Amber', 'Frosty', 'Dusty', 'Keen', 'Calm', 'Wild', 'Noble', 'Stubborn', 'Nimble',
  'Sturdy', 'Gritty', 'Clever', 'Silent', 'Rapid', 'Loyal', 'Fierce', 'Gentle', 'Hardy', 'Jolly',
  'Mellow', 'Plucky', 'Rugged', 'Sharp'];
const NAME_NOUNS = ['Trucker', 'Courier', 'Hauler', 'Miner', 'Driver', 'Convoy', 'Carrier', 'Rover',
  'Pilot', 'Runner', 'Ranger', 'Trader', 'Porter', 'Scout', 'Rider', 'Nomad', 'Drifter', 'Freighter',
  'Mechanic', 'Navigator', 'Dispatcher', 'Loader', 'Teamster', 'Wrangler', 'Outrider', 'Pathfinder',
  'Shipper', 'Packer', 'Roadie', 'Voyager', 'Wanderer', 'Stoker'];

/** A name made from a public key: two words and four digits, the same for one key always. */
export function generatedName(pubkey) {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) throw new Error('a name is made from a 32-byte public key');
  const digits = ((pubkey[2] << 8) | pubkey[3]) % 10000;
  return `${NAME_ADJECTIVES[pubkey[0] % 32]}${NAME_NOUNS[pubkey[1] % 32]}-${String(digits).padStart(4, '0')}`;
}

/** 64 bits of the identity key, grouped, for a player to recognise it by. */
export const identityFingerprint = (pubkey) => toHex(pubkey.subarray(0, 8)).match(/.{4}/g).join('-');

/**
 * WHETHER A CHOSEN NAME STANDS, and the name as it is kept: the protocol's
 * rule (lobby-name.js), so a seat keeps exactly the names a page lets through.
 */
export const playerNameIsValid = lobbyNameIsValid;

/**
 * THE PLAYER'S OWN NAME, OVER THE GENERATED ONE - or, blank, back to the
 * generated one. A name that does not stand is refused and nothing is kept.
 */
export function setPlayerName(text, { storage } = {}) {
  if (!storage) throw new Error('a name is kept in the tab, and no storage was given');
  if (String(text == null ? '' : text).trim() === '') { storage.removeItem(CUSTOM_NAME_KEY); return { ok: true, custom: false }; }
  const checked = playerNameIsValid(text);
  if (!checked.ok) return checked;
  storage.setItem(CUSTOM_NAME_KEY, checked.name);
  return { ok: true, custom: true, name: checked.name };
}

/**
 * WHO THIS TAB IS: the identity key's public half and fingerprint, the
 * generated name, and the name shown - the player's own if they chose one.
 * The curve is injected, as everywhere in this bundle.
 */
export function tabIdentity({ storage, random, curve } = {}) {
  if (!curve || typeof curve.pointX !== 'function') throw new Error('an identity is a key on a curve, and none was injected');
  const seed = tabSeed({ storage, random });
  const pubkey = curve.pointX(identitySecretFor(seed));
  const generated = generatedName(pubkey);
  const kept = storage ? storage.getItem(CUSTOM_NAME_KEY) : null;
  const chosen = kept ? playerNameIsValid(kept) : null;
  const custom = !!(chosen && chosen.ok);
  return { pubkey, pubkeyHex: toHex(pubkey), fingerprint: identityFingerprint(pubkey), generated,
    name: custom ? chosen.name : generated, custom };
}

/**
 * THE NAME THIS TAB HANDS THE SEATS OF A ROUND IT IS SEATED IN: the round, the
 * round key it is seated under, its identity key, the name the player chose -
 * empty for none, and the others are then shown the generated one - and now,
 * signed with that round key. The others are shown what this tab shows itself.
 */
export function nameRecordFor(round, { storage, random, curve, nowMs = Date.now() } = {}) {
  if (!curve || typeof curve.signSchnorr !== 'function') throw new Error('a name is signed with the round key, and no signer was injected');
  const me = tabIdentity({ storage, random, curve });
  const player = playerFor(round, { seed: tabSeed({ storage, random }), curve });
  const record = { roundId: player.roundId, playerPubkey: player.pubkey, identityPubkey: me.pubkey,
    name: me.custom ? me.name : '', atMs: BigInt(Math.floor(nowMs)) };
  return { record: toHex(encodeLobbyName(record)), sig: toHex(curve.signSchnorr(lobbyNameId(record), player.secret)) };
}

/** The signed record, handed to every seat (POST /name); what each answered. */
export async function postName(signed, nodes, { fetcher = fetch } = {}) {
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/name`, { method: 'POST', body: JSON.stringify(signed) });
      said.push({ node, status: r.status });
    } catch (e) { said.push({ node, status: 0, why: e.message }); }
  }
  return said;
}

/** The name a checked record shows: the one its player chose, or the one made from its identity key. */
export const shownNameOf = (record) => record.name || generatedName(record.identityPubkey);

/**
 * ONE ROUND'S PLAYERS BY NAME, CHECKED: each record decodes, is for THIS round,
 * and verifies under the player key it names; a player's newest record wins.
 * Anything else is dropped, never shown. `verify` is BIP-340, injected.
 * @returns {{ player: string, name: string, chosen: boolean }[]} by player key
 */
export function checkedNames(items, roundIdHex, verify) {
  const newest = new Map();
  for (const x of Array.isArray(items) ? items : []) {
    let record;
    try {
      record = decodeLobbyName(fromHex(String(x && x.record)));
      if (toHex(record.roundId) !== String(roundIdHex).toLowerCase()) continue;
      if (!verify(fromHex(String(x.sig)), lobbyNameId(record), record.playerPubkey)) continue;
    } catch { continue; }
    const player = toHex(record.playerPubkey);
    const had = newest.get(player);
    if (!had || record.atMs > had.atMs) newest.set(player, record);
  }
  return [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([player, r]) => ({ player, name: shownNameOf(r), chosen: r.name !== '' }));
}

/** The names a round's seats keep (GET /names), checked as above. */
export async function namesOf({ roundId, nodes, fetcher = fetch, verify } = {}) {
  if (typeof verify !== 'function') throw new Error('names are checked against the players\' keys, and no verify was injected');
  const id = typeof roundId === 'string' ? roundId.toLowerCase() : toHex(roundId);
  const items = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/names?round=${id}`);
      if (!r.ok) continue;
      const body = await r.json();
      if (body && Array.isArray(body.names)) items.push(...body.names);
    } catch { /* a seat that does not answer is one of several */ }
  }
  return checkedNames(items, id, verify);
}
