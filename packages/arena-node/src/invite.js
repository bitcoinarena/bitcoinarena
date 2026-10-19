// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDIMINT INVITE THAT NAMES EVERY GUARDIAN (item 5, 2026-09-28: the testnet invite named guardian 1 alone, and while
// guardian 1 was down every player join failed "Failed to download client config" though six of seven were up).
//
// The stock invite code is bech32m, hrp "fed1", over a consensus-encoded Vec<InviteCodePart>: a Url part is variant 0,
// its length, then (url string, peer id); the FederationId part is variant 1, length 32, the id. A client downloads the
// config from any peer the invite names, so an invite naming all of them survives any one being down. The byte layout
// is the one `fedimint-cli invite-code` writes, measured on this federation's own invite, and an invite built here was
// joined by the stock client (fedimint-cli join-federation) while guardian 1 was down.
const CHARSET_invite = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M = 0x2bc830a3;
const polymod_invite = (values) => {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
};
const hrpExpand_invite = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
const toWords = (bytes) => {
  let acc = 0, bits = 0; const out = [];
  for (const x of bytes) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
};
const fromWords = (words) => {
  let acc = 0, bits = 0; const out = [];
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } acc &= (1 << bits) - 1; }
  return Uint8Array.from(out);
};
const HRP = 'fed1';

/** The invite naming `guardians` ([{ url, peer }], each url its API endpoint) of federation `federationId` (32 bytes). */
export function inviteForGuardians(federationId, guardians) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) throw new TypeError('a federation id is 32 bytes');
  if (!guardians.length || guardians.length > 250) throw new Error('an invite names 1 to 250 guardians');
  const parts = [];
  for (const { url, peer } of guardians) {
    const u = new TextEncoder().encode(url);
    if (u.length > 127 || !Number.isInteger(peer) || peer < 0 || peer > 127) throw new Error(`guardian ${peer} at ${url} does not fit a one-byte length and peer id`);
    const body = [u.length, ...u, peer];
    parts.push(0, body.length, ...body);
  }
  parts.push(1, 32, ...federationId);
  const words = toWords(Uint8Array.from([guardians.length + 1, ...parts]));
  const pm = polymod_invite([...hrpExpand_invite(HRP), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const check = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
  return `${HRP}1${[...words, ...check].map((w) => CHARSET_invite[w]).join('')}`;
}

/** What an invite names: its guardians' urls and peer ids, and its federation id (hex). Throws on a bad checksum. */
export function readInvite(invite) {
  const s = String(invite).trim().replace(/"/g, '').toLowerCase();
  const at = s.lastIndexOf('1');
  if (s.slice(0, at) !== HRP) throw new Error('not a fedimint invite (hrp fed1)');
  const words = [...s.slice(at + 1)].map((c) => CHARSET_invite.indexOf(c));
  if (words.some((w) => w < 0) || polymod_invite([...hrpExpand_invite(HRP), ...words]) !== BECH32M) throw new Error('the invite\'s checksum does not hold');
  const b = fromWords(words.slice(0, -6));
  const guardians = []; let federationId = null;
  let i = 1;
  for (let n = 0; n < b[0]; n++) {
    const variant = b[i], len = b[i + 1], body = b.subarray(i + 2, i + 2 + len);
    if (variant === 0) guardians.push({ url: new TextDecoder().decode(body.subarray(1, 1 + body[0])), peer: body[1 + body[0]] });
    if (variant === 1) federationId = Array.from(body, (x) => x.toString(16).padStart(2, '0')).join('');   // no Buffer: the owner page reads invites too
    i += 2 + len;
  }
  return { guardians, federationId };
}
