// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S REACT SCREENS, MOUNTED (kanban #564): window.ArenaOwner.mountRoles(element, { api, node }) - the page gives it its
// signed-request helpers, so the React screen uses the same owner login as the rest of the page while the screens are ported one by one.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RolesPanel } from './RolesPanel.jsx';
import { ServicesPanel } from './ServicesPanel.jsx';

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
if (typeof window !== 'undefined') window.ArenaOwner = { mountRoles, mountServices };
