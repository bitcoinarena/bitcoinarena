// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT IS NEW FOR A NODE OWNER IN 2.0 (kanban #1096, the owner 2026-11-03: "the owner dashboard and the installer must state clearly what is
// new for a node owner in 2.0. Every point in plain words, where the owner meets it, before they commit money"). One list, read by the
// installer (before the bond, for the roles chosen) and by the owner dashboard (the points for this node). The same words as the security
// page (#1094).
//
// Each point: `role` - 'node' (every node), 'guardian' (custody) or 'gateway'; `status` - 'testnet' (live on testnet now), '2.0' (built,
// comes with 2.0) or 'planned' (decided for 2.0, not built yet); `lines` - what it means, in plain words; `installer` and `dashboard` -
// where the owner meets it; `confirm` - the installer asks for an explicit yes before the role is kept.

export const CHANGES_20 = [
  { n: 1, role: 'node', status: 'planned', title: 'Your bond is withdrawn with your 24 words, not by the node',
    lines: ['Taking your bond back, after its maturity or after a slash that does not hold up, is signed with your owner key from your 24 words. A hacked node cannot take your bond, and neither can the node itself.'],
    installer: 'Your owner key comes from your 24 words, which are shown once. Write them down and keep them off this machine. A node without them posts no 2.0 bond.',
    dashboard: '"Withdraw" asks for your owner key.' },
  { n: 2, role: 'node', status: '2.0', title: 'Bonding takes 3 transactions',
    lines: ['Funding, the bond, and an advertisement update that carries the bond\'s advance signature. You see the fees before anything is posted.',
      'On mainnet the node posts nothing while it cannot yet read a census key, rather than a bond that would not count.'],
    installer: 'The fees of all three are shown before the bond step.', dashboard: 'Each of the three transactions with its state.' },
  { n: 3, role: 'node', status: '2.0', title: 'What a slash does now',
    lines: ['A slash first moves your bond to a hold. It still counts in the census while it is held, and your node is still drawn and paid.',
      'Two panels release it after about 1 hour if the proof is valid: the players get their real loss, the rest goes to the protocol reserves, and nothing comes back.',
      'If the proof does not hold up, you can take your bond back with your 24 words after about 1 day, never before its maturity. The dashboard shows when, and prepares it for you.'],
    dashboard: 'A started slash shows its start, its proof, and each way out with its block height; a return you can sign is prepared for you.' },
  { n: 4, role: 'node', status: '2.0', title: 'Panels',
    lines: ['Your node may be drawn for a round\'s panel. That is no work unless a slash comes.', 'Signing a release without a valid proof is itself slashable.'] },
  { n: 5, role: 'node', status: '2.0', title: 'The census key',
    lines: ['Your node holds shares of the network\'s census key, drawn by the size of its bond, so a small node may hold none in an epoch. It takes part in making the key and in each reshare, and deletes its old shares after a reshare.',
      'It may post a key anchor from its duty wallet, which costs a fee.'],
    dashboard: 'The key your bonds name, and a warning when that key is under its threshold or 2 epochs in a row failed.' },
  { n: 6, role: 'node', status: 'planned', title: 'Voting on reserve payouts is opt-in',
    lines: ['Only an output locked long enough votes: on mainnet about 6 to 7 months. A default bond does not vote.'],
    installer: '"Lock to vote" is offered, with the exact lock time.', dashboard: '"Lock to vote", with the exact lock time.' },
  { n: 7, role: 'node', status: '2.0', title: 'The stall rule',
    lines: ['A node named silent in 3 failed rounds, each an hour or more apart, within 72 hours, is out of the draw until fewer than 3 such proofs lie in the last 72 hours.',
      'No bond moves. It earns nothing while it is out. At most a tenth of the network\'s bonded weight can be out this way at once. The settlement stage is off until its own height.'],
    dashboard: 'Notes naming your node, and when it is back in the draw.' },
  { n: 8, role: 'node', status: '2.0', title: 'Rounds can wait',
    lines: ['A round with an entry short of quorum waits up to about 30 minutes before it pays.'] },
  { n: 9, role: 'node', status: '2.0', title: 'Abandonment',
    lines: ['If you are a guardian and you spend your bond while you guard, that counts as abandoning your federation. Any bond output you still have is slashed.'] },
  { n: 10, role: 'guardian', status: 'planned', title: 'A guardian\'s bond is the players\' insurance', confirm: true,
    lines: ['If your federation is robbed, the bonds of all its guardians pay every note at face value, a hacked guardian\'s bond included.',
      'Players have 3 months to claim. What is left then goes to the protocol reserves, and nothing comes back to the guardians.'],
    installer: 'Said before the custody role is kept, and you must answer yes.' },
  { n: 11, role: 'guardian', status: 'planned', title: 'The bond stays locked while it guards',
    lines: ['Your bond must stay locked beyond your federation\'s drain time, about 4 weeks on mainnet.', 'Leaving is by notice only, after the federation has drained.'],
    dashboard: 'When the bond must be extended, with "Add to bond".' },
  { n: 12, role: 'guardian', status: 'planned', title: 'Updates are staged',
    lines: ['Your updater may wait: at most 2 of a federation\'s 7 guardians on testnet, 3 of 10 on mainnet, update at a time, so a faulty release never reaches the threshold before it shows.'] },
  { n: 13, role: 'guardian', status: 'planned', title: 'Where your node runs',
    lines: ['The installer asks which machine or provider your node runs on. A federation is founded with at most 2 of 7 guardians on testnet, 3 of 10 on mainnet, on the same one.'],
    installer: 'Asks for your machine or provider.' },
  { n: 14, role: 'guardian', status: 'planned', title: 'Deposits stop on an alarm',
    lines: ['A reserve alarm - a spend of the federation\'s reserve that no player asked for - stops deposits into the federation.'],
    dashboard: 'Says why deposits stopped.' },
  { n: 15, role: 'gateway', status: 'planned', title: 'Gateways keep the load cap',
    lines: ['No peg-in when the federation\'s load is 1 or above. A seated gateway that breaks this is unseated.'] },
  { n: 16, role: 'gateway', status: '2.0', title: 'The held proof',
    lines: ['Peg-in weight needs the gateway\'s own e-cash locked across the epoch\'s proof height.'] },
];

export const STATUS_WORDS = { testnet: 'live on testnet', '2.0': 'comes with 2.0', planned: 'planned for 2.0' };
export const ROLE_WORDS = { node: 'Every node', guardian: 'Guardians', gateway: 'Gateways' };

/** The points for a node's roles: every node's, and the guardian and gateway ones when it guards (the custody role runs both). */
export function changesFor({ custody = false } = {}) {
  return CHANGES_20.filter((c) => c.role === 'node' || (custody && (c.role === 'guardian' || c.role === 'gateway')));
}
