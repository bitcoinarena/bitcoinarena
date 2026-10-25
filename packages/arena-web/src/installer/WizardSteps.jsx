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

/**
 * The steps along the top: { steps: [[key, title]], done: { key: true }, now } - done ones ticked, the current one marked and scrolled into
 * view (the bar scrolls sideways on a phone).
 */
export class StepBar extends React.Component {
  constructor(p) { super(p); this.now = React.createRef(); }
  componentDidMount() { this.reveal(); }
  componentDidUpdate() { this.reveal(); }
  reveal() {
    const li = this.now.current, bar = li && li.parentElement;
    if (bar) bar.scrollLeft = Math.max(0, li.offsetLeft - bar.offsetLeft - 40);
  }
  // A DONE STEP OPENS AGAIN (kanban #635, the owner's playtest 2026-10-25: "ich kann auch nicht zurück gehen und den Zustand prüfen"):
  // `onPick(key)` for a done step and for the current one (`current`, which takes the wizard back); `now` is the step shown
  render() {
    const { steps, done = {}, now, current = now, onPick } = this.props;
    return steps.map(([k, t]) => {
      const open = onPick && (done[k] || k === current);
      const cls = [done[k] ? 'done' : '', k === now ? 'now' : '', k === current && k !== now ? 'current' : ''].filter(Boolean).join(' ');
      return <li key={k} ref={k === now ? this.now : null} className={cls}
        {...(open ? { role: 'button', tabIndex: 0, title: k === current ? 'Back to the current step' : 'Look at this step again',
          onClick: () => onPick(k), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(k); } } } : {})}>{t}</li>;
    });
  }
}

/** The installer cannot set up here (GET /api/state not ok): the page's heading and why, in place of the steps. */
export const SetupRefused = ({ why }) => <><h1>Bitcoin Arena setup</h1><p>{why}</p></>;

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
  toggle(k, v) {
    this.setState((s) => ({ on: { ...s.on, [k]: v } }), async () => {
      this.tell();
      // checked at once (kanban #641): a role this node cannot run says why as it is switched on
      if (!['custody', 'liquidity'].includes(k)) return;
      const r = await this.props.post('/api/roles/check', { roles: this.chosen() });
      this.setState({ msg: r.ok ? null : said(r) });
    });
  }
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
        {this.props.st.chainSwitchedFrom ? <p className="msg ok" id="chain-switched">The Electrum server you chose did not answer ({this.props.st.chainSwitchedFrom}), so setup uses {this.props.st.chain ? `${this.props.st.chain.host}:${this.props.st.chain.port}` : 'another one'} instead.</p> : null}
        <div className="tiles">
          {Object.entries(info).map(([k, r]) => (
            <Tile key={k} id={`role-${k}`} icon={ROLE_IC[k] || '•'} name={r.title} state={on[k] ? 'on' : null}
              pill={OPT_IN_ROLES.includes(k) ? 'needs coins + LND' : '1 % of each round'} pillTone={OPT_IN_ROLES.includes(k) ? 'wait' : null}
              highlight={r.does || ''}
              does={<>{(r.chips || []).map((c) => <span key={c} className="chip">{c}</span>)}</>}
              footer={<>
                <details className="more"><summary>more</summary><div className="more-pop"><p>{ROLE_EARN[k] || ''}</p><p>{r.needs}</p></div></details>
                <Switch id={`rl-${k}`} label={r.title} checked={!!on[k]} disabled={r.slice > 1} onChange={(v) => this.toggle(k, v)} />
              </>} />))}
        </div>
        <p className="sub">{this.chosen().length ? `${this.chosen().length} role${this.chosen().length === 1 ? '' : 's'} on · each earns its own 1 %` : 'No role on: your node would only watch.'}</p>
        <button type="button" disabled={saving} onClick={this.save}>{saving ? 'Saving…' : 'Save and continue'}</button>
        <Msg r={msg} />
      </div>
    );
  }
}

