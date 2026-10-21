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
if (typeof window !== 'undefined') window.ArenaOwner = { mountRoles, mountServices, mountAddress, mountBond, mountCustody, mountLiquidity, mountStanding, mountRelease, mountApps, mountNetworkApps };
