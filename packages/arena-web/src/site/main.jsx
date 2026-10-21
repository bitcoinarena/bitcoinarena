// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA SITE'S SMALL PAGES' REACT (kanban #564): one classic script, src/arena-ui/site-react.js, that /dashboard/ and /guardians/ load
// before their own; window.ArenaSite.nodes(element, props) and .guardians(element, props) draw into one root each, again on each change.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NodesList, GuardianCheck } from './SitePages.jsx';

const into = (el, node) => { if (!el._root) el._root = createRoot(el); el._root.render(node); };
if (typeof window !== 'undefined') window.ArenaSite = {
  nodes: (el, props) => into(el, <NodesList {...props} />),
  guardians: (el, props) => into(el, <GuardianCheck {...props} />),
};