// THE APPS (kanban #569, 2026-10-21: "The node still comes with the 3 apps pre installed, that is a step in the installer where
// all apps are automatically selected"): one tile per app the release carries, every one switched on at first; the node hosts the ones
// left on (each version still played: "N versions")
export const APP_IC = Object.freeze({ nextblock: '⏱️', 'rock-paper-scissors': '✊', 'btc-updown': '📈' });
/** On at the start: a saved choice as saved; with none, every app. */
export const appOnAtStart = (id, saved) => !(saved || []).length || saved.includes(id);

export class AppsStep extends React.Component {
  constructor(props) {
    super(props);
    const info = props.st.appInfo || [];
    this.state = { on: Object.fromEntries(info.map((a) => [a.id, appOnAtStart(a.id, props.st.apps)])), saving: false, msg: null };
    this.save = this.save.bind(this);
  }
  toggle(id, v) { this.setState((s) => ({ on: { ...s.on, [id]: v } })); }
  chosen() { return (this.props.st.appInfo || []).map((a) => a.id).filter((id) => this.state.on[id]); }
  async save() {
    this.setState({ saving: true, msg: null });
    const r = await this.props.post('/api/apps', { apps: this.chosen() });
    if (r.ok) { this.setState({ saving: false }); return this.props.reload(); }
    this.setState({ saving: false, msg: said(r) });
  }
  render() {
    const info = this.props.st.appInfo || [];
    const { on, saving, msg } = this.state;
    const n = this.chosen().length;
    return (
      <div className="aw">
        <h2>4. Your apps</h2>
        <p className="sub">The games your node hosts. It checks and settles their rounds. All are on; switch off any you do not want.</p>
        <div className="tiles">
          {info.map((a) => (
            <Tile key={a.id} id={`app-${a.id}`} icon={APP_IC[a.id] || '🎮'} name={a.title} state={on[a.id] ? 'on' : null}
              pill={`${a.versions} version${a.versions === 1 ? '' : 's'}`} highlight={a.short !== a.title ? a.short : ''}
              footer={<Switch id={`ap-${a.id}`} label={a.title} checked={!!on[a.id]} onChange={(v) => this.toggle(a.id, v)} />} />))}
        </div>
        <p className="sub">{info.length ? (n ? `${n} of ${info.length} app${info.length === 1 ? '' : 's'} on` : 'No app on: choose at least one.') : 'This release lists no apps: your node hosts Next Block.'}</p>
        <button type="button" disabled={saving || (info.length > 0 && !n)} onClick={this.save}>{saving ? 'Saving…' : 'Continue'}</button>
        <Msg r={msg} />
      </div>
    );
  }
}

