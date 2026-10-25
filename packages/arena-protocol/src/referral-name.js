// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REFERRAL PROGRAM'S NAME (kanban #675, 2026-10-25: "there will be a section in the node called Referrer where he can select a name for his
// program. He can have multiple ones and each earns the fees. It also shows in the explorer. In health there is a section which site earned
// what"). A program is a website payout key (an entry's frontend_pk, 33 bytes); its name is said by the key itself:
//
//     ReferralName { site, name, at_ms }   signed (BIP-340) by the site key's secret, verified against its x coordinate
//
// The newest record of a key is its name. A seat keeps it only when the signature verifies, and lists it beside what the key earned.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';

export const TAG_REFERRAL_NAME = 'ARENA/v1/ReferralName';
export const TYPE_REFERRAL_NAME = 0x52;          // 'R'
export const REFERRAL_NAME_MAX = 48;

export function encodeReferralName(r) {
  if (!(r.site instanceof Uint8Array) || r.site.length !== 33 || (r.site[0] !== 2 && r.site[0] !== 3)) throw new Error('a referral name names its 33-byte compressed site key');
  const name = String(r.name || '');
  if (!name || name !== name.trim() || name.length > REFERRAL_NAME_MAX || /[\u0000-\u001f]/.test(name)) throw new Error(`a program's name is 1 to ${REFERRAL_NAME_MAX} printable characters, with no space at either end`);
  const w = new Writer();
  w.u8(TYPE_REFERRAL_NAME); w.bytes(r.site, 33); w.str(name); w.u64(BigInt(r.atMs));
  return w.finish();
}

export function decodeReferralName(bytes) {
  const rd = new Reader(bytes);
  if (rd.u8() !== TYPE_REFERRAL_NAME) throw new Error('not a referral name');
  const r = { site: rd.bytes(33), name: rd.str(), atMs: rd.u64() };
  if (rd.at !== bytes.length) throw new Error('trailing bytes after the referral name');
  encodeReferralName(r);
  return r;
}

export const referralNameId = (r) => taggedHash(TAG_REFERRAL_NAME, encodeReferralName(r));

/** Whether a record stands: its signature by the site key (`verify(sig, msg, xonly)` BIP-340). { ok, id } or { ok: false, why }. */
export function referralNameStands(r, signature, { verify }) {
  let id;
  try { id = referralNameId(r); } catch (e) { return { ok: false, why: e.message }; }
  let good = false; try { good = verify(signature, id, r.site.subarray(1)) === true; } catch { good = false; }
  return good ? { ok: true, id } : { ok: false, why: 'the site key\'s signature does not verify' };
}
