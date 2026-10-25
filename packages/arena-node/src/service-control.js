// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE OWNER PAGE CAN DO WITH EACH SERVICE (kanban #563, 2026-10-21): start, stop, restart, and whether it starts with the
// machine - for every service the page lists, on a node set up by hand and on an installed one.
//
//   inside the node      the guardian, the guardians' P2P tunnel, the address announcements: the node starts and stops them itself,
//                        on any node; "at boot" is kept in its store (service-settings.js)
//   installed services   the chain (Bitcoin Core / the chain bridge), the gateway, the tunnel behind the public address: the
//                        installer's own service control (node-services.js control, setBoot - the unit or the launch agent)
//   the seat             restarted only - stopping it would end the page that asks - and only where the installer runs it
//   a node set up by hand: what runs outside the node (its chain, its gateway, its address) is started and stopped on its machine
//
// controlsOf answers { controls: [start | stop | restart], atBoot: true | false | null, bootSettable, why }.
export const INSIDE = Object.freeze(['guardian', 'p2p-tunnel', 'announcements']);
/** The installer's service a listed row is: the public address is the tunnel's, the chain Bitcoin Core's or the chain bridge's. */
export const installerIdOf = (id, installedIds = []) => (id === 'address' ? 'tunnel'
  : id === 'chain' ? (installedIds.find((x) => /^bitcoind-|^chain-bridge$/.test(x)) || null) : id);

export function controlsOf({ id, installed = false, installedIds = [], toggles = {}, settings = null, boot = null, running = null }) {
  if (INSIDE.includes(id)) {
    const t = toggles[id];
    if (!t || !t.has()) return { controls: [], atBoot: null, bootSettable: false, why: (t && t.why) || 'not run by this node' };
    return { controls: t.running() ? ['stop', 'restart'] : ['start'], atBoot: settings ? settings.atBoot(id) : true, bootSettable: !!settings };
  }
  if (id === 'node') {
    if (!installed) return { controls: [], atBoot: null, bootSettable: false, why: 'set up by hand: restart the node on its machine' };
    return { controls: ['restart'], atBoot: boot ? boot.atBoot : null, bootSettable: !!(boot && boot.settable), why: 'stopping it would end this page: restart only' };
  }
  const svc = installed ? installerIdOf(id, installedIds) : null;
  if (!svc || !installedIds.includes(svc)) return { controls: [], atBoot: null, bootSettable: false, why: 'runs outside the node: started and stopped on its machine' };
  // what applies now: a stopped one started, a running one stopped or restarted; all three while its state is not known
  const controls = running === false ? ['start'] : running === true ? ['stop', 'restart'] : ['start', 'stop', 'restart'];
  return { controls, atBoot: boot ? boot.atBoot : null, bootSettable: !!(boot && boot.settable), ...(boot && boot.why ? { why: boot.why } : {}) };
}
