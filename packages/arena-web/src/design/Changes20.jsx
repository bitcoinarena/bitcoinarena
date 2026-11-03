// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT IS NEW IN 2.0, DRAWN (kanban #1096): the points of changes20.js for a node's roles, grouped by who they are for, each with its status
// and where the owner meets it - in the installer (`where="installer"`) or on the owner dashboard (`where="dashboard"`).
import React from 'react';
import { Pill } from './components.jsx';
import { changesFor, ROLE_WORDS, STATUS_WORDS } from './changes20.js';

const TONE = { testnet: 'on', '2.0': 'wait', planned: null };

export class Changes20 extends React.Component {
  render() {
    const { custody = false, where = 'dashboard', confirmed = false, onConfirm = null } = this.props;
    const list = changesFor({ custody });
    const groups = ['node', 'guardian', 'gateway'].map((r) => [r, list.filter((c) => c.role === r)]).filter(([, l]) => l.length);
    return (
      <div className="ch20">
        <p className="sub">What changes for your node with Bitcoin Arena 2.0. Mainnet is not live; each point says whether it is live on testnet, comes with 2.0, or is planned for it.</p>
        {groups.map(([role, items]) => (
          <div key={role} className="ch20-group">
            <h3 className="sh">{ROLE_WORDS[role]}</h3>
            {items.map((c) => {
              const meet = where === 'installer' ? c.installer : c.dashboard;
              return (
                <div key={c.n} className={'ch20-item' + (c.confirm ? ' ch20-confirm' : '')}>
                  <div className="ch20-head"><b>{c.n}. {c.title}</b> <Pill tone={TONE[c.status]}>{STATUS_WORDS[c.status]}</Pill></div>
                  {c.lines.map((l, i) => <p key={i}>{l}</p>)}
                  {meet ? <p className="ch20-meet">{where === 'installer' ? 'Here: ' : 'On this page: '}{meet}</p> : null}
                  {c.confirm && where === 'installer' && onConfirm ? (
                    <label className="ch20-yes"><input type="checkbox" checked={!!confirmed} onChange={(e) => onConfirm(e.target.checked)} />{' '}
                      Yes: if my federation is robbed, my guardian bond helps pay the players back, even if my own node was the one hacked. What is left after 3 months goes to the protocol reserves, not back to me.</label>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }
}

export const CHANGES20_CSS = `.ch20 .ch20-group{margin:10px 0 4px}
.ch20 .ch20-item{border:1px solid var(--line, #30363d);border-radius:12px;padding:10px 12px;margin:8px 0}
.ch20 .ch20-item p{margin:4px 0;line-height:1.45}
.ch20 .ch20-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}
.ch20 .ch20-meet{color:var(--dim, #8b949e);font-size:13px}
.ch20 .ch20-confirm{border-color:var(--gv, #f7931a)}
.ch20 .ch20-yes{display:flex;gap:8px;align-items:flex-start;margin-top:8px;font-weight:600}
.ch20 .ch20-yes input{width:18px;height:18px;margin-top:2px;flex:none}`;
