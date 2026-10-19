// THE NETWORK BEFORE THIS ONE, AS ITS CHAIN STILL CARRIES IT (spec 0A.9, §27A.8.32026-10-08).
//
// Every wire tag moved from BLWP/v1/... to ARENA/v1/.... What was already on Bitcoin did not: testnet4's
// seven bonds pay the BLWP bond marker's dust and commit to an advertisement under the BLWP advert tag, in the
// advertisement layout of before hosted_games. 0A.9 keeps those bonds - "a confirmed bond stays the bond" -
// by re-affirmation (reaffirm.js) and an advertisement update naming hosted_games[]. So the census must still be able to
// FIND and READ them; these are the ancestor's facts it reads them by, frozen, never written by anything new:
//
//   - its bond marker:   taggedHash('BLWP/v1/BOND_MARKER', network)  (regtest; 'testnet' for testnet4)
//   - its advert id:     taggedHash('BLWP/v1/Advert', body)
//   - its advert layout: today's, without the hosted_games vector (a u16 count) before the timestamp
//   - the player wallet's root: taggedHash('BLWP/v1/PlayerWalletSecret', seed || federation) - the page moves a seed's
//     e-cash from that wallet into the Arena one (index.html combineWallets; spec 0A.9 "the e-cash carries over")
//
// Mainnet has no ancestor: it starts as Bitcoin Arena.
import { taggedHash } from './hash.js';
import { decodeAdvert } from './advert.js';

export const ANCESTOR_TAG = Object.freeze({
  advert: 'BLWP/v1/Advert',
  bondMarker: 'BLWP/v1/BOND_MARKER',
  playerWalletSecret: 'BLWP/v1/PlayerWalletSecret',
});

const utf8Bytes = (s) => new TextEncoder().encode(s);

/** Whether `network` had a BLWP ancestor whose bonds can be carried (regtest and testnet4; never mainnet). */
export function hasAncestor(network) {
  return network === 'regtest' || network === 'testnet' || network === 'testnet4';
}

/** The ancestor's bond marker program for `network` (32 bytes), as its bonds paid it; null where there is no ancestor. */
export function ancestorMarker(network) {
  if (!hasAncestor(network)) return null;
  return taggedHash(ANCESTOR_TAG.bondMarker, utf8Bytes(network === 'regtest' ? 'regtest' : 'testnet'));
}

/** The ancestor's id of a signed advertisement body: its tagged hash, as the bond committed to it. */
export function ancestorAdvertId(body) {
  if (!(body instanceof Uint8Array)) throw new TypeError('an advertisement body is bytes');
  return taggedHash(ANCESTOR_TAG.advert, body);
}

/**
 * The ancestor's advertisement layout read: the body as today's decoder would read it with an empty hosted_games
 * (its u16 count, 0, put back before the 8-byte timestamp). Every other field and every refusal is today's decoder's
 * own. The answer hosts no game: an ancestor advertisement never named one.
 */
export function decodeAncestorAdvert(body) {
  if (!(body instanceof Uint8Array) || body.length < 10) throw new Error('not an advertisement of the ancestor');
  const withGames = new Uint8Array(body.length + 2);
  withGames.set(body.subarray(0, body.length - 8), 0);
  withGames.set(body.subarray(body.length - 8), body.length - 8 + 2);
  const advert = decodeAdvert(withGames);
  if (advert.hostedGames.length) throw new Error('not an advertisement of the ancestor');
  return advert;
}
