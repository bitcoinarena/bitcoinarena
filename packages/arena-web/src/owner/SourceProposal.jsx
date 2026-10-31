// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW SOURCE FOR THE VOTE (kanban #921, the owner 2026-10-31: "Die Votings für neue Quellen müssen auch ein example beinhalten und das wird live in der ui validiert und
// getestet, ohne gehts nicht raus"): an example of what the host answers and the link to its documentation, tried live. The proposal opens only for the exact
// values that just answered, and any change closes it again.
import React from 'react';
import { encodeSourceList, hostListProblem, marketUrlProblem } from '../../../arena-protocol/src/market-check.js';
import { SOURCE_ENTRIES } from '../../../arena-protocol/src/market-sources.js';
import { tryExample } from './marketRun.js';

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

export class SourceProposal extends React.Component {
  constructor(props) { super(props); this.state = { url: '', read: 'json', path: '', docs: '', test: null, reading: false, shown: false }; }
  componentDidMount() { if (this.props.readListed) this.props.readListed().then((r) => this.setState({ listed: r.entries || null })).catch(() => {}); }
  entry() { const s = this.state; return { host: hostOf(s.url.trim()), url: s.url.trim(), read: s.read, path: s.read === 'text' ? '' : s.path.trim(), docs: s.docs.trim() }; }
  set(x) { this.setState({ ...x, shown: false }); }
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
    const stop = entryProblem(entry, listed.map((e) => e.host));
    const test = s.test && s.test.key === key ? s.test : null;
    const passed = !!(test && test.ok) && !stop;
    return (
      <div className="mc mc-pane">
        <label className="mc-f"><span>Example address</span><input inputMode="url" placeholder="https://" value={s.url} onChange={(e) => this.set({ url: e.target.value })} /></label>
        {stop ? <div className="mc-err">{stop}</div> : null}
        <div className="mc-seg" role="radiogroup" aria-label="How to read it">{[['json', 'JSON field'], ['regex', 'Pattern'], ['text', 'Whole answer']].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={s.read === k} className={s.read === k ? 'on' : undefined} onClick={() => this.set({ read: k })}>{l}</button>)}</div>
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
            <dt>Reads</dt><dd className="mono">{entry.read === 'text' ? 'whole answer' : entry.path}</dd>
            <dt>Vote</dt><dd>1 day of review, 2 days of voting, live 6 hours later</dd>
            <dt>Passes with</dt><dd>20 % turnout, more yes than no, yes at least 25 % of all bonded capital</dd>
          </dl>
          <p className="mc-note">Every node reads this example again when it takes the proposal, and shows the voters what it saw. Publishing arrives with the next node release.</p>
        </> : null}
      </div>);
  }
}
