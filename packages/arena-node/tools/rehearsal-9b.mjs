// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDERATION.md REHEARSAL ITEM 9 (b): "two rounds played from the wallet with no deposit" - STAKED, not played (RULED
// 2026-09-25: no play, no win, no gate driver). Run by rehearsal-9b-regtest.sh after the federation is up (stock
// fedimintd 0.12.0, 4 guardians 3 of 4, two gateways, seven bonded signer nodes).
//
// ONE Lightning deposit into the player wallet (§24A.1), sized as twice the one-round top-up item 8's wallet was credited
// (2 x 1009152 msat), through the wallet's own lock client receive, once - fundPlayerWallet's one-round default is left
// alone. Then two paying rounds of the same federation, each staked by page-lock.js's lockStake from that one wallet.
// Recorded: the stake leaving the wallet for each round, the wallet key (one for both), the player's lnd payments after
// the deposit (expected 0), and both rounds' /lock answers and committed counts.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, sharesNeededFor } from '../../arena-client/src/join.js';
import { lockStake, playerWallet, handLock, walletSecretFor, lockSecretFor } from '../../arena-client/src/page-lock.js';
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
const glueDir = mkdtempSync(join(tmpdir(), 'rehearsal9b-glue-'));
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
  const keys = [];
  for (let i = 0; i < tabStore.length; i++) keys.push(tabStore.key(i));
  const oneWallet = staked.every((s) => s.walletId === staked[0].walletId);
  const accepted = staked.every((s) => s.committed >= s.needed);
  say({ step: 'item 9 (b)', oneWallet, walletId: staked[0].walletId, tabKeysPerRoundWallet: keys.filter((k) => k.startsWith('arena.lockdb.')).length,
    lightningAfterTheDeposit: lightningAfterDeposit, committed: staked.map((s) => `${s.committed}/${s.needed}`),
    verdict: oneWallet && lightningAfterDeposit === 0 && accepted
      ? 'PASS: both rounds staked from the one wallet per seed and federation, zero Lightning after the one deposit, both locks accepted'
      : `RED: one wallet ${oneWallet}, Lightning after the deposit ${lightningAfterDeposit}, committed ${staked.map((s) => `${s.committed}/${s.needed}`).join(', ')}` });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
