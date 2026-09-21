// THE BACKUP GATE (§24B): no first deposit and no first paid join until the whole phrase has been
// typed back once, in order, and checked.
//
// The lobby line is the warning; this is what makes the warning true. A warning a player can click past
// is a warning about somebody else's money - by the time it matters the seed is gone and there is nothing
// to recover from. So the two acts that put money INTO the player's own custody are refused until one
// full-phrase verification has succeeded.
//
// WHAT IS NOT GATED, and deliberately: a FREE round. It stakes nothing, so a player who has not backed up
// anything cannot lose anything by playing one, and making him copy twelve words before he may drive is
// a tax on the one thing he can safely do. Free rounds start unverified, with no backup and no NWC.
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

export const VERIFIED_KEY = 'blwp.backup.verified';

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

/** Has one full-phrase verification ever succeeded in this browser? */
export function isVerified(storage) {
  try { return storage.getItem(VERIFIED_KEY) === '1'; } catch { return false; }
}

/** Record that it has. Only `verifyPhrase` saying ok should reach this. */
export function recordVerified(storage) {
  try { storage.setItem(VERIFIED_KEY, '1'); return true; } catch { return false; }
}

/**
 * The one call the page makes for a typed phrase: check it, and record it only if it was right.
 * A wrong word never sets the flag, so a near miss leaves the gate exactly where it was.
 */
export function verifyAndRecord({ typed, phrase, storage }) {
  const said = verifyPhrase(typed, phrase);
  if (!said.ok) return said;
  return { ok: true, recorded: recordVerified(storage) };
}

/** What the lobby's first line and the Settings screen say until a verification has succeeded. */
export const NO_BACKUP_LINE = 'There is no backup of this wallet yet - write the phrase down in Settings';
export function backupLine(storage) {
  return isVerified(storage) ? '' : NO_BACKUP_LINE;
}

/**
 * THE GATE. `why` is what the player is told, and it names the way out.
 */
function refuse() {
  return { ok: false, why: 'Type your seed phrase back in Settings first - this wallet has no backup yet' };
}
export const mayDeposit = (storage) => (isVerified(storage) ? { ok: true } : refuse());
export const mayPayStake = (storage) => (isVerified(storage) ? { ok: true } : refuse());
/** A free round stakes nothing, so it never asks. */
export const mayStartFreeRound = () => ({ ok: true });

/**
 * MAY THIS ROUND BE JOINED? One door for the lobby, so a paid round and a free one cannot drift apart.
 * `paying` is the round's own answer (BLWPCLIENT.roundPays), never this file's guess.
 */
export function mayJoin({ paying, storage }) {
  return paying ? mayPayStake(storage) : mayStartFreeRound();
}
