// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW SOURCE FOR THE VOTE (kanban #921, the owner 2026-10-31: "Die Votings für neue Quellen müssen auch ein example beinhalten und das wird live in der ui validiert und
// getestet, ohne gehts nicht raus"): an example of what the host answers and the link to its documentation, tried live. The proposal opens only for the exact
// values that just answered, and any change closes it again.
import React from 'react';
import { parse } from 'acorn';
import { checkMarketCode, encodeSourceList, hostListProblem, marketUrlProblem } from '../../../arena-protocol/src/market-check.js';
import { CodeEditor } from './CodeEditor.jsx';
import { SOURCE_ENTRIES } from '../../../arena-protocol/src/market-sources.js';
import { tryExample } from './marketRun.js';

// THE DEFAULT, READY TO CHANGE (the owner 2026-10-31: "einen default für den init Code ..., den der User ändern kann"): as it stands it sends nothing, so it runs on any socket
// and need not go into the list.
export const INIT_DEFAULT = `// Runs on connecting (step 0), then on each of the first messages.
// Answer what to send: text, a list of them, or null.
function init(message, step) {
  if (step > 0) return null;
  // To ask for data, answer the socket's message, for example:
  // return JSON.stringify({ type: 'subscribe', channel: 'ticker' });
  return null;
}
`;
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
/** The list a proposal would carry: the list live now and the new host. */
export const proposedList = (listed, entry) => encodeSourceList([...listed, entry]);
/** What stops the entry before any read, or null. */
export function entryProblem(entry, hosts) {
  if (!entry.url) return null;
  if (marketUrlProblem(entry.url, entry.url.startsWith('wss:'))) return marketUrlProblem(entry.url, entry.url.startsWith('wss:'));
  if (hosts.includes(entry.host)) return `${entry.host} is already listed`;
  return null;
}

/** THE SOURCES UP FOR A VOTE: what each adds, what this node read, the example tried live, and Yes only for an example that answered here just now. */
export class SourceVotes extends React.Component {
  constructor(props) { super(props); this.state = { list: [], tests: {}, said: {} }; }
  componentDidMount() { this.reread(); }
  reread() { if (this.props.readProposals) this.props.readProposals().then((r) => this.setState({ tip: r.tip, list: (r.proposals || []).filter((p) => p.class === 'SOURCES' && ['review', 'voting'].includes(p.phase)) })).catch(() => {}); }
  async test(p) {
    const got = await Promise.all((p.added || []).map((e) => this.props.tryOnNode({ example: e }).catch((x) => ({ ok: false, why: x.message }))));
    this.setState({ tests: { ...this.state.tests, [p.id]: got } });
  }
  async vote(p, choice) {
    const r = await this.props.voteSource({ proposalId: p.id, choice }).catch((e) => ({ ok: false, why: e.message }));
    this.setState({ said: { ...this.state.said, [p.id]: r } });
  }
  render() {
    const s = this.state;
    if (!s.list.length) return null;
    return (<div className="mc mc-pane"><h3>Sources up for a vote</h3>{s.list.map((p) => {
      const t = s.tests[p.id], passed = !!t && t.every((x) => x.ok), said = s.said[p.id];
      return <div key={p.id} className="mc-vote">
        {(p.added || []).map((e, i) => <div key={e.host}>
          <b>{e.host}</b> <a href={e.docs} target="_blank" rel="noopener noreferrer">Docs ↗</a>
          <div className="mono">{e.url}</div>
          {e.init ? <pre className="mc-code mono" aria-label={`${e.host} init code`}>{e.init}</pre> : null}
          {(p.example || [])[i] ? <div className={p.example[i].ok ? 'mc-check ok' : 'mc-check bad'}>When this node took it: {p.example[i].ok ? p.example[i].value : p.example[i].why}</div> : null}
          {t ? <div className={t[i].ok ? 'mc-check ok' : 'mc-check bad'}>Just now: {t[i].ok ? t[i].value : t[i].why}</div> : null}
        </div>)}
        <div className="mc-nav">
          <button type="button" className="mc-test" onClick={() => this.test(p)}>Test it live</button>
          {p.phase === 'voting' ? <>
            <button type="button" className="primary" disabled={!passed} onClick={() => this.vote(p, 'YES')}>Yes</button>
            <button type="button" onClick={() => this.vote(p, 'NO')}>No</button>
            <button type="button" onClick={() => this.vote(p, 'ABSTAIN')}>Abstain</button></> : <span className="mc-note">Voting opens at block {p.votingFrom}</span>}
        </div>
        {said ? <div className={said.ok ? 'mc-check ok' : 'mc-check bad'}>{said.ok ? (said.sent ? 'Your vote is sent.' : <>Send this as an OP_RETURN output from your wallet: <span className="mono">{said.opReturn}</span></>) : said.why}</div> : null}
      </div>; })}</div>);
  }
}

