// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S STEPS, IN REACT (kanban #564): the roles as tiles with a switch each, the 24 words and the emergency code, the owner
// login, and the bond's rules - each a class component the wizard page mounts into its step (the page draws none itself). Each
// step is given the wizard's state (`st`, GET /api/state), its `post(path, body)` (the x-arena-wizard POST) and `reload()` (the page's
// load(): the wizard moves on to the step the installer names). The doors and their answers are the installer's, unchanged.
import React from 'react';
import { Tile, Switch, Pill } from '../design/components.jsx';

// the roles' icons and their share of the 4 % (fee.js, 2026.0.16: four pools of 1 %; custody's third to 2 random gateways per day)
export const ROLE_IC = Object.freeze({ verify: '🎮', settlement: '✍️', custody: '🏦', liquidity: '💧' });
export const ROLE_EARN = Object.freeze({
  verify: '1 % of each round, shared by its 7 seated nodes',
  settlement: '1 % of each round, shared by its 7 seated nodes',
  custody: '1 % of each round of your federation: guardians ⅔, gateways ⅓ (2 per federation, randomly chosen each day)',
  liquidity: '1 % of each round, shared by the liquidity providers: the more coins you hold for new nodes, the bigger your share',
});
// THE ROLES A NEW NODE STARTS WITH: game / verify and settlement. Custody and liquidity are chosen on purpose - each needs LND and coins
// (measured in the Windows VM on rc.14: liquidity was ticked by default, and the bond step asked a custody node for 863,000 sat)
export const OPT_IN_ROLES = Object.freeze(['custody', 'liquidity']);
/** On at the start: a saved choice as saved; with none, every role but the opt-in ones. */
export const onAtStart = (k, saved) => (saved || []).includes(k) || (!(saved || []).length && !OPT_IN_ROLES.includes(k));

/** The wizard's message line: green when it passed, red with the reason when not. */
export class Msg extends React.Component {
  render() {
    const { r } = this.props;
    if (!r) return null;
    return <div className={`msg ${r.ok ? 'ok' : 'bad'}`} role="status">{r.text}</div>;
  }
}
const said = (r, okText) => ({ ok: !!r.ok, text: r.ok ? okText : (r.why || 'failed') });

export class RolesStep extends React.Component {
  constructor(props) {
    super(props);
    const info = props.st.roleInfo || {};
    this.state = { on: Object.fromEntries(Object.keys(info).map((k) => [k, onAtStart(k, props.st.roles)])), saving: false, msg: null };
    this.save = this.save.bind(this);
  }
  componentDidMount() { this.tell(); }
  tell() { if (this.props.onCustody) this.props.onCustody(!!this.state.on.custody); }
  toggle(k, v) { this.setState((s) => ({ on: { ...s.on, [k]: v } }), () => this.tell()); }
  chosen() { return Object.keys(this.state.on).filter((k) => this.state.on[k]); }
  async save() {
    this.setState({ saving: true, msg: null });
    const r = await this.props.post('/api/roles', { roles: this.chosen() });
    if (r.ok) { this.setState({ saving: false }); return this.props.reload(); }
    this.setState({ saving: false, msg: said(r) });
  }
  render() {
    const info = this.props.st.roleInfo || {};
    const { on, saving, msg } = this.state;
    return (
      <div className="aw">
        <div className="tiles">
          {Object.entries(info).map(([k, r]) => (
            <Tile key={k} id={`role-${k}`} icon={ROLE_IC[k] || '•'} name={r.title} state={on[k] ? 'on' : null}
              pill={OPT_IN_ROLES.includes(k) ? 'needs coins + LND' : '1 % of each round'} pillTone={OPT_IN_ROLES.includes(k) ? 'wait' : null}
              highlight={r.does || ''}
              does={<>{(r.chips || []).map((c) => <span key={c} className="chip">{c}</span>)}</>}
              footer={<>
                <details className="more"><summary>more</summary><p>{ROLE_EARN[k] || ''}</p><p>{r.needs}</p></details>
                <Switch id={`rl-${k}`} label={r.title} checked={!!on[k]} disabled={r.slice > 1} onChange={(v) => this.toggle(k, v)} />
              </>} />))}
        </div>
        <p className="sub">{this.chosen().length ? `${this.chosen().length} role${this.chosen().length === 1 ? '' : 's'} on · each earns its own 1 %` : 'No role on: the node would only watch.'}</p>
        <button type="button" disabled={saving} onClick={this.save}>{saving ? 'Saving…' : 'Save and go on'}</button>
        <Msg r={msg} />
      </div>
    );
  }
}

