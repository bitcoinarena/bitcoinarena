// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEALTH PAGE'S REACT VIEWS, MOUNTED (kanban #564): window.ArenaHealth.draw(element, kind, props) - kind 'facts', 'nodes' or
// 'capacity' - one root per element, with nodeView / capacityView making their props from the page's data -, drawn again at every read; the page keeps its own drawing when this file is not there.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Facts, NodesTable, Capacity, nodeView, capacityView } from './HealthViews.jsx';

const VIEWS = { facts: Facts, nodes: NodesTable, capacity: Capacity };
export function draw(element, kind, props) {
  if (!element._root) element._root = createRoot(element);
  element._root.render(React.createElement(VIEWS[kind], props));
}
if (typeof window !== 'undefined') window.ArenaHealth = { draw, nodeView, capacityView };
