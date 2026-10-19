// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE PLAYER'S DONATION, CHOSEN ON THE PAGE (M3.2 item 6e, §22A; ruled
 * 2026-09-13).
 *
 * The donation is the player's choice and nobody else's: "Nodes, round
 * creators, lobbies and settlement participants may not overwrite, increase or
 * substitute the player's choice" (§22A). It is a share of the stake the player
 * commits, and it comes OUT of that stake - never on top - so it is one of the
 * three numbers `netStakeMsat` subtracts, and the payout table weighs the
 * player by what is left (commit 1).
 *
 * Asked in the browser's own prompt, like the name: a phone's keyboard types
 * into it, and Unity only draws. Default 0 - a player who presses nothing, or
 * cancels, donates nothing. Above 5% the page asks a SECOND time ("the client
 * MUST require an explicit second confirmation above 500 bps", §22A), so no
 * single answer writes more than 5%.
 *
 * MEASURED BEFORE: the page could not write a donation at all - `entryFor`
 * took no donation and wrote `donationMsat: 0n` on every entry, the page had no
 * donation prompt and no confirm, and its lock amount assumed 0: a 2% donor's
 * lock would have held 98000 msat where the signer node's check wants the net, 96000.
 * The signer node's door already took and stored a 2% donor's entry (201).
 *
 * Paying the recipients is `donation-pay.js`: the page fetches the set the
 * round's signer nodes serve, lists every recipient in this prompt, and pays each its
 * share over LNURL once the signer nodes have taken the entry.
 */
import { entryFeeMsat, feeMatchesEntry } from '../../arena-protocol/src/fee.js';

/** Above this many basis points of the stake (5%) the page asks a second time (§22A). */
export const DONATION_CONFIRM_BPS = 500;
/**
 * THE DONATION A PLAYER IS OFFERED (§0A.8, RULED 2026-10-06): one choice of 0 1 2 3 4 5 %, DEFAULT 5% -
 * half to the protocol devs, half to the game dev (donation.js splitTwoSets). More than 5% only past §22A's second
 * confirmation (DONATION_CONFIRM_BPS).
 */
export const DONATION_DEFAULT_BPS = 500;
export const DONATION_CHOICES_BPS = Object.freeze([0, 100, 200, 300, 400, 500]);

/** A typed percent - "2", "2.5", "2%", "0,5" - as whole basis points, or why it is not one. */
function percentAsBps(typed) {
  if (typed === null || typed === undefined) return { ok: true, bps: 0 };
  const s = String(typed).trim().replace(/%$/, '').trim().replace(',', '.');
  if (s === '') return { ok: true, bps: 0 };
  const m = s.match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return { ok: false, why: `"${String(typed).slice(0, 24)}" is not a percent - type a number such as 0, 1 or 2.5` };
  const bps = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (bps > 10000) return { ok: false, why: 'a donation is at most 100% of the stake' };
  return { ok: true, bps };
}

/** The donation `bps` of a stake is, in msat - floored, never rounded up. */
const bpsOf = (stakeMsat, bps) => (stakeMsat * BigInt(bps)) / 10000n;

/**
 * ONE ANSWER, JUDGED. `typed` is what the prompt returned; `confirm(message)` is
 * asked only above 5% and must answer `true` for such a donation to stand. The
 * donation must still leave the fee inside the stake (the signer node's own rule,
 * `feeMatchesEntry`). Returns `{ ok, bps, donationMsat, netMsat }` or why not.
 */
export function donationChoice({ typed, stakeMsat, confirm } = {}) {
  if (typeof stakeMsat !== 'bigint' || stakeMsat < 0n) return { ok: false, why: 'a donation is a share of a BigInt millisatoshi stake' };
  const p = percentAsBps(typed);
  if (!p.ok) return p;
  const donationMsat = bpsOf(stakeMsat, p.bps);
  if (p.bps > DONATION_CONFIRM_BPS) {
    const sure = typeof confirm === 'function'
      && confirm(`A donation of ${p.bps / 100}% is ${donationMsat / 1000n} sat of your ${stakeMsat / 1000n} sat stake - `
        + 'more than 5%. It comes out of your stake. Donate that much?') === true;
    if (!sure) return { ok: false, bps: p.bps, why: `${p.bps / 100}% is above 5% and was not confirmed a second time, so nothing was written` };
  }
  const fee = feeMatchesEntry({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat });
  if (!fee.ok) return { ok: false, bps: p.bps, why: fee.why };
  return { ok: true, bps: p.bps, donationMsat, netMsat: fee.net };
}

const keyFor = (roundIdHex) => `arena.donation.${roundIdHex}`;

/**
 * THE DONATION THIS TAB ALREADY KEPT FOR A ROUND, read only: `{ ok, bps, donationMsat, netMsat, kept: true }`, or null when
 * none is kept (or the kept one no longer leaves the fee inside the stake). chooseDonation answers it before asking.
 */
export function keptDonation({ roundIdHex, stakeMsat, storage } = {}) {
  if (!roundIdHex || !storage) return null;
  let kept = null;
  try { kept = storage.getItem(keyFor(roundIdHex)); } catch { kept = null; }
  if (kept === null || kept === undefined || !/^\d{1,5}$/.test(String(kept)) || Number(kept) > 10000) return null;
  const donationMsat = bpsOf(stakeMsat, Number(kept));
  const fee = feeMatchesEntry({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat });
  return fee.ok ? { ok: true, bps: Number(kept), donationMsat, netMsat: fee.net, kept: true } : null;
}

/**
 * THE DONATION A DEPOSIT FOR A ROUND IS SIZED BY (2026-10-05): the one the join will write - the
 * round's kept choice when this tab has one, else the Settings percent. Before, the settings deposit always took Settings,
 * so a round joined at 2% with Settings since moved to 3% was quoted 1% of its stake too much (1% to 3%: 2% short). Reads
 * only; it keeps nothing.
 */
// `stake`, not `stakeMsat`: the page that calls this names no contract field (join.test.js "invents none").
export function depositDonationMsat({ roundIdHex, stake, settingsBps, storage } = {}) {
  const kept = keptDonation({ roundIdHex, stakeMsat: BigInt(stake), storage });
  return kept ? kept.donationMsat : bpsOf(BigInt(stake), Number(settingsBps));
}

/**
 * THE DONATION FOR THIS ROUND IN THIS TAB: the one already chosen, or asked.
 *
 * KEPT, because a reload over a stake lock this tab already made must write the
 * same donation - the lock holds the net, and a different donation is a
 * different net the signer node would refuse. Kept in the tab's own storage only.
 * `ask(message, default)` is the prompt (null = cancel = none); up to `tries`
 * answers are judged; with none standing, the donation is 0.
 */
export function chooseDonation({ roundIdHex, round, stakeMsat, ask, confirm, storage, tries = 3, recipientsLine = '' } = {}) {
  // THE STAKE IS THE ROUND'S, read here - the page names no amount of its own
  // (it joins a round, it does not write one).
  if (stakeMsat === undefined && round) stakeMsat = BigInt(round.stakeMsat || 0n);
  const none = { ok: true, bps: 0, donationMsat: 0n, netMsat: null };
  const keep = (c) => { try { if (storage) storage.setItem(keyFor(roundIdHex), String(c.bps)); } catch { /* a tab that keeps nothing asks again */ } return c; };
  const kept = keptDonation({ roundIdHex, stakeMsat, storage });
  if (kept) return kept;
  if (typeof ask !== 'function') return keep(none);
  let why = '';
  for (let i = 0; i < tries; i++) {
    // EVERY RECIPIENT IS SHOWN BEFORE THE WALLET APPROVES (§22A): the page passes
    // the set it checked, and the prompt lists it.
    const typed = ask(`${why ? `${why}\n\n` : ''}${recipientsLine ? `${recipientsLine}\n\n` : ''}Donation to the developers, in percent of your ${stakeMsat / 1000n} sat stake. `
      + 'It comes out of the stake, not on top. 0 = none; above 5% asks again.', '0');
    if (typed === null || typed === undefined) return keep(none);          // cancel: none
    const c = donationChoice({ typed, stakeMsat, confirm });
    if (c.ok) return keep(c);
    why = c.why;
  }
  return keep({ ...none, why: `no answer stood (${why}), so the donation is 0` });
}
