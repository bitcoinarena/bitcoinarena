// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FORUM'S REACT VIEWS, MOUNTED (kanban #564): window.ArenaForum.draw(element, kind, props) - kind 'list', 'thread', 'new', 'fees' or
// 'payout' (the view), 'key' (who signs), 'balance' (the reserves on top) or 'empty' (a line in place of the view) - one root per element, drawn again at every route; window.ArenaForum.clear unmounts it (a form drawn fresh after it was published).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProposalList, ProposalThread, NewProposal, FeesProposal, PayoutProposal, SignedIn, ReserveBalance, Empty, ReservesView } from './ForumViews.jsx';

const VIEWS = { list: ProposalList, thread: ProposalThread, new: NewProposal, fees: FeesProposal, payout: PayoutProposal, key: SignedIn, balance: ReserveBalance, empty: Empty, reserves: ReservesView };
export function draw(element, kind, props) {
  if (!element._root) element._root = createRoot(element);
  element._root.render(React.createElement(VIEWS[kind], { key: kind + (props.thread ? props.thread.heading : ''), ...props }));
}
export function clear(element) { if (element._root) { element._root.unmount(); element._root = null; } }
if (typeof window !== 'undefined') window.ArenaForum = { draw, clear };
