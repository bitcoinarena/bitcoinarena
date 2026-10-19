// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BACKUP WARNING (§24B, as ruled 2026-09-21 20:01): nothing is refused, and the player is told.
//
// An earlier cut of this file GATED the first deposit and the first paid join on the phrase being typed
// back. That is overridden: PLAY is always allowed, free or paid, and so is putting money in. What stands
// in the lobby instead is a large warning with its own Backup button, and it stays until one full-phrase
// verification has succeeded.
//
// So `mayDeposit` and `mayPayStake` are gone rather than left exported and unused - a refusal nothing
// calls is a rule somebody will wire back up by accident. What is left is what the warning needs: is this
// seed backed up, and did the player type its phrase back correctly.
//
// WHERE THE FLAG LIVES, and why that is not a hole. It is the player's own browser. A player who clears
// it and re-verifies has only made himself type the words again; a player who forges it has unlocked his
// OWN deposit against his OWN warning. This gate protects the player from losing his money, not the
// operator from the player - so there is nothing here for a node to check and nothing to forge that
// costs anybody else a satoshi. A rule the node must enforce is a different rule and is not this one.
//
// THE PHRASE ITSELF IS NOT THIS FILE'S. Whatever encodes a seed into words hands it in; this checks what
// was typed against it. That keeps the check honest about one thing only - did he write them down - and
// keeps a wordlist's correctness where it belongs.

import { sha256, toHex } from '../../arena-protocol/src/hash.js';

export const VERIFIED_KEY = 'arena.backup.verified';

/**
 * THE FLAG IS BOUND TO THE SEED IT VERIFIED, AND THAT IS NOT A DETAIL.
 *
 * Measured on the first cut of this file: the seed lives in sessionStorage (`tabSeed` mints a fresh 32
 * bytes when it finds none), so a new tab is a NEW WALLET - while a bare "verified" flag in localStorage
 * outlives every tab. Verify once, open a second tab, and a wallet nobody has ever written down would
 * have been allowed to deposit and to stake. The gate would have been answering about a wallet that no
 * longer existed.
 *
 * So what is recorded is a digest of the seed that was verified, and the gate opens only when the seed in
 * hand hashes to it. A new seed is unverified however many older ones were not.
 */
export const digestOf = (seed) => (seed instanceof Uint8Array && seed.length === 32
  ? toHex(sha256(seed)) : null);

/** One word, as a comparison sees it: case and stray spacing are the player's, not the phrase's. */
const normalise = (word) => String(word || '').trim().toLowerCase();

/** The phrase as a list of words, from a string or a list. */
export const wordsOf = (phrase) => (Array.isArray(phrase)
  ? phrase.map(normalise) : normalise(phrase).split(/\s+/)).filter(Boolean);

/**
 * EVERY WORD, IN ORDER, ALL OF THEM (§24B; §23A.8's three-word check is withdrawn).
 *
 * A player who can produce three of twelve has not shown he wrote twelve down, and three is exactly what
 * somebody copying a screenshot has. What is checked here is what would actually restore the wallet.
 *
 * The answer says WHERE the first wrong word is, because a player who mistyped word nine wants to know
 * that and an attacker learns nothing he did not type himself.
 */
export function verifyPhrase(typed, phrase) {
  const want = wordsOf(phrase);
  const got = wordsOf(typed);
  if (!want.length) return { ok: false, why: 'there is no phrase to check against' };
  if (!got.length) return { ok: false, why: 'type the whole phrase back, every word, in order' };
  if (got.length !== want.length)
    return { ok: false, why: `that is ${got.length} words and the phrase is ${want.length}`, wrongAt: null };
  for (let i = 0; i < want.length; i++)
    if (got[i] !== want[i]) return { ok: false, why: `word ${i + 1} is not the one in the phrase`, wrongAt: i };
  return { ok: true };
}

/** Has THIS seed's phrase been typed back in full, once, in this browser? */
export function isVerified(storage, seed) {
  const want = digestOf(seed);
  if (!want) return false;
  try { return storage.getItem(VERIFIED_KEY) === want; } catch { return false; }
}

/** Record that it has, against the seed it was. Only `verifyPhrase` saying ok should reach this. */
export function recordVerified(storage, seed) {
  const want = digestOf(seed);
  if (!want) return false;
  try { storage.setItem(VERIFIED_KEY, want); return true; } catch { return false; }
}

/**
 * The one call the page makes for a typed phrase: check it, and record it only if it was right.
 * A wrong word never sets the flag, so a near miss leaves the gate exactly where it was.
 */
export function verifyAndRecord({ typed, phrase, storage, seed }) {
  const said = verifyPhrase(typed, phrase);
  if (!said.ok) return said;
  return { ok: true, recorded: recordVerified(storage, seed) };
}

/** What the lobby's first line and the Settings screen say until a verification has succeeded. */
export const NO_BACKUP_LINE = 'This wallet has no backup. Lose this browser and the money in it is gone - '
  + 'write your 24 words down now.';
export function backupLine(storage, seed) {
  return isVerified(storage, seed) ? '' : NO_BACKUP_LINE;
}


