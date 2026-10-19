// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDERATION.md REHEARSAL ITEM 9 (c): "then one withdrawal of the whole balance through B while A is down" - from the
// §24A.1 player wallet, after the green 9 (b) shape (RULED 2026-09-25). Run by rehearsal-9c-regtest.sh after the
// federation is up (stock fedimintd 0.12.0, 4 guardians 3 of 4, two gateways, seven bonded signer nodes).
//
// The 9 (b) shape exactly: ONE Lightning deposit into the player wallet (2 x the one-round top-up item 8's wallet was
// credited), two paying rounds of one federation staked from it by page-lock.js's lockStake - no play, no win. Then:
//   BEFORE THE PRESS the page's own timer call (lookOwed over each round, every 5 s for 20 s): the player wallet's balance
//   and the player's lnd payments must not move;
//   GATEWAY A STOPPED (its recorded process group);
//   THE PRESS'S PLAYER-WALLET SPEND (withdrawPlayerWallet, the one call the Withdraw action makes for it): the whole
//   withdrawable balance to an invoice from the player's own lnd. Recorded: the balance before and after, the gateway,
//   the msat lnd received, the fees.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { execFileSync as run } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, sharesNeededFor } from '../../arena-client/src/join.js';
import { lockStake, playerWallet, handLock, walletSecretFor, lockSecretFor, lookOwed, tabLockWallet, withdrawPlayerWallet } from '../../arena-client/src/page-lock.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { encodeEntryContract, decodeRoundContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const random = (n) => new Uint8Array(randomBytes(n));

// THE LOCK CLIENT, as the page loads it (the glue is ESM; dist is CommonJS).
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../arena-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'rehearsal9c-glue-'));
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = glue;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));

const lncli = (...a) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', ...a],
  { timeout: 120000 }, (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out) })));
const payments = async () => (JSON.parse((await lncli('listpayments')).out || '{"payments":[]}').payments || []);
const tab = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};

