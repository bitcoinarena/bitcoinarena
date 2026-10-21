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
if (typeof window !== 'undefined') window.ArenaOwner = { mountStart, mountMessage, mountRoles, mountServices, mountAddress, mountBond, mountCustody, mountLiquidity, mountStanding, mountRelease, mountApps, mountNetworkApps, mountNetwork, needsInto };
