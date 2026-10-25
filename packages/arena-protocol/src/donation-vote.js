// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' OWN BALLOT (§27A.4.12026-10-16: "I can propose to add a third person so instead of
// 66,33 it would perhaps be 60,20,10%. This donation set change works without changing the network id and becomes active
// immediately for all new rounds (not old rounds) after being confirmed by 50.01% of the currently active dev sets. The ui
// includes a proposal ui so one of the devs can propose something and another dev sees it in his ui and can click accept or
// deny. As soon as the threshold is hit it becomes active. Nodes accept it immediately.").
//
//     DonationProposal { network_id, serial, parent_set_id, entries[] }      signed by a recipient of the parent set
//     DonationApproval { proposal_id, at_height, accept }                     signed by a recipient of the parent set
//
// A proposal is APPROVED at the first accepting approval - in at_height order, then key - after which the accepting
// recipients hold more than half of the parent's share_bps; it is then a donation set in force from that approval's
// at_height + 1, ordered against the admin key's sets by serial like any other (authority.js). Refused once the denying
// recipients hold half or more. `parent_set_id` is donationSetId of the parent's entries: the set a round names (22A).
//
// Signatures are secp256k1 over the tagged digest, by the 33-byte recipient key; the verifier is injected, as every
// verifier in this package is: `verifySecp256k1(sig, digest, pubkey)` answers a boolean (or a promise of one).
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_DONATION_PROPOSAL, TYPE_DONATION_APPROVAL, TAG } from './constants.js';
import { encodeDonationSet, decodeDonationSet, donationSetStands, donationSetId, donationSetPaysKeys, RECIPIENT_KEY_BYTES, DONATION_BPS_TOTAL } from './donation.js';

const isBallot32 = (b) => b instanceof Uint8Array && b.length === 32;
const sameBallotBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);

export function encodeDonationProposal(p) {
  if (!isBallot32(p.networkId)) throw new Error('a proposal names a 32-byte network');
  if (typeof p.serial !== 'bigint' || p.serial < 0n) throw new Error('a serial is a BigInt, not negative');
  if (!isBallot32(p.parentSetId)) throw new Error('a proposal names the 32-byte id of the set it replaces');
  if (!(p.proposer instanceof Uint8Array) || p.proposer.length !== RECIPIENT_KEY_BYTES) throw new Error('a proposal names its proposer\'s 33-byte key');
  if (!donationSetPaysKeys(p.recipients)) throw new Error('a proposal pays keys, as the set it replaces does');
  const entries = encodeDonationSet(p.recipients);
  const w = new Writer();
  w.u8(TYPE_DONATION_PROPOSAL);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(p.networkId);
  w.u64(p.serial);
  w.bytes32(p.parentSetId);
  w.bytes(p.proposer, RECIPIENT_KEY_BYTES);
  w.u16(entries.length);
  w.bytes(entries);
  return w.finish();
}

export function decodeDonationProposal(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DONATION_PROPOSAL) throw new Error('not a donation proposal');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const networkId = r.bytes32();
  const serial = r.u64();
  const parentSetId = r.bytes32();
  const proposer = r.bytes(RECIPIENT_KEY_BYTES);
  const recipients = decodeDonationSet(r.bytes(r.u16()));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the donation proposal');
  return { networkId, serial, parentSetId, proposer, recipients };
}

/** The proposal's id: what every approval names and what the proposer signs. */
export const donationProposalId = (p) => taggedHash(TAG.donationProposal, encodeDonationProposal(p));

export function encodeDonationApproval(a) {
  if (!isBallot32(a.proposalId)) throw new Error('an approval names a 32-byte proposal');
  if (!Number.isInteger(a.atHeight) || a.atHeight < 0) throw new Error('at_height is a block height');
  const w = new Writer();
  w.u8(TYPE_DONATION_APPROVAL);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(a.proposalId);
  w.u32(a.atHeight);
  w.u8(a.accept ? 1 : 0);
  w.bytes(a.signer, RECIPIENT_KEY_BYTES);
  return w.finish();
}

export function decodeDonationApproval(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DONATION_APPROVAL) throw new Error('not a donation approval');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const proposalId = r.bytes32();
  const atHeight = r.u32();
  const flag = r.u8();
  if (flag > 1) throw new Error('an approval accepts (1) or denies (0)');
  const signer = r.bytes(RECIPIENT_KEY_BYTES);
  if (r.at !== bytes.length) throw new Error('trailing bytes after the donation approval');
  return { proposalId, atHeight, accept: flag === 1, signer };
}

/** What an approval's signer signs. */
export const donationApprovalDigest = (a) => taggedHash(TAG.donationApproval, encodeDonationApproval(a));

/**
 * THE TALLY OF ONE PROPOSAL against its parent set (the recipients the parent pays, by key). `proposal` carries its
 * `signature` by the proposer; `approvals` each carry theirs. Answers { state: 'approved' | 'refused' | 'open', validFrom,
 * acceptBps, denyBps, counted[], refused[] (why each object was not counted) }. A recipient counts once: its first valid
 * approval (lowest at_height) - a second one, either way, is not counted.
 */
