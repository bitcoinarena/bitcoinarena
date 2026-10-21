// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE DASHBOARD IN REACT, MOUNTED (kanban #566): window.ArenaDashboard.draw(element, data) draws /dashboard.json into the page; the page
// calls it at every read (one root per element) and keeps its own drawing when this file is not there.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardPage } from './DashboardPage.jsx';

export function draw(element, data) {
  if (!element._root) element._root = createRoot(element);
  element._root.render(<DashboardPage data={data} />);
}
if (typeof window !== 'undefined') window.ArenaDashboard = { draw };
