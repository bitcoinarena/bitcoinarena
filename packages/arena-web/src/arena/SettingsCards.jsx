// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SETTINGS' OWN CARDS IN REACT (kanban #564, the Arena page): the name others see (update only), Graphics' FPS switch, the client logs
// to copy, the seed phrase (its backup line, Show, restore by the 24 words or the seed) and deleting this account from this browser
// (what it holds said first, "I have my 24 words or my Nostr key" before the button). The page keeps every rule - the lobby's name, the
// stored switch, the log copy, the seed restore, the account's deletion - and hands them over; each card is drawn into its own section.
import React from 'react';

export class NameCard extends React.Component {
  constructor(props) { super(props); this.state = { typed: null, why: '' }; }
  update() {
    const t = (this.state.typed ?? this.props.current).trim();
    if (!t) { this.setState({ why: 'A name is needed.' }); return; }
    this.setState({ why: this.props.onUpdate(t) || 'Updated.', typed: null });
  }
  render() {
    const value = this.state.typed ?? this.props.current;
    const t = value.trim();
    return (<>
      <h3>Name</h3>
      <div className="muted">Current name</div>
      <div className="name-row">
        <input id="arena-name-field" type="text" autoComplete="off" spellCheck={false} maxLength={32} value={value} onChange={(e) => this.setState({ typed: e.target.value })} />
        <button id="arena-name-update" type="button" className="primary" disabled={!t || t === this.props.current} onClick={() => this.update()}>Update</button>
      </div>
      <div className="muted">{this.state.why}</div>
    </>);
  }
}

// SHOW FPS (2026-10-17: "show fps is default off everywhere, there is a toggle in settings")
export class GraphicsCard extends React.Component {
  constructor(props) { super(props); this.state = { on: !!props.on }; }
  render() {
    return (<>
      <h3>Graphics</h3>
      <label className="fps-toggle"><input type="checkbox" id="arena-fps-toggle" checked={this.state.on} onChange={(e) => { this.setState({ on: e.target.checked }); this.props.onToggle(e.target.checked); }} /> Show FPS</label>
    </>);
  }
}

export class LogsCard extends React.Component {
  constructor(props) { super(props); this.state = { said: '' }; }
  async copy() { this.setState({ said: await this.props.onCopy() }); }
  render() {
    return (<>
      <h3>Client logs</h3>
      <div className="muted">What this page did - its log lines, sockets and run state, no seed or keys - to paste to Claude.</div>
      <button id="arena-logs-copy" type="button" onClick={() => this.copy()}>Copy client logs</button>
      <div className="muted">{this.state.said}</div>
    </>);
  }
}

// RESTORE, OVERWRITING THIS TAB'S SEED: the 24 words or the 64 hex
export class SeedCard extends React.Component {
  constructor(props) { super(props); this.state = { text: '', why: '' }; }
  restore() { const got = this.props.onRestore(this.state.text); this.setState({ why: got.ok ? 'restored - reloading' : got.why }); }
  render() {
    return (<>
      <h3>Seed phrase</h3>
      <div className="muted" id="arena-settings-backup">{this.props.backup || 'This wallet is backed up.'}</div>
      <button id="arena-phrase-show" type="button" className="primary" onClick={() => this.props.onShow()}>Show seed phrase</button>
      <div className="muted">Restore: your 24 words (or your seed, 64 hex) replace this tab's seed, and the page reloads.</div>
      <div className="name-row">
        <input type="password" autoComplete="off" placeholder="your 24 words, or your seed (64 hex)" value={this.state.text} onChange={(e) => this.setState({ text: e.target.value })} />
        <button type="button" onClick={() => this.restore()}>use my seed</button>
      </div>
      <div className="muted">{this.state.why}</div>
    </>);
  }
}

// DELETE THIS ACCOUNT FROM THIS BROWSER (2026-10-11: "Im settings screen gibt es die Möglichkeit seinen Account wieder zu löschen um sich
// mit Nostr oder ähnlich einzuloggen"): this tab's phrase, its wallets' data and the Nostr login forgotten here, the start screen back.
// Nothing is sent or spent: the same 24 words or Nostr key bring the wallet back in any browser.
export class AccountCard extends React.Component {
  constructor(props) { super(props); this.state = { asking: false, holds: '', saved: false, why: '' }; }
  ask() { this.setState({ asking: true, holds: this.props.holds(), saved: false, why: '' }); }
  remove() {
    const r = this.props.onDelete();
    if (!r.ok) { this.setState({ why: r.why }); return; }
    this.setState({ why: 'Deleted from this browser - opening the start screen' });
    if (this.props.onDeleted) this.props.onDeleted();
  }
  render() {
    const { asking, holds, saved, why } = this.state;
    return (<>
      <h3>Account</h3>
      <div className="muted">{this.props.who}</div>
      {asking ? null : <button id="arena-acct-delete" type="button" className="danger" onClick={() => this.ask()}>Delete this account from this browser</button>}
      <div className="risk" id="arena-acct-risk">Deleting removes this wallet from this browser. Without your 24 words or your Nostr key, the money in it is lost for good.</div>
      {asking ? (
        <div>
          {holds ? <div className="risk">{holds}</div> : null}
          <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '8px 0' }}>
            <input type="checkbox" style={{ width: 'auto', margin: '2px 0 0' }} checked={saved} onChange={(e) => this.setState({ saved: e.target.checked })} />
            <span>I have my 24 words or my Nostr key. Without them the money in this wallet cannot be opened again.</span></label>
          <div className="name-row">
            <button id="arena-acct-go" type="button" className="primary danger" disabled={!saved} onClick={() => this.remove()}>Delete and log in again</button>
            <button type="button" onClick={() => this.setState({ asking: false })}>Cancel</button>
          </div>
        </div>) : null}
      <div className="muted">{why}</div>
    </>);
  }
}
