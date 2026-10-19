// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 0.12 DISPLAY NAME. Identity is the player key. The name is presentation.
//
// 2026-09-08 18:55 (M3): default name is derived from the key so every
// client shows the same string for the same player. A player may override it.
// The override lives next to the secret in the browser, not on the signed
// final, so the board still cannot be injected with a name (letter 20).
// Donation LNURL comments carry the player public key as hex, not the name
// (2026-09-08 18:59).
//
//   default = adjective-animal-NNNN
//   digest  = taggedHash('ARENA/v1/DISPLAY_NAME', playerPubkey)
//
// Two wordlists would name one player twice, which is why this file exists
// rather than letting a client invent one.

import { taggedHash, toHex } from './hash.js';

export const DISPLAY_NAME_TAG = 'ARENA/v1/DISPLAY_NAME';
export const DISPLAY_NAME_MAX = 32;

export const ADJECTIVES = Object.freeze([
  'amber', 'azure', 'bold', 'brave', 'brisk', 'calm', 'cool', 'coral',
  'crisp', 'dark', 'dawn', 'deep', 'dry', 'dusk', 'eager', 'even',
  'fair', 'firm', 'flat', 'glad', 'gold', 'grim', 'harsh', 'holy',
  'icy', 'idle', 'iron', 'jade', 'jolly', 'keen', 'kind', 'late',
  'loud', 'lush', 'merry', 'mild', 'mint', 'neat', 'near', 'noble',
  'odd', 'open', 'pale', 'plain', 'proud', 'quick', 'quiet', 'rapid',
  'rare', 'royal', 'safe', 'sharp', 'silent', 'steel', 'swift', 'tall',
  'true', 'urban', 'vast', 'vivid', 'warm', 'wild', 'young', 'zinc',
]);

export const ANIMALS = Object.freeze([
  'otter', 'hawk', 'wolf', 'bear', 'fox', 'lynx', 'stag', 'elk',
  'moose', 'swan', 'crow', 'raven', 'dove', 'lark', 'wren', 'pike',
  'perch', 'trout', 'carp', 'bass', 'eel', 'crab', 'seal', 'whale',
  'shark', 'ray', 'frog', 'toad', 'newt', 'deer', 'boar', 'ram',
  'colt', 'mare', 'ox', 'yak', 'ape', 'bat', 'cub', 'doe',
  'emu', 'gnu', 'hen', 'hog', 'jay', 'owl', 'pup', 'sow',
  'asp', 'bee', 'cat', 'cow', 'dog', 'fly', 'goat', 'hare',
  'ibis', 'koi', 'mole', 'puma', 'rook', 'tern', 'orca', 'kiwi',
]);

if (ADJECTIVES.length !== 64 || ANIMALS.length !== 64) {
  throw new Error('display-name wordlists must be 64 each');
}
if (new Set(ADJECTIVES).size !== 64 || new Set(ANIMALS).size !== 64) {
  throw new Error('display-name wordlists must be unique');
}

function requirePubkey(playerPubkey) {
  if (!(playerPubkey instanceof Uint8Array) || playerPubkey.length !== 32) {
    throw new Error('a display name is derived from a 32-byte player key');
  }
}

/** Default name every client derives for this key. adjective-animal-NNNN */
export function displayNameFromKey(playerPubkey) {
  requirePubkey(playerPubkey);
  const d = taggedHash(DISPLAY_NAME_TAG, playerPubkey);
  const adj = ADJECTIVES[d[0] & 63];
  const animal = ANIMALS[d[1] & 63];
  const num = ((d[2] << 8) | d[3]) % 10000;
  return adj + '-' + animal + '-' + String(num).padStart(4, '0');
}

/**
 * A custom name the player typed. Empty / invalid means "use the default".
 * No em dash. Max 32. Printable ASCII letters, digits, space, dot, _ -.
 */
export function normalizeDisplayName(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.length > DISPLAY_NAME_MAX) return null;
  if (/[—–]/.test(s)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,31}$/.test(s)) return null;
  return s;
}

/** Name to show on the board and in the client. Not the donation comment. */
export function displayNameFor(playerPubkey, custom) {
  return normalizeDisplayName(custom) || displayNameFromKey(playerPubkey);
}

/** LNURL-pay comment: the player public key as hex. Not the display name. */
export function donationCommentFor(playerPubkey, commentAllowed = 140) {
  requirePubkey(playerPubkey);
  const hex = toHex(playerPubkey);
  const max = Number(commentAllowed);
  if (!Number.isFinite(max) || max < hex.length) return '';
  return hex;
}

/**
 * What the browser stores. secretKey never leaves the machine except via the
 * player's own backup download. displayName null = derive from the key.
 */
export function playerStoreRecord({ secretKey, displayName = null }) {
  requirePubkey(secretKey);
  return {
    version: 1,
    secretKey: toHex(secretKey),
    displayName: normalizeDisplayName(displayName),
  };
}