export class SourceProposal extends React.Component {
  constructor(props) { super(props); this.state = { url: '', read: 'json', path: '', docs: '', init: INIT_DEFAULT, test: null, reading: false, shown: false }; }
  componentDidMount() { if (this.props.readListed) this.props.readListed().then((r) => this.setState({ listed: r.entries || null })).catch(() => {}); }
  entry() { const s = this.state; return { host: hostOf(s.url.trim()), url: s.url.trim(), read: s.read, path: s.read === 'text' ? '' : s.path.trim(), docs: s.docs.trim(), init: s.url.trim().startsWith('wss:') && s.init !== INIT_DEFAULT ? s.init.trim() : '' }; }
  set(x) { this.setState({ ...x, shown: false }); }
  /** The deposit first; the proposal once it has confirmed. Either answer can be asked for again, so a closed page loses nothing but the wait. */
  async publish() {
    const entry = this.entry(), s = this.state;
    this.setState({ busy: true, publishWhy: '' });
    try {
      if (!s.txid && !s.pay) {
        const r = await this.props.proposeSource({ entry });
        if (!r.ok) return this.setState({ busy: false, publishWhy: r.why });
        if (!r.paid) return this.setState({ busy: false, pay: r });
        this.setState({ txid: r.txid });
        return this.later();
      }
      const r = await this.props.proposeSource({ entry, txid: (s.txid || '').trim(), ...(s.blockHash ? { blockHash: s.blockHash.trim() } : {}) });
      if (r.waiting) return this.later();
      if (!r.ok) return this.setState({ busy: false, publishWhy: r.why });
      this.setState({ busy: false, done: r });
    } catch (e) { this.setState({ busy: false, publishWhy: e.message }); }
  }
  later() { this.setState({ busy: false, waiting: true }); clearTimeout(this.timer); this.timer = setTimeout(() => this.publish(), 30000); }
  componentWillUnmount() { clearTimeout(this.timer); }
  publishing() {
    const s = this.state;
    if (!this.props.proposeSource) return <p className="mc-note">Publishing needs your node.</p>;
    if (s.done) return <div className="mc-check ok">Published. {s.done.seats.took} of {s.done.seats.asked} nodes took it. Voting opens at block {s.done.votingFrom}.</div>;
    return (<>
      {s.pay ? <>
        <p className="mc-note">Pay this from your wallet:</p>
        <ul className="mc-check">{s.pay.outputs.map((o) => <li key={o.script}><span className="mono">{o.script}</span> · {o.sats} sat</li>)}</ul>
        <label className="mc-f"><span>Deposit transaction</span><input className="mono" value={s.txid || ''} onChange={(e) => this.setState({ txid: e.target.value })} /></label>
        <label className="mc-f"><span>Block it confirmed in</span><input className="mono" value={s.blockHash || ''} onChange={(e) => this.setState({ blockHash: e.target.value })} /></label>
      </> : null}
      <div className="mc-nav"><button type="button" className="primary" disabled={s.busy || s.waiting || (s.pay && !s.txid)} onClick={() => this.publish()}>{s.waiting ? 'Waiting for a block…' : s.busy ? 'Working…' : s.pay ? 'Publish' : 'Pay the deposit and publish'}</button></div>
      {s.publishWhy ? <div className="mc-check bad">{s.publishWhy}</div> : null}
    </>);
  }
  async test() {
    const entry = this.entry(), key = JSON.stringify(entry);
    const bad = hostListProblem(encodeSourceList([entry]));
    if (bad) return this.setState({ test: { key, ok: false, why: bad } });
    this.setState({ reading: true, test: null });
    const got = await (this.props.tryOnNode ? this.props.tryOnNode({ example: entry }) : tryExample(entry)).catch((e) => ({ ok: false, why: e.message }));
    this.setState({ reading: false, test: { key, ...got } });
  }
  render() {
    const s = this.state, entry = this.entry(), key = JSON.stringify(entry), listed = s.listed || SOURCE_ENTRIES;
    const check = entry.init ? checkMarketCode(entry.init, parse, 'init') : null;
    const stop = entryProblem(entry, listed.map((e) => e.host)) || (check && !check.ok ? 'The init code fails its check' : null);
    const test = s.test && s.test.key === key ? s.test : null;
    const passed = !!(test && test.ok) && !stop;
    return (
      <div className="mc mc-pane">
        <label className="mc-f"><span>Example address</span><input inputMode="url" placeholder="https://" value={s.url} onChange={(e) => this.set({ url: e.target.value })} /></label>
        {stop ? <div className="mc-err">{stop}</div> : null}
        <div className="mc-seg" role="radiogroup" aria-label="How to read it">{[['json', 'JSON field'], ['regex', 'Pattern'], ['text', 'Whole answer']].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={s.read === k} className={s.read === k ? 'on' : undefined} onClick={() => this.set({ read: k })}>{l}</button>)}</div>
        {s.url.startsWith('wss:') ? <>
          <div className="mc-f"><span>Init code</span></div>
          <CodeEditor value={s.init} onChange={(init) => this.set({ init })} marked={check && !check.ok ? check.problems.map((p) => p.line) : []} />
          {check && check.ok ? <div className="mc-check ok">Readable code · check {check.version}</div> : null}
          {check && !check.ok ? <ul className="mc-check bad">{check.problems.map((p, i) => <li key={i}><b>Line {p.line}</b> {p.why}</li>)}</ul> : null}
        </> : null}
        {s.read === 'text' ? null : <label className="mc-f"><span>{s.read === 'json' ? 'Field' : 'Pattern'}</span><input className="mono" value={s.path} onChange={(e) => this.set({ path: e.target.value })} /></label>}
        <label className="mc-f"><span>Documentation link</span><input inputMode="url" placeholder="https://" value={s.docs} onChange={(e) => this.set({ docs: e.target.value })} /></label>
        <button type="button" className="mc-test" disabled={s.reading || !!stop || !entry.url} onClick={() => this.test()}>{s.reading ? 'Reading…' : 'Test it live'}</button>
        {test ? <div className={test.ok ? 'mc-check ok' : 'mc-check bad'}>{test.ok ? <>{entry.host} answered <b className="mono">{test.value}</b></> : test.why}</div> : null}
        <div className="mc-nav"><button type="button" className="primary" disabled={!passed} onClick={() => this.setState({ shown: true })}>Make the proposal</button></div>
        {passed ? null : <p className="mc-note">The proposal opens once this example answers.</p>}
        {passed && s.shown ? <>
          <dl className="mc-sum">
            <dt>Adds</dt><dd>{entry.host}</dd>
            <dt>Example</dt><dd className="mono">{entry.url}</dd>
            {entry.init ? <><dt>Starts with</dt><dd>its init code, run in the sandbox</dd></> : null}
          <dt>Reads</dt><dd className="mono">{entry.read === 'text' ? 'whole answer' : entry.path}</dd>
            <dt>Vote</dt><dd>1 day of review, 2 days of voting, live 6 hours later</dd>
            <dt>Passes with</dt><dd>20 % turnout, more yes than no, yes at least 25 % of all bonded capital</dd>
          </dl>
          <p className="mc-note">Every node reads this example again when it takes the proposal, and shows the voters what it saw.</p>
          {this.publishing()}
        </> : null}
      </div>);
  }
}
