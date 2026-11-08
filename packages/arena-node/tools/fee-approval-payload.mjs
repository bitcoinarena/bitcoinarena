#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL DEVELOPER'S FEE APPROVAL ON CHAIN (kanban #1283, RULED #1277 B): the 77-byte OP_RETURN payload "ARN" 'A' proposal_id[0:8] || approve || sig64, the developer
// key's BIP-340 signature over tagged_hash("ARENA/v1/FeeApproval", proposal_id || approve). It prints the payload; with BITCOIN_CLI (a wallet's bitcoin-cli command line,
// e.g. "bitcoin-cli -testnet4 -rpcwallet=dev") it also sends it, as the owner page sends a vote. A no stands over a yes (send NO to withdraw a yes).
//
//   DEV_KEY_FILE=<32-byte secret, hex> PROPOSAL=<64 hex> APPROVE=yes|no [BITCOIN_CLI="..."] node tools/fee-approval-payload.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFeeApprovalOnChain, feeApprovalMessage } from '../../arena-protocol/src/fee-signal-chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const id = String(env.PROPOSAL || '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(id)) { console.error('PROPOSAL=<64 hex>'); process.exit(2); }
const approve = String(env.APPROVE || '').toLowerCase() === 'yes' ? true : String(env.APPROVE || '').toLowerCase() === 'no' ? false : null;
if (approve === null) { console.error('APPROVE=yes|no'); process.exit(2); }
const secret = fromHex(readFileSync(env.DEV_KEY_FILE, 'utf8').trim());
const pid = fromHex(id);
const payload = encodeFeeApprovalOnChain({ proposalId: pid, approve, signature: schnorr.sign(feeApprovalMessage(pid, approve), secret) });
const out = { dev: toHex(schnorr.getPublicKey(secret)), proposalId: id, approve, opReturn: toHex(payload) };
if (env.BITCOIN_CLI) {
  const [cmd, ...args] = env.BITCOIN_CLI.split(/\s+/).filter(Boolean);
  out.txid = JSON.parse(execFileSync(cmd, [...args, '-named', 'send', `outputs=${JSON.stringify([{ data: out.opReturn }])}`, 'fee_rate=2'], { encoding: 'utf8' })).txid;
}
console.log(JSON.stringify(out));
