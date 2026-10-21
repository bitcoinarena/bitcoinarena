// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S REACT SCREENS, MOUNTED (kanban #564): window.ArenaOwner.mountRoles(element, { api, node }) - the page gives it its
// signed-request helpers, so the React screen uses the same owner login as the rest of the page while the screens are ported one by one.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RolesPanel } from './RolesPanel.jsx';
import { ServicesPanel } from './ServicesPanel.jsx';
import { AddressPanel } from './AddressPanel.jsx';
import { BondPanel } from './BondPanel.jsx';
import { CustodyPanel, LiquidityPanel } from './CustodyPanels.jsx';
import { StandingPanel } from './StandingPanel.jsx';
import { ReleasePanel } from './ReleasePanel.jsx';
import { AppsPanel } from './AppsPanel.jsx';
import { NetworkAppsPanel } from './NetworkAppsPanel.jsx';
import { NetworkPanel } from './NetworkPanel.jsx';
import { NeedsPanel } from './NeedsPanel.jsx';
import { OwnerStart, OwnerMessage } from './OwnerStart.jsx';
import { OwnerArea } from './OwnerArea.jsx';
import { BondAnswer, CapacityPlea } from './BondOffer.jsx';
import { LeavePanel } from './LeavePanel.jsx';
import { WaitingDonations, DevClients } from './DonationsPanels.jsx';
import { flushSync } from 'react-dom';

export function mountRoles(element, { api, node, initial } = {}) {
  const root = createRoot(element);
  root.render(<RolesPanel api={api} node={node} initial={initial} />);
  return root;
}
export function mountServices(element, { api, initial, onAttention } = {}) {
  const root = createRoot(element);
  root.render(<ServicesPanel api={api} initial={initial} onAttention={onAttention} />);
  return root;
}
export function mountAddress(element, { api, initial } = {}) {
  const root = createRoot(element);
  root.render(<AddressPanel api={api} initial={initial} />);
  return root;
}
export function mountBond(element, { api, initial } = {}) {
  const root = createRoot(element);
  root.render(<BondPanel api={api} initial={initial} />);
  return root;
}
export function mountCustody(element, { api, initial } = {}) { const root = createRoot(element); root.render(<CustodyPanel api={api} initial={initial} />); return root; }
export function mountLiquidity(element, { api, initial } = {}) { const root = createRoot(element); root.render(<LiquidityPanel api={api} initial={initial} />); return root; }
export function mountStanding(element, { api, initial, onMissed } = {}) { const root = createRoot(element); root.render(<StandingPanel api={api} initial={initial} onMissed={onMissed} />); return root; }
export function mountRelease(element, { api, initial, onNewer } = {}) { const root = createRoot(element); root.render(<ReleasePanel api={api} initial={initial} onNewer={onNewer} />); return root; }
export function mountApps(element, { api, initial } = {}) { const root = createRoot(element); root.render(<AppsPanel api={api} initial={initial} />); return root; }
export function mountNetworkApps(element, { api, client, onChanged } = {}) { const root = createRoot(element); root.render(<NetworkAppsPanel api={api} client={client} onChanged={onChanged} />); return root; }
export function mountNetwork(element, { api, client } = {}) { const root = createRoot(element); root.render(<NetworkPanel api={api} client={client} />); return root; }
/** The overview's list, drawn again each time the page's need() changes it (one root per element). */
export function needsInto(element, items) {
  if (!element._needsRoot) element._needsRoot = createRoot(element);
  element._needsRoot.render(<NeedsPanel items={items} />);
  return element._needsRoot;
}
// THE WAY IN (the welcome, the words, Login with Nostr, the claim) and a one-card message: each drawn fresh into the page's #view
export function mountStart(element, props) { const root = createRoot(element); root.render(<OwnerStart {...props} />); return root; }
export function mountMessage(element, props) { const root = createRoot(element); root.render(<OwnerMessage {...props} />); return root; }
// THE OWNER AREA: drawn into the page's #view at once the first time (the page then draws each panel into its place), again with each
// new need() list; a root the page made for another screen there is unmounted first
export function areaInto(element, props) {
  if (!element._react || !element._react._area) {
    if (element._react) element._react.unmount();
    element.innerHTML = ''; element._react = createRoot(element); element._react._area = true;
    flushSync(() => element._react.render(<OwnerArea {...props} />));
  } else element._react.render(<OwnerArea {...props} />);
  return element._react;
}
export function mountBondAnswer(element, props) { const root = createRoot(element); root.render(<BondAnswer {...props} />); return root; }
export function mountPlea(element, props) { const root = createRoot(element); root.render(<CapacityPlea {...props} />); return root; }
export function mountLeave(element, props) { const root = createRoot(element); root.render(<LeavePanel {...props} />); return root; }
// A PANEL DRAWN AGAIN IN THE SAME ROOT (its state kept: a form being typed keeps its words): by its kind's name
const KINDS = { WaitingDonations, DevClients };
export function drawInto(element, kind, props) {
  const C = KINDS[kind];
  if (!element._react || element._react._kind !== kind) {
    if (element._react) element._react.unmount();
    element.innerHTML = ''; element._react = createRoot(element); element._react._kind = kind;
  }
  element._react.render(<C {...props} />);
  return element._react;
}
if (typeof window !== 'undefined') window.ArenaOwner = { areaInto, drawInto, mountBondAnswer, mountPlea, mountLeave, mountStart, mountMessage, mountRoles, mountServices, mountAddress, mountBond, mountCustody, mountLiquidity, mountStanding, mountRelease, mountApps, mountNetworkApps, mountNetwork, needsInto };