export async function tallyDonationProposal({ proposal, approvals = [], parent, verifySecp256k1 }) {
  if (typeof verifySecp256k1 !== 'function') throw new Error('a tally checks signatures, and no secp256k1 verifier was injected');
  const refused = [];
  const out = (state, extra = {}) => ({ state, validFrom: null, acceptBps: 0, denyBps: 0, counted: [], refused, ...extra });
  if (!Array.isArray(parent) || !donationSetPaysKeys(parent)) return out('refused', { why: 'the parent set pays no keys: its recipients cannot vote' });
  const p = proposal;
  if (!sameBallotBytes(p.parentSetId, donationSetId(parent))) return out('refused', { why: 'the proposal names another parent set' });
  const stands = donationSetStands(p.recipients);
  if (!stands.ok) return out('refused', { why: `the proposed set does not stand: ${stands.why}` });
  const shareOf = new Map(parent.map((r) => [toHex(r.recipientPk), Number(r.shareBps)]));
  if (!shareOf.has(toHex(p.proposer))) return out('refused', { why: 'the proposer is not a recipient of the parent set' });
  const pid = donationProposalId(p);
  if (!(p.signature instanceof Uint8Array) || !(await verifySecp256k1(p.signature, pid, p.proposer))) return out('refused', { why: 'the proposer\'s signature does not verify' });

  const valid = [];
  for (const [i, a] of approvals.entries()) {
    if (!a || !sameBallotBytes(a.proposalId, pid)) { refused.push(`approval ${i} is for another proposal`); continue; }
    const k = a.signer instanceof Uint8Array ? toHex(a.signer) : '';
    if (!shareOf.has(k)) { refused.push(`approval ${i} is not by a recipient of the parent set`); continue; }
    if (!(a.signature instanceof Uint8Array) || !(await verifySecp256k1(a.signature, donationApprovalDigest(a), a.signer))) { refused.push(`approval ${i}: the signature does not verify`); continue; }
    valid.push({ ...a, key: k });
  }
  valid.sort((x, y) => x.atHeight - y.atHeight || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const seen = new Set();
  let acceptBps = 0, denyBps = 0;
  const counted = [];
  for (const a of valid) {
    if (seen.has(a.key)) { refused.push(`${a.key.slice(0, 16)} voted before: counted once`); continue; }
    seen.add(a.key);
    const bps = shareOf.get(a.key);
    counted.push({ key: a.key, accept: a.accept, atHeight: a.atHeight, bps });
    if (a.accept) acceptBps += bps; else denyBps += bps;
    // A PROPOSER WHO DENIES THEIR OWN PROPOSAL WITHDRAWS IT (2026-10-22, on a proposal its proposer had denied: "This is no longer open")
    if (!a.accept && a.key === toHex(p.proposer)) return out('refused', { acceptBps, denyBps, counted, proposalId: pid, why: 'withdrawn by its proposer' });
    if (acceptBps * 2 > DONATION_BPS_TOTAL) return out('approved', { validFrom: a.atHeight + 1, acceptBps, denyBps, counted, proposalId: pid });
    if (denyBps * 2 >= DONATION_BPS_TOTAL) return out('refused', { acceptBps, denyBps, counted, proposalId: pid, why: 'recipients holding half the parent set or more denied it' });
  }
  return out('open', { acceptBps, denyBps, counted, proposalId: pid });
}

/**
 * THE SETS THE DEVELOPERS APPROVED, AS SETS (authority.js donationSetInForce takes them beside the admin key's): each
 * `ballot` = { proposal, approvals } whose parent is found among `known` sets (by donationSetId of its recipients) - the
 * admin key's and those approved before it, in serial order. Answers [{ networkId, serial, validFrom, recipients,
 * approvedBy: proposalId }] and why each other ballot is not one.
 */
export async function approvedDonationSets({ networkId, known = [], ballots = [], verifySecp256k1 }) {
  const sets = [];
  const refused = [];
  const all = [...known];
  const order = [...ballots].filter((b) => b && b.proposal).sort((a, b) => (a.proposal.serial < b.proposal.serial ? -1 : a.proposal.serial > b.proposal.serial ? 1 : 0));
  for (const b of order) {
    const p = b.proposal;
    if (!sameBallotBytes(p.networkId, networkId)) { refused.push('a proposal for another network'); continue; }
    const parent = all.find((s) => sameBallotBytes(donationSetId(s.recipients), p.parentSetId));
    if (!parent) { refused.push(`proposal serial ${p.serial}: its parent set is not one this network holds`); continue; }
    if (!(p.serial > parent.serial)) { refused.push(`proposal serial ${p.serial}: not above its parent's serial ${parent.serial}`); continue; }
    const t = await tallyDonationProposal({ proposal: p, approvals: b.approvals || [], parent: parent.recipients, verifySecp256k1 });
    if (t.state !== 'approved') { refused.push(`proposal serial ${p.serial}: ${t.state}${t.why ? ' - ' + t.why : ''}`); continue; }
    if (Number.isInteger(parent.validFrom) && t.validFrom <= parent.validFrom) { refused.push(`proposal serial ${p.serial}: approved before its parent was in force`); continue; }
    const set = { networkId: p.networkId, serial: p.serial, validFrom: t.validFrom, recipients: p.recipients, approvedBy: t.proposalId };
    sets.push(set);
    all.push(set);
  }
  return { sets, refused };
}
