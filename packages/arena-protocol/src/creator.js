// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND'S CREATOR (§6 `creator_pubkey` / `creator_signature`2026.0.3). A contract may name the x-only key of whoever
// created it (contracts.js CREATOR_MARKER); the creator's BIP-340 signature over the round's id rides beside the contract, as the id
// itself does - a signature cannot be inside the bytes it signs. "The creator gains no administrative power after publication - and
// no influence over the committee either": the key says WHO published the round (whom a publication fee is paid back to),
// and nothing else. A contract that names no creator needs no signature, and none is asked of it.
//
// No curve here: the verifier is the caller's (the seat's noble schnorr, the page's ARENA_CURVE), as for every signed record.
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';
import { roundId } from './contracts.js';

/** What the creator signs: the round's id under its own tag. */
export const creatorMessage = (roundIdBytes) => taggedHash(TAG.roundCreator, roundIdBytes);

/**
 * DOES THIS SIGNATURE STAND FOR THIS CONTRACT? `verify(sig, msg, xOnlyKey)` BIP-340. { ok, why }: a contract naming no creator
 * stands with none (and refuses one handed anyway - there is nobody it could be from); one naming a creator stands only with a
 * 64-byte signature by that key over its id.
 */
export function creatorSignatureStands(contract, signature, { verify }) {
  const named = contract && contract.creatorPubkey instanceof Uint8Array;
  if (!named) return signature ? { ok: false, why: 'that round names no creator, so no creator signature belongs to it' } : { ok: true, why: 'that round names no creator' };
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return { ok: false, why: 'that round names its creator, and comes without the creator\'s 64-byte signature over its id' };
  let good = false;
  try { good = !!verify(signature, creatorMessage(roundId(contract)), contract.creatorPubkey); } catch { good = false; }
  return good ? { ok: true, why: 'signed by the creator the round names' } : { ok: false, why: 'that signature is not the named creator\'s over this round\'s id' };
}

/**
 * A SERIES THAT NAMES ITS CREATOR: one signature over the SERIES id stands for every round of it - a grid of
 * 10,800 rounds is published by one transaction and posted as one line, so it is signed once. The template's creator key is in
 * the series id (it is in the template's bytes), so the signature binds the creator to every round the series makes. `seriesIdOf`
 * is series.js seriesId (injected: series.js imports this package's contracts, as this file does). { ok, why } as above.
 */
export const seriesCreatorMessage = (seriesIdBytes) => taggedHash(TAG.seriesCreator, seriesIdBytes);
export function seriesCreatorStands(template, signature, { verify, seriesIdOf }) {
  const named = template && template.creatorPubkey instanceof Uint8Array;
  if (!named) return signature ? { ok: false, why: 'that series names no creator, so no creator signature belongs to it' } : { ok: true, why: 'that series names no creator' };
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return { ok: false, why: 'that series names its creator, and comes without the creator\'s 64-byte signature over its id' };
  let good = false;
  try { good = !!verify(signature, seriesCreatorMessage(seriesIdOf(template)), template.creatorPubkey); } catch { good = false; }
  return good ? { ok: true, why: 'signed by the creator the series names' } : { ok: false, why: 'that signature is not the named creator\'s over this series\' id' };
}
