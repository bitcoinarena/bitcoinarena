// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FORUM'S REACT VIEWS, MOUNTED (kanban #564): window.ArenaForum.draw(element, kind, props) - kind 'list', 'thread' or 'new' - one root,
// drawn again at every route; forum.js unmounts it (window.ArenaForum.clear) before it draws one of its own forms there.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProposalList, ProposalThread, NewProposal, FeesProposal } from './ForumViews.jsx';

const VIEWS = { list: ProposalList, thread: ProposalThread, new: NewProposal, fees: FeesProposal };
export function draw(element, kind, props) {
  if (!element._root) element._root = createRoot(element);
  element._root.render(React.createElement(VIEWS[kind], { key: kind + (props.thread ? props.thread.heading : ''), ...props }));
}
export function clear(element) { if (element._root) { element._root.unmount(); element._root = null; } }
if (typeof window !== 'undefined') window.ArenaForum = { draw, clear };
