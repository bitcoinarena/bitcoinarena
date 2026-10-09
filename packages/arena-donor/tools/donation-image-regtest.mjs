// KANBAN #156 MEASURE 1, ON A LOCAL REGTEST FEDERATION (no testnet funds, no bond): the sender's 32-byte player key in a
// donation contract's payment image. (a) the federation accepts the lock transaction with that output; (b) the recipient
// redeems it at once through the refund path, with the key-bearing contract - and the same output refused under the old
// zero image ("the guardians hold another contract at that outpoint"), so the key is part of what the guardians stored;
// (c) the contract read back from the federation at that outpoint is the one with the key (its stored contract id equals the
// id computed with the key, ids_match). Dev B's output, with no image, is the zero-image control.
//   PROBE INVITE GATEWAY LND_BIN WASM_DIR node donation-image-regtest.mjs   (run by donation-image-regtest.sh)
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { newKey, walletSecretFor, redeemAll } from '../src/donor.js';

const env = process.env;
const say = (o) => console.log(JSON.stringify(o));
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const W = env.WASM_DIR;
const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
copyFileSync(join(W, 'blwp_lock_client.js'), esm);
const m = await import(esm); await m.default({ module_or_path: readFileSync(join(W, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = m;
const mem = () => { const h = new Map(); return { entries: () => JSON.stringify([...h]), put: (k, v) => h.set(k, v), remove: (k) => h.delete(k) }; };
const lncliPay = (invoice) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${env.PROBE}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', 'payinvoice', '--force', invoice],
  { timeout: 120000 }, (err, out) => done((String(out).match(/Payment status: [A-Z_]+/) || [err ? err.message : '?'])[0])));
const fed = String(LockClient.federationIdOf(env.INVITE));

// 1. A PLAYER WALLET, FUNDED THROUGH THE GATEWAY
const player = await LockClient.join(env.INVITE, fed, randomBytes(32).toString('hex'), mem());
const rcv = JSON.parse(await player.receive('200000', env.GATEWAY));
say({ step: 'deposit', pay: await lncliPay(rcv.invoice), claimed: await player.awaitReceive(rcv.operation), balanceMsat: await player.balanceMsat() });

// 2. THE LOCK WITH TWO DONATION OUTPUTS: dev A's image is the player's x-only key, dev B's is the old zero image
const playerKey = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');
const devs = [newKey(), newKey()];
const pt = newKey(), claim = newKey(), refund = newKey();
const all = JSON.parse(await player.lockWithDonations(pt.recipientPkHex, '2000', '', '0', claim.recipientPkHex, refund.recipientPkHex, 144,
  JSON.stringify([{ pk: devs[0].recipientPkHex, msat: '20000', image: playerKey }, { pk: devs[1].recipientPkHex, msat: '10000' }])));
say({ step: '(a) the federation accepted the lock transaction', txid: all.stake.txid, stakeIds: all.stake.ids_match,
  donations: all.donations.map((d) => ({ out: d.out_idx, pk: d.recipient_pk.slice(0, 12), msat: d.amount_msat, stored: d.stored_contract_id, ids_match: d.ids_match })) });
say({ step: '(c) read back: the contract the guardians store at dev A\'s outpoint is the one with the player key', playerKey, ids_match: all.donations[0].ids_match, stored_contract_id: all.donations[0].stored_contract_id });

// 3. DEV A REDEEMS AT ONCE, WITH ITS OWN KEY, THROUGH THE REFUND PATH
const fields = (pk, msat, image) => JSON.stringify({ paymentImage: { kind: 'hash', bytes: image }, amountMsat: String(msat), claimPk: pk, refundPk: pk, expiration: 0 });
const a = all.donations[0], b = all.donations[1];
const devA = await LockClient.join(env.INVITE, fed, walletSecretFor(devs[0].secretHex, fed), mem());
let zero;
try { zero = JSON.parse(await devA.refund(a.txid, a.out_idx, fields(devs[0].recipientPkHex, a.amount_msat, '00'.repeat(32)), devs[0].secretHex)); }
catch (e) { zero = { refused: String(e.message || e) }; }
say({ step: 'dev A, the OLD zero image: refused', zero });
const keyed = JSON.parse(await devA.refund(a.txid, a.out_idx, fields(devs[0].recipientPkHex, a.amount_msat, playerKey), devs[0].secretHex));
say({ step: '(b) dev A, the player-key image: redeemed', accepted: keyed.accepted, txid: keyed.txid, balanceMsat: await devA.balanceMsat() });
// 4. THE CONTROL: dev B's zero-image output through the donor's own redeem (unchanged)
const devB = await LockClient.join(env.INVITE, fed, walletSecretFor(devs[1].secretHex, fed), mem());
const rb = await redeemAll({ client: devB, donations: [{ outpoint: `${b.txid}:${b.out_idx}`, amountMsat: String(b.amount_msat) }], recipientPkHex: devs[1].recipientPkHex, secretHex: devs[1].secretHex });
say({ step: 'control: dev B, zero image, the donor\'s redeemAll', redeemed: rb.redeemed.length, failed: rb.failed.map((f) => f.why), balanceMsat: await devB.balanceMsat() });
say({ step: 'done', ok: all.donations[0].ids_match === true && keyed.accepted === true && !!zero.refused });
process.exit(0);
