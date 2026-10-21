// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ZAP BOX IN REACT (kanban #564, the Arena page): the same box, drawn from what the page's zaps block holds - its title, who it goes
// to, the amounts (one pressed), the message field when it is a tip, the button and the line under it. The page keeps every step of a
// zap (the address looked up, the invoice checked, the payment on the press only) and its own elements as the state; a tap here is
// handed back to it (`onChoose`, `onMsg`, `onGo`, `onClose`). A class component; it never pays anything itself.
import React from 'react';

export class ZapCard extends React.Component {
  render() {
    const v = this.props.view, { onChoose, onMsg, onGo, onClose } = this.props;
    return (
      <div className="zb">
        <div className="zt"><h3>{v.title}</h3><button type="button" className="x" aria-label="Close" onClick={onClose}>&times;</button></div>
        <div className="to">{v.to}</div>
        <div className="amts" role="group" aria-label="amount">
          {v.amounts.map((a, i) => <button key={a.msat} type="button" aria-pressed={a.pressed ? 'true' : 'false'} onClick={() => onChoose(i)}>{a.label}</button>)}
        </div>
        {v.showMsg ? <input className="msg" type="text" maxLength={140} autoComplete="off" placeholder="A message (optional)" value={v.msg} onChange={(e) => onMsg(e.target.value)} /> : null}
        <button type="button" className="go" disabled={v.goDisabled} onClick={onGo}>{v.goLabel}</button>
        <div className={`st${v.stKind ? ` ${v.stKind}` : ''}`} role="status">{v.st}</div>
      </div>);
  }
}
