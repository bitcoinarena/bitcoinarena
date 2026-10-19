// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PEG-IN IS CHECKED AGAINST THE RUNNING FEDERATION BEFORE ITS CONFIRMATIONS ARE WAITED OUT (2026-09-29 12:25,
// PEGIN-WATCH-1225).
//
// What happened: gateway B's client still held an older config under the same federation id 337ae01a - peer 0 key
// 0383be7e, finality 2, a peg-in descriptor 02d3691c - because a Fedimint client refuses a key change under one id
// ("Global configuration changes are not allowed"). It derived tb1q05fn, 9d68228c paid it, and the watcher read only
// the balance: 0 msat for 60 blocks, reported as maturing, while the running federation (027acbea, finality 100,
// 03d0720e) could never see that deposit. Named only after 100 confirmations.
//
// The rule, applied before any waiting: the gateway's config for the federation has the running federation's guardian
// keys, finality and peg-in descriptor, and the gateway's current client derived the paid address. Either failing is a
// MISMATCH now - it names both key prefixes and both addresses - and is never "waiting". Only a peg-in that passes both
// waits for its credit.

/** The facts a config carries for this check: guardian keys by peer, the wallet's finality, network and descriptor. */
export function configFacts(config) {
  const g = config && config.global;
  const wallet = config && config.modules && Object.values(config.modules).find((m) => m && m.kind === 'wallet');
  if (!g || !g.broadcast_public_keys || !wallet) throw new Error('that is not a federation config with a wallet module');
  return { keys: { ...g.broadcast_public_keys }, finality: Number(wallet.finality_delay), network: wallet.network,
    descriptor: String(wallet.peg_in_descriptor) };
}

const descriptorKey = (d) => (String(d).match(/sortedmulti\(\d+,([0-9a-f]{66})/) || [])[1] || String(d).slice(0, 24);
const short = (s) => String(s).slice(0, 8);

/**
 * The verdict for one peg-in. `federation` and `gateway` are configs (as fedimint-cli config and gateway-cli cfg
 * client-config print them); `address` is the paid address and `currentAddress` the one the current gateway config
 * derived; `derivedByGateway` is the gateway's own answer (true, false, or null when it could not be asked);
 * `confirmations`, `balanceMsat` and `wantMsat` are the chain's and the gateway's numbers.
 * Answers { state: 'mismatch' | 'waiting' | 'credited' | 'unchecked', why }.
 */
export function peginVerdict({ federation, gateway, address, currentAddress = null, derivedByGateway = null,
  confirmations = 0, balanceMsat = 0n, wantMsat = 1n }) {
  const fed = configFacts(federation);
  const gw = configFacts(gateway);
  const both = `gateway peer 0 ${short(gw.keys['0'])} vs federation ${short(fed.keys['0'])}; `
    + `paid ${address}, current gateway config's ${currentAddress || '(none generated)'}`;
  const peers = [...new Set([...Object.keys(fed.keys), ...Object.keys(gw.keys)])];
  const keysDiffer = peers.filter((p) => fed.keys[p] !== gw.keys[p]);
  const out = [];
  if (keysDiffer.length) out.push(`the gateway's guardian keys differ from the running federation's on ${keysDiffer.length} of ${peers.length} peers`);
  if (gw.finality !== fed.finality) out.push(`finality ${gw.finality} at the gateway, ${fed.finality} at the federation`);
  if (gw.network !== fed.network) out.push(`network ${gw.network} at the gateway, ${fed.network} at the federation`);
  if (gw.descriptor !== fed.descriptor)
    out.push(`peg-in descriptor ${descriptorKey(gw.descriptor).slice(0, 8)} at the gateway, ${descriptorKey(fed.descriptor).slice(0, 8)} at the federation`);
  if (out.length)
    return { state: 'mismatch', why: `the gateway's client config is not the running federation's: ${out.join('; ')} - `
      + `a deposit to an address it derived is never credited by this federation (${both})` };
  if (derivedByGateway === false || (currentAddress && address !== currentAddress && derivedByGateway !== true))
    return { state: 'mismatch', why: `the paid address was not derived by the gateway's current client (${both})` };
  if (BigInt(balanceMsat) >= BigInt(wantMsat)) return { state: 'credited', why: `${balanceMsat} msat at the gateway` };
  if (derivedByGateway === null)
    return { state: 'unchecked', why: `the configs match, but the gateway was not asked whether it derived ${address}; not counted as waiting` };
  return { state: 'waiting', why: `${confirmations} of ${fed.finality} confirmations; ${balanceMsat} msat at the gateway` };
}