// THE ROUND ON THE CHAIN, as federation-round-3.mjs stands it: a paying FEDERATION round opens only on nodes that read
// the chain (census, beacon) and whose bonds cover the federation's threshold. SEVEN signer nodes, not three: the
// committee sizes are 2 and 7 (f2759068 refuses any other), and two nodes cannot cover a 3-of-4 federation. The first
// four bond one guardian each, read off the federation itself through the signer nodes' own lock port; three bond none.
const rpcport = env.RPCPORT || '30101';
const BIN = `${env.BITCOIN_BIN}/bitcoin-cli`;
const base = ['-regtest', `-datadir=${P}/btc`, `-rpcport=${rpcport}`, '-rpcuser=arena', '-rpcpassword=arena'];
const cliRaw = (...a) => execFileSync(BIN, [...base, ...a], { encoding: 'utf8' }).trim();
const cli = (...a) => execFileSync(BIN, [...base, '-rpcwallet=arena', ...a], { encoding: 'utf8' }).trim();
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${rpcport}/wallet/arena`, readCookie: () => 'arena:arena' });
try { cliRaw('createwallet', 'arena'); } catch { try { cliRaw('loadwallet', 'arena'); } catch { /* already loaded */ } }
cli('generatetoaddress', '101', cli('getnewaddress'));
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const fed = await port.guardians();
const perNode = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < fed.keys.length ? [{ federationId: fed.federationId, guardianKey: fed.keys[i] }] : []));
const round = await standUpRound({ host: '127.0.0.1', portA: 18571, portB: 18572, portC: 18573, extraPorts: [18574, 18575, 18576, 18577], stakeMsat: 1000000n,
  rpc, cli, federationId, invite: env.INVITE, signerNode: { stakeLocks: port }, guardianOf: perNode,
  donationRecipients: { port: 18788 } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
const ONE_ROUND_TOP_UP_MSAT = 1009152n;                      // item 8's wallet was credited this for one round (8a577642)
let code = 0;
try {
  // THE SECOND ROUND OF THE SAME FEDERATION, on the same bonded daemons and chain: its own committee time, publication
  // and beacon (round-2of2 openNext); its contract read back from a signer node.
  const nextId = await round.openNext();
  const nextBytes = new Uint8Array(await (await fetch(`${round.nodes[0]}/round?id=${nextId}`)).arrayBuffer());
  const rounds = [{ rid, contract }, { rid: fromHex(nextId), contract: decodeRoundContract(nextBytes) }];
  say({ step: 'rounds', ids: rounds.map((r) => toHex(r.rid).slice(0, 16)), federation: rounds.map((r) => toHex(r.contract.federationId).slice(0, 16)) });

  const seed = random(32);
  const tabStore = tab();
  // 1. ONE DEPOSIT INTO THE PLAYER WALLET, sized for two rounds - through the wallet's own receive, once.
  const wallet = await playerWallet({ round: contract, invite: env.INVITE, seed, LockClient, storage: tabStore });
  const before = await payments();
  const plan = JSON.parse(await wallet.depositFor(String(2n * ONE_ROUND_TOP_UP_MSAT)));
  const invoice = JSON.parse(await wallet.receive(String(plan.invoice_msat), String(plan.gateway || '')));
  const paid = await lncli('payinvoice', '--force', invoice.invoice);
  const claimed = await wallet.awaitReceive(invoice.operation);
  const afterDeposit = await payments();
  const held = BigInt(await wallet.balanceMsat());
  say({ step: 'deposit', into: 'the player wallet', askedCreditMsat: 2n * ONE_ROUND_TOP_UP_MSAT, invoiceMsat: plan.invoice_msat,
    creditedMsat: plan.credited_msat, lnd: (paid.out.match(/Payment status: [A-Z_]+/g) || [paid.err || '?']).pop(), claimed,
    paymentsByLnd: afterDeposit.length - before.length, walletHeldMsat: held });
  if (claimed !== 'Claimed') throw new Error(`the deposit into the player wallet was not claimed: ${claimed}`);

  // 2-3. EACH ROUND STAKED FROM THAT ONE WALLET by the page's lockStake - no play, no win.
  const staked = [];
  for (const [i, r] of rounds.entries()) {
    const withR = { ...r.contract, id: r.rid };
    const claimKey = await awaitAttestedClaimKey({ round: withR, signerNodes: r.contract.nodes, nodes: round.nodes, curve: pageCurve });
    if (!claimKey.ok) throw new Error(`round ${i + 1}: ${claimKey.why}`);
    const player = playerFor(withR, { seed, curve: pageCurve });
    const needed = sharesNeededFor(r.contract);
    const stake = await stakeFor(withR, { signerNodes: r.contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey });
    const put = await postHandout(stake, round.nodes);
    const lock = await lockStake({ round: r.contract, roundId: r.rid, invite: env.INVITE, seed, stake, claimKey,
      playerPubkey: player.pubkey, LockClient, storage: tabStore });
    const entry = { roundId: r.rid, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      ...entryFor(withR, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
    const joined = [];
    for (const b of round.nodes) joined.push((await fetch(`${b}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
    const handed = await handLock({ entryId: entryId(entry), fields: lock.fields, nodes: round.nodes, needed });
    const walletId = toHex(sha256(walletSecretFor(seed, r.contract.federationId))).slice(0, 16);
    staked.push({ walletId, committed: handed.committed, needed });
    say({ step: `round ${i + 1}`, round: toHex(r.rid).slice(0, 16), claimKeyAttested: claimKey.attested, handoutAccepted: put.accepted,
      walletId, perRoundWalletId: toHex(sha256(lockSecretFor(seed, r.rid))).slice(0, 16),
      walletBeforeMsat: lock.walletBeforeMsat, walletAfterMsat: lock.walletAfterMsat, leftTheWalletMsat: lock.walletBeforeMsat - lock.walletAfterMsat,
      stakeLockMsat: lock.fields.amountMsat, feeLockMsat: lock.feeLock ? lock.feeLock.fields.amountMsat : 0n,
      outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, entries: joined,
      lockAnswers: handed.said.map((s) => ({ status: s.status, why: String(s.why || '').slice(0, 200) })), committed: handed.committed });
  }
  const afterLocks = await payments();
  const lightningAfterDeposit = afterLocks.length - afterDeposit.length;
  const oneWallet = staked.every((x) => x.walletId === staked[0].walletId);
  const accepted = staked.every((x) => x.committed >= x.needed);
  say({ step: '9 (b) shape', oneWallet, lightningAfterTheDeposit: lightningAfterDeposit, committed: staked.map((x) => `${x.committed}/${x.needed}`) });

  // BEFORE THE PRESS: the page's timer call, every 5 s for 20 s - it looks; the player wallet must not move.
  const heldBefore = BigInt(await wallet.balanceMsat());
  const paysBefore = (await payments()).length;
  const looks = [];
  const roundClients = [];
  for (const r of rounds) roundClients.push(await tabLockWallet({ round: r.contract, roundId: r.rid, invite: env.INVITE, seed, LockClient, storage: tabStore }));
  for (let k = 0; k < 4; k++) {
    for (const [i, r] of rounds.entries()) {
      const look = await lookOwed({ round: r.contract, roundId: r.rid, seed, curve: pageCurve, nodes: round.nodes, client: roundClients[i], storage: tabStore });
      looks.push(look && look.why ? String(look.why).slice(0, 80) : 'looked');
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  const heldAfterLooks = BigInt(await wallet.balanceMsat());
  say({ step: 'before the press', timerLooks: looks.length, playerWalletMsat: [heldBefore, heldAfterLooks],
    moved: heldBefore !== heldAfterLooks, lndPaymentsDuringTheLooks: (await payments()).length - paysBefore, lookSaid: [...new Set(looks)].slice(0, 3) });

  // GATEWAY A DOWN: its own recorded process group (the probe's pids file names it "gatewayd"; B is "gatewayd-b").
  const pids = readFileSync(`${P}/pids`, 'utf8').split('\n').map((l) => l.trim().split(' ')).filter((x) => x[1] === 'gatewayd');
  for (const [pid] of pids) { try { process.kill(-Number(pid), 'SIGTERM'); } catch { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } } }
  await new Promise((res) => setTimeout(res, 3000));
  const aUp = (() => { try { run('curl', ['-s', '-m', '3', 'http://127.0.0.1:30170/v1/info']); return true; } catch { return false; } })();
  say({ step: 'gateway A', stopped: pids.map((x) => x[0]), stillAnswers: aUp });

  // THE PRESS: the player wallet's whole withdrawable balance to an invoice from the player's own lnd.
  const invoices = [];
  const invoiceFor = async (msat) => {
    const added = JSON.parse((await lncli('addinvoice', `--amt_msat=${msat}`, '--memo=rehearsal-9c')).out || '{}');
    invoices.push({ msat, rHash: added.r_hash });
    return added.payment_request ? { ok: true, invoice: added.payment_request } : { ok: false, why: 'the player\'s lnd made no invoice' };
  };
  const out = await withdrawPlayerWallet({ round: contract, invite: env.INVITE, seed, LockClient, storage: tabStore, invoiceFor });
  const looked = invoices.length ? JSON.parse((await lncli('lookupinvoice', invoices[0].rHash)).out || '{}') : {};
  const heldAfterPress = BigInt(await wallet.balanceMsat());
  const received = BigInt(looked.amt_paid_msat || 0);
  say({ step: 'item 9 (c)', from: out.from, ok: out.ok, state: out.state, why: out.why, gateway: out.gateway,
    withdrawableMsat: out.withdrawableMsat, invoiceMsat: out.invoiceMsat, balanceBefore: out.balance_before, balanceAfter: out.balance_after,
    playerWalletAfterMsat: heldAfterPress, lndInvoiceState: looked.state || null, lndReceivedMsat: received,
    feesMsat: out.balance_before != null ? BigInt(out.balance_before) - BigInt(out.balance_after ?? 0) - received : null,
    verdict: (oneWallet && lightningAfterDeposit === 0 && accepted && heldBefore === heldAfterLooks && out.ok && received > 0n
      && String(out.gateway || '').includes('30180'))
      ? 'PASS: two rounds staked from the one player wallet with zero Lightning after the deposit; nothing moved before the press; the press withdrew the whole balance through B while A was down'
      : 'RED: see the facts above' });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