// HOW THIS NODE IS CONTROLLED, THEN NEW OR RESTORED (kanban #652/#654, 2026-10-25: "User first selects Operation Mode: Nostr /
// New Seed (24 Words)", then new or restore; #653 "Only allow nsec then")
export class StartStep extends React.Component {
  constructor(props) {
    super(props);
    const st = props.st || {};
    this.state = { control: st.control || 'words', action: st.origin || 'new', words: '', nsec: '', made: null, busy: false, msg: null, code: null, ...(props.initial || {}) };
    this.go = this.go.bind(this); this.makeKey = this.makeKey.bind(this);
  }
  async makeKey() {
    const r = await this.props.post('/api/start/nsec');
    if (!r.ok) return this.setState({ msg: said(r) });
    this.setState({ nsec: r.nsec, made: r.nsec, msg: null });
  }
  async go() {
    const { control, action, words, nsec } = this.state;
    this.setState({ busy: true, msg: null });
    const r = await this.props.post('/api/start', { control, action, words: control === 'words' && action === 'restore' ? words : undefined, nsec: control === 'nostr' ? nsec : undefined });
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ msg: said(r) });
    this.setState({ words: '', nsec: '', made: null });
    this.props.reload();   // the emergency code has its own step next (kanban #647)
  }
  render() {
    const { control, action, words, nsec, made, busy, msg } = this.state;
    const n = words.trim() ? words.trim().split(/\s+/).length : 0;
    const pick = (name, value, cur, title, text) => (
      <label className={`choice${cur === value ? ' on' : ''}`}><input type="radio" name={name} id={`start-${name}-${value}`} checked={cur === value} onChange={() => this.setState({ [name]: value, msg: null })} />
        <div><b>{title}</b><p>{text}</p></div></label>);
    const ready = control === 'words' ? (action === 'new' || n === 24) : /^nsec1/i.test(nsec.trim());
    return (
      <div className="aw">
        <h2>1. How you control your node</h2>
        <div className="choices">
          {pick('control', 'words', control, '24 words', 'Setup makes or restores 24 words. They hold your node\'s wallet and keys, and log you in as its owner.')}
          {pick('control', 'nostr', control, 'Nostr key (nsec)', 'Your Nostr key is your node: its identity on the network, its wallet and keys come from it, and you log in with it. No extra words to keep.')}
        </div>
        <h3>New or restore</h3>
        <div className="choices">
          {control === 'words' ? <>
            {pick('action', 'new', action, 'Set up a new node', 'Setup makes new 24 words. You write them down in step 5.')}
            {pick('action', 'restore', action, 'Restore from my 24 words', 'For a node you set up before, on this or another computer. The node comes back from the words.')}
          </> : <>
            {pick('action', 'new', action, 'Use my Nostr key for a new node', 'Your Nostr key becomes this node\'s only key.')}
            {pick('action', 'restore', action, 'Restore my node from my Nostr key', 'For a node you set up before with this Nostr key. It comes back from the key.')}
          </>}
        </div>
        {control === 'words' && action === 'restore' ? <>
          <label htmlFor="start-words">Your 24 words, in order, separated by spaces</label>
          <textarea id="start-words" rows="4" autoComplete="off" autoCapitalize="off" spellCheck="false" value={words} onChange={(e) => this.setState({ words: e.target.value })} />
          <p className="sub">{n} of 24 words. Type them only here, on your own computer.</p>
        </> : null}
        {control === 'nostr' ? <>
          <label htmlFor="start-nsec">Your nsec</label>
          <input id="start-nsec" type="password" autoComplete="off" spellCheck="false" placeholder="nsec1…" value={nsec} onChange={(e) => this.setState({ nsec: e.target.value, made: null })} />
          <p className="sub">Only on a computer you trust. Your node keeps it: it is your node's own key on the network and signs for it, also when you are away.</p>
          {action === 'new' && !nsec ? <button type="button" className="ghost" id="start-make" onClick={this.makeKey}>New to Nostr? Create a key</button> : null}
          {made ? <div className="msg ok" id="start-made"><b>Your new Nostr key.</b> Save it in a password manager or a Nostr app now. Without it you cannot log in to or restore this node:<pre>{made}</pre></div> : null}
        </> : null}
        <button type="button" id="start-go" disabled={busy || !ready} onClick={this.go}>{action === 'restore' ? 'Restore' : 'Continue'}</button>
        <Msg r={msg} />
      </div>);
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
    if (r.ok) return this.props.reload();
    this.setState({ msg: said(r), ...(r.wrong ? { phase: 'start', words: [] } : {}) });
  }
  render() {
    const { phase, words, positions, answers, msg } = this.state;
    return (
      <div className="aw">
        <h2>5. Your seed: write it down</h2>
        <p>These 24 words are your node's wallet and your owner login. <b>Write them on paper, in order.</b> Anyone who has them owns your node. Without them, a lost computer means a lost node.</p>
        {phase === 'start' ? <button type="button" id="seed-show" onClick={this.show}>Show my 24 words</button> : null}
        {phase === 'shown' ? <>
          <div className="words">{words.map((w, i) => <span key={i}><b>{i + 1}</b>{w}</span>)}</div>
          <button type="button" id="seed-written" onClick={this.written}>I have written them down</button></> : null}
        {phase === 'confirm' ? <>
          <p>Now type these words from your paper:</p>
          <div className="row">{positions.map((p, i) => (
            <div key={p}><label htmlFor={`cw-${p}`}>word {p}</label>
              <input id={`cw-${p}`} autoComplete="off" spellCheck="false" autoFocus={i === 0} value={answers[p] || ''}
                onChange={(e) => this.setState({ answers: { ...answers, [p]: e.target.value } })} /></div>))}</div>
          <button type="button" id="seed-confirm" onClick={this.confirm}>Confirm</button></> : null}
        <Msg r={msg} />
      </div>
    );
  }
}

