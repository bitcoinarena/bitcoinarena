// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME'S DESCRIPTION AND WEBSITE, SIGNED BY ITS DEVELOPER (2026-10-11: "Das Manifest soll auch eine
// Description und Webseite haben die signiert wird, die hier angezeigt wird"; and ~06:55Z: "Mach es so dass beide hashes
// akzeptiert werden - mit URL und ohne URL, mit Description und ohne").
//
// THEY TRAVEL BESIDE THE MANIFEST, NOT IN ITS BYTES. game_id = H(manifest body || signature) (manifest.js gameIdOf), and
// the seats' advertisements, every published series and every market name those ids. So the info is its own small object:
// the developer key the manifest names signs H(game_id || description || website), and a manifest with it and the same
// manifest without it are one game with one id. An info whose signature does not stand is shown as unsigned, never trusted.
//
// AND WHERE TIPS GO (tips to developers): a Lightning address (name@host, LUD-16) the developer signs
// beside the two strings. It is appended to the digest only when there is one, so every info signed before it - with no
// address - keeps its digest byte for byte and still stands. A tip is the player's own wallet paying that address (zap.js).
import { Writer } from './encode.js';
import { lightningAddressEndpoint } from './lnurl-pay.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { TAG } from './constants.js';

export const GAME_INFO_DESCRIPTION_MAX = 500;
export const GAME_INFO_WEBSITE_MAX = 200;
export const GAME_INFO_SIGNATURE_BYTES = 64;
export const GAME_INFO_LIGHTNING_MAX = 120;

/**
 * Refused by name: a description of 0..500 characters, a website that is empty or an https:// address of up to 200, and a
 * tip address that is empty or a Lightning address (name@host, lower case) of up to 120.
 */
export function gameInfoFits({ description = '', website = '', lightning = '' } = {}) {
  if (typeof description !== 'string' || description.length > GAME_INFO_DESCRIPTION_MAX)
    return { ok: false, why: `a game's description is a string of at most ${GAME_INFO_DESCRIPTION_MAX} characters` };
  if (typeof website !== 'string' || website.length > GAME_INFO_WEBSITE_MAX || (website !== '' && !/^https:\/\/[^\s/]+(\/\S*)?$/.test(website)))
    return { ok: false, why: `a game's website is empty or an https:// address of at most ${GAME_INFO_WEBSITE_MAX} characters` };
  if (typeof lightning !== 'string' || lightning.length > GAME_INFO_LIGHTNING_MAX
    || (lightning !== '' && (!lightningAddressEndpoint(lightning).ok || lightning !== lightning.trim().toLowerCase())))
    return { ok: false, why: `a game's tip address is empty or a Lightning address (name@host, lower case) of at most ${GAME_INFO_LIGHTNING_MAX} characters` };
  return { ok: true };
}

/** The digest the developer key signs: this game's id, then its description and website, then its tip address if it has one. */
export function gameInfoDigest(gameId, info) {
  if (!(gameId instanceof Uint8Array) || gameId.length !== 32) throw new Error('a game id is 32 bytes');
  const fits = gameInfoFits(info);
  if (!fits.ok) throw new Error(fits.why);
  const w = new Writer();
  w.bytes32(gameId); w.str(info.description || ''); w.str(info.website || '');
  if (info.lightning) w.str(info.lightning);
  return taggedHash(TAG.gameInfo, w.finish());
}

/**
 * WHAT A READER SHOWS for a game: its description and website when the manifest's developer key signed them for this game
 * id, else nothing of them (`signed: false` and why). `info` is { description, website, signature (hex or bytes) }.
 */
export function gameInfoStands(info, { gameId, manifest, verify } = {}) {
  if (!info) return { ok: false, signed: false, why: 'this game carries no description' };
  let sig;
  try { sig = info.signature instanceof Uint8Array ? info.signature : fromHex(String(info.signature || '')); } catch { sig = null; }
  if (!sig || sig.length !== GAME_INFO_SIGNATURE_BYTES) return { ok: false, signed: false, why: 'its description carries no 64-byte signature' };
  let digest;
  try { digest = gameInfoDigest(gameId, info); } catch (e) { return { ok: false, signed: false, why: e.message }; }
  let good = false;
  try { good = verify(sig, digest, manifest.gameDevPubkey) === true; } catch { good = false; }
  if (!good) return { ok: false, signed: false, why: `its description is not signed by the developer key ${toHex(manifest.gameDevPubkey).slice(0, 16)}` };
  return { ok: true, signed: true, description: info.description || '', website: info.website || '', lightning: info.lightning || '' };
}

/** The info as JSON carries it: the strings (the tip address only when there is one) and the signature in hex. */
export const gameInfoJson = (info) => (info ? { description: info.description || '', website: info.website || '',
  ...(info.lightning ? { lightning: info.lightning } : {}),
  signature: info.signature instanceof Uint8Array ? toHex(info.signature) : String(info.signature || '') } : null);

/** What the network store calls a manifest's kind: a replayed or head-to-head game, or an attested market (§0A.7a). */
export const gameTypeOf = (m) => (m && m.resultType === 2 ? 'market' : m && m.resultType === 3 ? 'head-to-head game' : 'game');
