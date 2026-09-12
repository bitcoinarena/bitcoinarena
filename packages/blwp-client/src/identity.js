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
import { tabSeed } from './join.js';
import { identitySecretFor } from '../../protocol/src/player-key.js';
import { toHex } from '../../protocol/src/hash.js';

/** Where a tab keeps the name its player chose. */
export const CUSTOM_NAME_KEY = 'blwp.player.name';

/** The longest name a player may choose, in characters. */
export const PLAYER_NAME_MAX = 24;

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
 * WHETHER A CHOSEN NAME STANDS, and the name as it is kept: trimmed, inner
 * spaces collapsed, 1 to 24 characters, letters and digits with space, dot,
 * dash and underscore between them. Anything else is refused by name.
 */
export function playerNameIsValid(text) {
  const name = String(text == null ? '' : text).normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, why: 'a name is at least one character' };
  if ([...name].length > PLAYER_NAME_MAX) return { ok: false, why: `a name is at most ${PLAYER_NAME_MAX} characters` };
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u.test(name))
    return { ok: false, why: 'a name is letters and digits, with space, dot, dash or underscore between them' };
  return { ok: true, name };
}

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