// THE EMERGENCY CODE, ITS OWN STEP (kanban #647, the owner's playtest 2026-10-25: "the emergency code notice should be an overlay or a separate
// step ... also the description is confusing" - "extra step it is, and make the text clearer and simpler")
export class EmergencyStep extends React.Component {
  constructor(props) { super(props); this.state = { code: null, msg: null, busy: false }; this.done = this.done.bind(this); }
  async componentDidMount() {
    const r = await this.props.get('/api/emergency');
    this.setState(r.ok ? { code: r.code } : { msg: said(r) });
  }
  async done() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/emergency/written');
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ msg: said(r) });
    this.props.reload();
  }
  render() {
    const { code, msg, busy } = this.state;
    const nostr = this.props.st && this.props.st.control === 'nostr';
    return (
      <div className="aw">
        <h2>6. Your emergency code</h2>
        <p>Write this code down and keep it with your {nostr ? 'Nostr key' : '24 words'}.</p>
        <p className="code" id="emergency-code">{code || '…'}</p>
        <h3>When you need it</h3>
        <p>Your computer breaks, or your node will be offline for more than a day or two. Type the code at <b>testnet.bitcoin-arena.io/offline</b> from any phone or computer. Your node then leaves the network cleanly, and you keep your bond.</p>
        <h3>What it cannot do</h3>
        <p>It cannot move money or change anything else. So it is safe to type on other devices. Your {nostr ? 'Nostr key' : '24 words'} are not: type {nostr ? 'it' : 'them'} only on your own node.</p>
        <button type="button" id="emergency-done" disabled={busy || !code} onClick={this.done}>I have written the code down</button>
        <Msg r={msg} />
      </div>);
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
        <h2>7. Owner login</h2>
        <p className="sub">How you log in to your node's owner page later.</p>
        <div className="choices">
          {this.choice('seed', 'My 24 words', 'Type them on the owner page in any browser. They stay in that browser.')}
          {this.choice('nostr', 'Nostr', 'Log in with your Nostr key: a browser extension such as Alby or nos2x, or paste your npub.', mode === 'nostr' ? <>
            <label htmlFor="npub">npub</label><input id="npub" placeholder="npub1..." value={npub} onChange={(e) => this.setState({ npub: e.target.value })} />
          </> : null)}
        </div>
        <button type="button" className="ghost" onClick={this.fromExtension}>Read from my Nostr extension</button>
        <button type="button" onClick={this.save}>Save and continue</button>
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
        <h2>12. Your bond: the rules</h2>
        <div className="rules">
          <div className="rule"><div className="ic">🔒</div><div><b>Your bond is your promise.</b><p>Bitcoin your node locks on the chain. Cheating would cost more than it could ever win, so players can trust a node they have never met.</p></div></div>
          <div className="rule good"><div className="ic">✅</div><div><b>Stopping? Press LEAVE first.</b><p>Press it on your owner page. Your node finishes its rounds and gives notice to its federation. Then you are free, and your bond comes back when its lock ends.</p></div></div>
          <div className="rule bad"><div className="ic">⚠️</div><div><b>Switching off without LEAVE:</b><p><b className="red">Your bond is slashed: you lose it.</b> A guardian that disappears leaves its federation short and puts the bitcoin it guards at risk.</p></div></div>
        </div>
        <label htmlFor="promise-text">Type <b>{PROMISE}</b> to go on</label>
        <input id="promise-text" autoComplete="off" placeholder={PROMISE} value={text} onChange={(e) => this.setState({ text: e.target.value })} />
        <button type="button" disabled={!typed} onClick={this.save}>Continue</button> {typed ? <Pill tone="on">ready</Pill> : null}
        <Msg r={msg} />
      </div>
    );
  }
}