export class SeedStep extends React.Component {
  constructor(props) {
    super(props);
    this.state = { phase: 'start', words: [], positions: [], answers: {}, code: null, msg: null, ...(props.initial || {}) };
    this.show = this.show.bind(this); this.written = this.written.bind(this); this.confirm = this.confirm.bind(this);
  }
  async show() {
    const r = await this.props.post('/api/seed/new');
    if (!r.ok) return this.setState({ msg: said(r) });
    this.setState({ phase: 'shown', words: r.words, positions: r.positions, answers: {}, msg: null });
  }
  // THE WORDS LEAVE THE SCREEN BEFORE THEY ARE ASKED BACK (seen on the wizard's screenshot 06: the 24 words stood beside the three
  // inputs, so the check proved nothing): asked from the paper, not from the page
  written() { this.setState({ phase: 'confirm', words: [] }); }
  async confirm() {
    const r = await this.props.post('/api/seed/confirm', { answers: this.state.answers });
    if (r.ok && r.emergencyCode) return this.setState({ phase: 'emergency', code: r.emergencyCode, msg: null });
    if (r.ok) return this.props.reload();
    this.setState({ msg: said(r), ...(r.wrong ? { phase: 'start', words: [] } : {}) });
  }
  render() {
    const { phase, words, positions, answers, code, msg } = this.state;
    return (
      <div className="aw">
        <h2>3. Your seed: write it down</h2>
        <p>These 24 words are your node's wallet and your owner login. <b>Write them on paper, in order.</b> Anyone with them owns the node; without them a lost machine is a lost node.</p>
        {phase === 'start' ? <button type="button" id="seed-show" onClick={this.show}>Show my 24 words</button> : null}
        {phase === 'shown' ? <>
          <div className="words">{words.map((w, i) => <span key={i}><b>{i + 1}</b>{w}</span>)}</div>
          <button type="button" id="seed-written" onClick={this.written}>I have written them down</button></> : null}
        {phase === 'confirm' ? <>
          <p>Now type back these words from your paper:</p>
          <div className="row">{positions.map((p, i) => (
            <div key={p}><label htmlFor={`cw-${p}`}>word {p}</label>
              <input id={`cw-${p}`} autoComplete="off" spellCheck="false" autoFocus={i === 0} value={answers[p] || ''}
                onChange={(e) => this.setState({ answers: { ...answers, [p]: e.target.value } })} /></div>))}</div>
          <button type="button" id="seed-confirm" onClick={this.confirm}>Confirm</button></> : null}
        {phase === 'emergency' ? (
          // THE EMERGENCY CODE (spec §23A.5a, protocol 17): shown once the words are confirmed, written down beside them
          <div id="emergency">
            <h3>Your emergency code: write it down too</h3>
            <p className="code">{code}</p>
            <p>If this node will be offline longer than the network allows - about two days on mainnet, 12 blocks on testnet4 - type this code on
              any other node's page (<code>/Dashboard/emergency</code>) or on the Arena site (<code>testnet.bitcoin-arena.io/offline/</code>) to take it out of the network. Its bond stays yours: a node with
              no guardian role leaves at once; a guardian leaves at once if the request comes before it counts as abandoned, later it is slashed.</p>
            <p>The code can do nothing else: no money, no settings. <b>Never type your 24 words anywhere but your own node.</b></p>
            <button type="button" onClick={() => this.props.reload()}>I have written the code down</button>
          </div>) : null}
        <Msg r={msg} />
      </div>
    );
  }
}

