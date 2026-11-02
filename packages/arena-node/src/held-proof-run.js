// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GATEWAY SHOWS ITS E-CASH (spec §23A.3a, kanban #998, rulings #1030), with stock tools and no fork: e-cash out of gatewayd, into a client of the
// federation, into the one lock that counts, read by the seated guardians, then, once the lock has expired, refunded and back into gatewayd.
// It costs a few hundred msat and ties the money up for about 6 blocks. Every step is written to the journal before the next, because the
// money is in the middle of the run: stopped anywhere, the same command carries on from where it was and brings the money home.
// `gatewayd` { sendEcash(msat) -> notes, receiveEcash(notes) }
// `client`   { receive(notes) -> { state }, lock({ amountMsat, hash, claimPk, refundPk, expiryDelta }) -> { outpoint, expiration, contractId },
//              blockCount() -> count, refund({ outpoint, amountMsat, hash, claimPk, refundPk, expiration }) -> { accepted, error }, balance() -> msat,
//              settle() keeps the client open a moment, send(msat) -> notes }
// `seats`    { info() -> GET /held-proof, ask(url, ask) -> a HeldRead, or throws }
import { HELD_CLAIM_PK, heldPaymentImage, heldLockCounted, signHeldAsk } from '../../arena-protocol/src/held-proof.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export const HELD_EXPIRY_DELTA = 8;   // 6 at the last read, and 2 for blocks that arrive while the guardians are read
export const HELD_SPARE_MSAT = 4096n; // sent out above the lock, for the mint's denominations; it comes home with the rest
const DUST_MSAT = 256n;               // the smallest note: what a client keeps back so an exact send can be made
const SETTLE_TRIES = 24;              // of client.settle(), for a refund's notes to arrive

export async function runHeldProof({ journal, gatewayd, client, seats, node, federationId, amountMsat, sign, verify, saveProof, expiryDelta = HELD_EXPIRY_DELTA,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 30000, log = () => {} }) {
  const j = journal.load() || { step: 'wait', federationId, amountMsat: String(amountMsat) };
  const save = (fields) => { Object.assign(j, fields); journal.save(j); log(`${j.step}${j.why ? `: ${j.why}` : ''}`); };
  const fields = () => ({ amountMsat: BigInt(j.amountMsat), hash: toHex(heldPaymentImage(node, j.epoch)), claimPk: HELD_CLAIM_PK, refundPk: `02${node}` });

  if (j.step === 'wait') {
    for (;;) {
      const info = await seats.info();
      if (info.open) { save({ step: 'sending', epoch: info.epoch }); break; }
      if (info.tip > info.window.to) { save({ step: 'done', why: `the read window of epoch ${info.epoch} has passed: nothing was moved` }); return j; }
      await sleep(pollMs);
    }
  }
  if (j.step === 'sending') {
    // no resuming here: a stop in this one call cannot tell whether gatewayd let the notes go, so it says so instead of sending twice
    if (j.sendAsked) throw new Error('stopped while gatewayd was sending: compare its balance, and if the notes are gone they were printed by no one. Clear this journal to start again');
    save({ sendAsked: true });
    const notes = await gatewayd.sendEcash(BigInt(j.amountMsat) + HELD_SPARE_MSAT);
    save({ step: 'funding', notes });
  }
  if (j.step === 'funding') {
    const got = await client.receive(j.notes);
    if (got.state === 'Rejected') throw new Error('the client\'s receive was refused: the notes in this journal are spent');
    save({ step: 'locking' });
  }
  if (j.step === 'locking') {
    // THE BALANCE SAYS WHETHER A LOCK WENT OUT: a tool that fails after the guardians took the transaction leaves the money locked with no outpoint
    // in this journal, and a refund needs the outpoint. So it is never locked twice, and never called "no lock" while the money is gone
    const short = async () => BigInt(await client.balance()) < BigInt(j.amountMsat);
    const stranded = (why) => new Error(`this client holds less than the lock, so a lock may stand (${why}). Find its transaction in the client's operations and refund it after expiry; contract fields: epoch ${j.epoch}, amount ${j.amountMsat} msat`);
    if (await short()) throw stranded('found before locking');
    if (!(await seats.info()).open) save({ step: 'sendback', why: 'the read window closed before the lock' });
    else {
      let l = null;
      try { l = await client.lock({ ...fields(), expiryDelta }); } catch (e) {
        const why = String(e.message || e).slice(0, 200);
        if (await short()) throw stranded(why);
        save({ step: 'sendback', why: `no lock: ${why}` });
      }
      if (l) save({ step: 'reading', outpoint: l.outpoint, expiration: l.expiration, contractId: l.contractId });
    }
  }
  if (j.step === 'reading') {
    const info = await seats.info();
    const ask = signHeldAsk({ federationId, epoch: j.epoch, node, outpoint: j.outpoint, amountMsat: j.amountMsat, expiration: j.expiration }, sign);
    const reads = [], refused = [];
    for (const g of info.guardians) {
      if (!g.url) { refused.push(`${g.node.slice(0, 8)}: no address`); continue; }
      try { reads.push(await seats.ask(g.url, ask)); } catch (e) { refused.push(`${g.node.slice(0, 8)}: ${String(e.message || e).slice(0, 120)}`); }
    }
    const heldLock = { federationId, epoch: j.epoch, outpoint: j.outpoint, contractId: j.contractId, amountMsat: j.amountMsat, reads };
    const counted = heldLockCounted({ heldLock, federationId, epoch: j.epoch, node, seated: info.guardians.map((g) => g.node), threshold: info.threshold, verify });
    if (counted.sats > 0n) saveProof(heldLock);
    save({ step: 'expiring', reads: reads.length, refused, heldSats: String(counted.sats), why: counted.why });
  }
  if (j.step === 'expiring') {
    while (await client.blockCount() < j.expiration) await sleep(pollMs);
    save({ step: 'refunding' });
  }
  if (j.step === 'refunding') {
    const r = await client.refund({ ...fields(), outpoint: j.outpoint, expiration: j.expiration });
    // a second try after a stop finds the lock already spent: the balance below says which
    if (!r.accepted && !r.alreadySpent) throw new Error(`the refund was refused: ${r.error}`);
    save({ step: 'sendback', refunded: true });
  }
  if (j.step === 'sendback') {
    // AN ACCEPTED REFUND IS NOT MONEY YET (measured on the regtest federation, kanban #998: the run said done with 3,840 msat sent home and the 100,000 sat
    // still on their way): the notes are issued after the transaction, by a client that stays open. Done means the money is here
    const expected = j.refunded ? BigInt(j.amountMsat) - HELD_SPARE_MSAT : 0n;
    let have = BigInt(await client.balance());
    for (let i = 0; i < SETTLE_TRIES && have < expected; i++) { await client.settle(); have = BigInt(await client.balance()); }
    if (have < expected) throw new Error(`the refund was accepted and this client holds ${have} msat of ${expected}: run this again to carry on`);
    if (have <= DUST_MSAT) save({ step: 'done', why: j.why || 'nothing left to bring home' });
    else save({ step: 'homing', notes: await client.send(have - DUST_MSAT), sentBack: String(have - DUST_MSAT) });
  }
  if (j.step === 'homing') {
    await gatewayd.receiveEcash(j.notes);
    save({ step: 'done', notes: null });
  }
  return j;
}
