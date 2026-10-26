// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA'S PIECES, AS CLASS COMPONENTS (kanban #564, 2026-10-21: "Also use react classes not use reducer"): state in this.state
// and setState, no hooks. The classes are arena.css's, so a ported page looks as the old one did.
import React from 'react';

/** A small status label: on (green), wait (amber), or plain. */
export class Pill extends React.Component {
  render() {
    const { tone = null, children } = this.props;
    return <span className={`pill${tone ? ` ${tone}` : ''}`}>{children}</span>;
  }
}

/** An on/off switch. Controlled: `checked` and `onChange(next)`. */
export class Switch extends React.Component {
  constructor(props) { super(props); this.onChange = this.onChange.bind(this); }
  onChange(e) { if (this.props.onChange) this.props.onChange(e.target.checked); }
  render() {
    const { checked, label, id, disabled = false } = this.props;
    return (
      <label className="switch" title={label}>
        <input type="checkbox" id={id} aria-label={label} checked={!!checked} disabled={disabled} onChange={this.onChange} />
        <span />
      </label>
    );
  }
}

/** A button; `primary` for the one that moves on. */
export class Button extends React.Component {
  render() {
    const { primary = false, disabled = false, onClick, children } = this.props;
    return <button type="button" className={primary ? 'primary' : undefined} disabled={disabled} onClick={onClick}>{children}</button>;
  }
}

/** One card in a grid of tiles: an icon, a name, a pill, a coloured line, a description, and a footer (a switch or a link). */
export class Tile extends React.Component {
  render() {
    const { id, icon, name, pill, pillTone, highlight, does, state = null, footer } = this.props;
    return (
      <div className={`tile${state ? ` ${state}` : ''}`} id={id}>
        <div className="head"><span className="ico" aria-hidden="true">{icon}</span><h4>{name}</h4><Pill tone={pillTone}>{pill}</Pill></div>
        <p className="earn">{highlight}</p>
        <p className="does">{does}</p>
        <div className="foot">{footer}</div>
      </div>
    );
  }
}

/** The bar that appears once something changed: what changed, and the actions. Hidden while there is nothing to save. */
export class SaveBar extends React.Component {
  render() {
    const { open, label, children, message = null } = this.props;
    if (!open) return null;
    return (
      <div className="savebar" role="status">
        <span>{label}</span><span>{children}</span>
        {message ? <div style={{ flexBasis: '100%' }}>{message}</div> : null}
      </div>
    );
  }
}

// A COPY ICON, NOT THE WORD (kanban #717, 2026-10-26, the owner: "add copy button to these items on the dashboard" - "As a copy icon, not
// as Copy. Same for above. Also in the public dashboard"): two sheets; a tick for a moment once copied
export class CopyButton extends React.Component {
  constructor(props) { super(props); this.state = { done: false }; this.copy = this.copy.bind(this); }
  componentWillUnmount() { clearTimeout(this.timer); }
  copy() {
    try { navigator.clipboard.writeText(String(this.props.text)); } catch { /* no clipboard */ }
    this.setState({ done: true }); clearTimeout(this.timer); this.timer = setTimeout(() => this.setState({ done: false }), 1500);
  }
  render() {
    return (
      <button type="button" className="fact-copy copy-ic" title={this.state.done ? 'Copied' : 'Copy'} aria-label={this.props.label || 'Copy'} onClick={this.copy}>
        {this.state.done ? <span aria-hidden="true">✓</span>
          : <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.2" /></svg>}
      </button>);
  }
}