export class OwnerStep extends React.Component {
  constructor(props) {
    super(props);
    this.state = { mode: 'seed', npub: '', msg: null, ...(props.initial || {}) };
    this.fromExtension = this.fromExtension.bind(this); this.save = this.save.bind(this);
  }
  async fromExtension() {
    const nostr = this.props.nostr || (typeof window !== 'undefined' ? window.nostr : null);
    if (!nostr) return this.setState({ msg: said({ ok: false, why: 'no Nostr extension in this browser - paste your npub instead' }) });
    this.setState({ npub: await nostr.getPublicKey(), mode: 'nostr', msg: null });
  }
  async save() {
    const r = await this.props.post('/api/owner', { mode: this.state.mode, npub: this.state.npub });
    if (r.ok) return this.props.reload();
    this.setState({ msg: said(r) });
  }
  choice(mode, title, text, extra) {
    return (
      <label className={`choice${this.state.mode === mode ? ' on' : ''}`}>
        <input type="radio" name="om" value={mode} checked={this.state.mode === mode} onChange={() => this.setState({ mode })} />
        <div><b>{title}</b><p>{text}</p>{extra}</div>
      </label>);
  }
  render() {
    const { mode, npub, msg } = this.state;
    return (
      <div className="aw">
        <h2>4. Owner login</h2>
        <p className="sub">How you sign in to your node's owner page later.</p>
        <div className="choices">
          {this.choice('seed', 'My 24 words', 'Type them on the owner page in any browser (they stay in that browser).')}
          {this.choice('nostr', 'Nostr', 'Sign in with your Nostr key (a browser extension such as Alby or nos2x, or paste your npub).', mode === 'nostr' ? <>
            <label htmlFor="npub">npub</label><input id="npub" placeholder="npub1..." value={npub} onChange={(e) => this.setState({ npub: e.target.value })} />
          </> : null)}
        </div>
        <button type="button" className="ghost" onClick={this.fromExtension}>Read from my Nostr extension</button>
        <button type="button" onClick={this.save}>Save and go on</button>
        <Msg r={msg} />
      </div>
    );
  }
}

export const PROMISE = 'I UNDERSTAND';
export class PromiseStep extends React.Component {
  constructor(props) { super(props); this.state = { text: '', msg: null, ...(props.initial || {}) }; this.save = this.save.bind(this); }
  async save() {
    const r = await this.props.post('/api/promise', { text: this.state.text });
    if (!r.ok) return this.setState({ msg: said(r) });
    this.props.reload();
  }
  render() {
    const { text, msg } = this.state;
    const typed = text.trim().toUpperCase() === PROMISE;
    return (
      <div className="aw">
        <h2>9. Your bond: the rules</h2>
        <div className="rules">
          <div className="rule"><div className="ic">🔒</div><div><b>Your bond is your promise.</b><p>Bitcoin your node locks on the chain. It makes cheating cost more than it could ever win - that is why players can trust a node they have never met.</p></div></div>
          <div className="rule good"><div className="ic">✅</div><div><b>Stopping? Press LEAVE first.</b><p>On your owner page. Your node finishes the rounds it holds and gives notice to its federation, then you are free. Your bond comes back when its lock ends.</p></div></div>
          <div className="rule bad"><div className="ic">⚠️</div><div><b>Just switching off - without LEAVE:</b><p><b className="red">Your bond is slashed: you lose it.</b> A guardian that vanishes leaves its federation short, and the bitcoin it guards at risk.</p></div></div>
        </div>
        <label htmlFor="promise-text">Type <b>{PROMISE}</b> to go on</label>
        <input id="promise-text" autoComplete="off" placeholder={PROMISE} value={text} onChange={(e) => this.setState({ text: e.target.value })} />
        <button type="button" disabled={!typed} onClick={this.save}>Continue</button> {typed ? <Pill tone="on">ready</Pill> : null}
        <Msg r={msg} />
      </div>
    );
  }
}
