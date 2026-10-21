// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROPOSALS FORUM'S READING VIEWS IN REACT (kanban #564, slice 1 of src/arena-ui/proposals): the thread list and one thread. The
// forum's own script (forum.js) still reads the nodes, keeps the player's in-game key and signs and posts; it hands these class
// components plain view data - names, stages, amounts, and a proposal's text as the HTML its own Markdown made (escaped there) - and
// gets the reply back. The new-proposal, fees and payout forms stay its own for now.
import React from 'react';

const Stage = ({ s }) => <span className={`stage ${s.cls}`}>{s.text}</span>;
const Avatar = ({ a }) => <div className="ava" style={{ background: a.colour }}>{a.initial}</div>;

/** The thread list: { status, items: [{ pip, title, by, amount, replies, stage: { cls, text }, href }] or null while reading }. */
export function ProposalList({ status, items }) {
  return (
    <div>
      <div className="bar"><span className="say">{status}</span><a className="btn primary grow" href="#new">New proposal</a></div>
      <div className="topics">
        <div className="th"><span>Proposal</span><span className="n">Amount</span><span className="n">Replies</span><span className="n">Stage</span></div>
        {items && !items.length ? <div className="empty">No proposals yet. Start the first one.</div> : null}
        {(items || []).map((p) => (
          <a key={p.pip} className="topic" href={p.href}>
            <span className="t"><span className="pip">{`PIP-${p.pip}`}</span> {p.title}<span className="by">{p.by}</span></span>
            <span className="amt">{p.amount}</span><span className="n">{p.replies}</span><Stage s={p.stage} />
          </a>))}
      </div>
    </div>);
}

function Post({ p, depth, children }) {
  return (
    <article className={`post${depth ? ' reply' : ''}`} style={depth ? { '--depth': Math.min(depth, 4) } : undefined}>
      <Avatar a={p.avatar} />
      <div>
        <div className="who"><b title={p.npub}>{p.name}</b> · {p.head}</div>
        {p.html !== undefined ? <div className="body md" dangerouslySetInnerHTML={{ __html: p.html }} /> : <div className="body">{p.text}</div>}
        {children}
      </div>
    </article>);
}

/**
 * One thread: { thread: null (not held) | { heading, amount, lnurl, stage, stageLine, post, comments: [{ id, depth, ...post }] }, status,
 * onReply(text, parentId) -> Promise<{ ok, say }> }. A reply goes to the post named by its Reply button, else to the proposal.
 */
export class ProposalThread extends React.Component {
  constructor(props) { super(props); this.state = { text: '', replyTo: null, replyName: null, say: '', bad: false, busy: false }; this.send = this.send.bind(this); this.box = React.createRef(); }
  async send(e) {
    e.preventDefault();
    if (!this.state.text.trim()) return;
    this.setState({ busy: true, say: 'Sending…', bad: false });
    const r = await this.props.onReply(this.state.text, this.state.replyTo);
    this.setState(r.ok ? { busy: false, say: r.say, bad: false, text: '', replyTo: null, replyName: null } : { busy: false, say: r.say, bad: true });
  }
  render() {
    const { thread: t, status } = this.props;
    const { text, replyName, say, bad, busy } = this.state;
    return (
      <div>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        {!t ? <div className="empty">{status}</div> : (
          <>
            <h1>{t.heading}</h1>
            <Post p={t.post} depth={0}>
              <div className="facts"><span><b>{t.amount}</b> to {t.lnurl}</span><Stage s={t.stage} /><span>{t.stageLine}</span></div>
            </Post>
            {t.comments.map((c) => (
              <Post key={c.id} p={c} depth={c.depth}>
                <div className="acts"><button type="button" onClick={() => { this.setState({ replyTo: c.id, replyName: c.name }); if (this.box.current) this.box.current.focus(); }}>Reply</button></div>
              </Post>))}
            <form className="compose" onSubmit={this.send}>
              <textarea ref={this.box} rows={4} maxLength={4000} value={text} placeholder={replyName ? `Reply to ${replyName}` : 'Write a reply'} onChange={(e) => this.setState({ text: e.target.value })} />
              <div className="bar"><button type="submit" className="btn primary" disabled={busy}>Post reply</button><span className={`say${bad ? ' bad' : ''}`}>{say}</span></div>
            </form>
          </>)}
      </div>);
  }
}

// A NEW PROPOSAL (slice 2): the type switch (its other types are forum.js's own forms), the reserves and the cap, title / what it does /
// how it improves (Markdown, with a preview made by forum.js's own Markdown), the amount against the cap and the Lightning address - the
// same checks and words as before - and publish: forum.js signs with the in-game key and hands it to every node (`onPublish`).
export const LN_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export const LNURL = /^lnurl1[02-9ac-hj-np-z]{20,}$/i;
const n = (x) => Number(x).toLocaleString('en-US');

/** The amount and the address against the cap: [ok, words, bad]. */
export function amountCheck({ amount, lnurl }, reserves, capPct) {
  if (!amount) return [true, '', false];
  const a = Number(amount), max = reserves ? Math.floor(reserves.sats * capPct / 100) : null;
  if (!(a >= 1)) return [false, 'Ask at least 1 sat.', true];
  if (!reserves) return [false, 'The reserves could not be read, so the amount cannot be checked yet.', true];
  if (a > max) return [false, `${n(a)} sat is more than ${capPct}% of the reserves (${n(max)} sat): it could never be paid.`, true];
  if (lnurl && !LN_ADDRESS.test(lnurl.trim()) && !LNURL.test(lnurl.trim())) return [false, 'That is not a Lightning address (you@wallet.example) or an LNURL.', true];
  return [true, `Within the cap: ${(a * 100 / reserves.sats).toFixed(2)}% of the reserves.`, false];
}

export class NewProposal extends React.Component {
  constructor(props) {
    super(props);
    this.state = { title: '', content: '', improves: '', amount: '', lnurl: '', preview: false, say: '', bad: false, busy: false };
    this.submit = this.submit.bind(this);
  }
  used() { return this.props.purposeLength(this.state.title, this.state.content, this.state.improves); }
  async submit(e) {
    e.preventDefault();
    const s = this.state, out = (say, bad = true) => this.setState({ say, bad });
    if (!this.props.signedIn) return out('Open the Arena once first: the forum signs with your in-game key.');
    if (!s.title.trim() || !s.content.trim() || !s.improves.trim()) return out('Fill in the title, what it does, and how it improves Bitcoin Arena.');
    if (/\n/.test(s.title)) return out('The title is one line.');
    if (this.used() > 4000) return out('The three parts together are more than 4,000 characters.');
    const [ok, words] = amountCheck(s, this.props.reserves, this.props.capPct);
    if (!ok) return out(words);
    if (!s.lnurl.trim()) return out('Name the Lightning address to pay.');
    this.setState({ busy: true, say: 'Signing…', bad: false });
    const r = await this.props.onPublish({ title: s.title, content: s.content, improves: s.improves, amount: Math.floor(Number(s.amount)), lnurl: s.lnurl });
    this.setState({ busy: false, say: r.say, bad: !r.ok });
  }
  render() {
    const { reserves: r, reservesWhy, capPct, types, hash, markdown } = this.props;
    const s = this.state, max = r ? Math.floor(r.sats * capPct / 100) : null;
    const used = this.used(), [, amountWords, amountBad] = amountCheck(s, r, capPct);
    const field = (k) => ({ name: k, value: s[k], onChange: (e) => this.setState({ [k]: e.target.value, say: '' }) });
    return (
      <div>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        <h1>New proposal</h1>
        <div className="types" role="radiogroup" aria-label="Type"><span className="types-label">Type</span>
          {types.map(([h, label]) => <a key={h} className={`type${h === hash ? ' on' : ''}`} href={h} role="radio" aria-checked={h === hash ? 'true' : 'false'}>{label}</a>)}</div>
        <form className="compose" onSubmit={this.submit}>
          <p className="reserves-line">{r ? <>The protocol reserves hold <b>{n(r.sats)} sat</b> ({r.agreeing} of {r.asked} nodes agree). A proposal may ask at most <b>{capPct}%: {n(max)} sat</b>.</>
            : `The reserves could not be read${reservesWhy ? `: ${reservesWhy}` : ''}. A proposal may ask at most ${capPct}% of them.`}</p>
          <label>Title<input {...field('title')} maxLength={120} required placeholder="A short name for the PIP" /></label>
          <label>What the proposal does <span className="hint">Markdown: # headings, **bold**, lists, `code`, links and tables (| a | b |)</span><textarea {...field('content')} rows={10} required /></label>
          <div className="bar"><button type="button" className="btn" onClick={() => this.setState({ preview: !s.preview })}>{s.preview ? 'Hide preview' : 'Preview'}</button>
            <span className={`say${used > 4000 ? ' bad' : ''}`}>{n(used)} of 4,000 characters</span></div>
          {s.preview ? <div className="md preview"><h3>{s.title}</h3><div dangerouslySetInnerHTML={{ __html: markdown(s.content) }} /><h3 className="improves">How it improves Bitcoin Arena</h3><div dangerouslySetInnerHTML={{ __html: markdown(s.improves) }} /></div> : null}
          <label>How it improves Bitcoin Arena <span className="hint">its games, its protocol, its tools or its players</span><textarea {...field('improves')} rows={4} required /></label>
          <div className="row"><label>Amount (sat)<input {...field('amount')} type="number" min="1" step="1" required max={max || undefined} /></label>
            <label>Lightning address to pay<input {...field('lnurl')} placeholder="you@wallet.example" required /></label></div>
          <div className="bar"><button className="btn primary" type="submit" disabled={s.busy}>Sign and publish</button>
            <span className={`say${(s.say ? s.bad : amountBad) ? ' bad' : ''}`}>{s.say || amountWords}</span></div>
        </form>
      </div>);
  }
}

// CHANGE FEES (slice 3): the fees in force as the nodes answer them, one field per fee with its limit, the block it applies from, the
// reason; `check(typed, activation, purpose)` -> { changes, say, bad } is forum.js's own (the seats' rule through its client); publish
// signs and hands it to every node. Below, every fee proposal with its signal, vote, the developers' answers and its decision.
export class FeesProposal extends React.Component {
  constructor(props) { super(props); this.state = { typed: {}, activation: props.data ? String(props.data.earliest) : '', purpose: '', say: '', bad: false, busy: false }; this.submit = this.submit.bind(this); }
  componentDidUpdate(prev) { if (!prev.data && this.props.data && !this.state.activation) this.setState({ activation: String(this.props.data.earliest) }); }   // the fees arrived
  verdict() { return this.props.check(this.state.typed, Number(this.state.activation), this.state.purpose); }
  async submit(e) {
    e.preventDefault();
    if (!this.props.signedIn) return this.setState({ say: 'Open the Arena once first: the forum signs with your in-game key.', bad: true });
    const v = this.verdict();
    if (!v.changes) return this.setState({ say: v.say, bad: true });
    if (!this.state.purpose.trim()) return this.setState({ say: 'Say why: a proposal always gives its reason.', bad: true });
    this.setState({ busy: true, say: 'Signing…', bad: false });
    const r = await this.props.onPublish({ changes: v.changes, activation: Number(this.state.activation), purpose: this.state.purpose });
    this.setState({ busy: false, say: r.say, bad: !r.ok });
  }
  render() {
    const { data: d, error, types, hash, feeVal, markdown } = this.props;
    const head = (
      <>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        <h1>New proposal</h1>
        <div className="types" role="radiogroup" aria-label="Type"><span className="types-label">Type</span>
          {types.map(([h, label]) => <a key={h} className={`type${h === hash ? ' on' : ''}`} href={h} role="radio" aria-checked={h === hash ? 'true' : 'false'}>{label}</a>)}</div>
      </>);
    if (!d) return <div>{head}<div className="empty">{error || 'Reading the fees from the nodes…'}</div></div>;
    const s = this.state, v = Object.keys(s.typed).some((k) => s.typed[k] !== '') || s.purpose ? this.verdict() : { say: '', bad: false };
    const words = s.say || v.say, bad = s.say ? s.bad : v.bad;
    return (
      <div>
        {head}
        <form className="compose fees" onSubmit={this.submit}>
          <p className="reserves-line">Fees in force at block {d.tip} ({d.agreeing} of {d.asked} nodes agree). Fill in only the fees to change; leave the others empty. A round takes at most {d.sums.roundMaxBps / 100} %, an item's parts add up to {d.sums.itemPct} %, a market takes at most {d.sums.marketMaxBps / 100} %. A donation is never 0, and a change to one needs most of the protocol developers.</p>
          <div className="tbl"><table><thead><tr><th>Fee</th><th>In force</th><th>Limit</th><th>New value</th></tr></thead><tbody>
            {d.keys.map((k) => (
              <tr key={k}><td>{d.names[k] || k}{d.limits[k].donation ? <span className="hint"> donation</span> : null}</td><td>{feeVal(k, d.fees[k])}</td><td>{feeVal(k, d.limits[k].min)} – {feeVal(k, d.limits[k].max)}</td>
                <td><input name={k} type="number" step="1" min={d.limits[k].min} max={d.limits[k].max} placeholder={String(d.fees[k])} value={s.typed[k] || ''}
                  onChange={(e) => this.setState({ typed: { ...s.typed, [k]: e.target.value }, say: '' })} /> {d.units[k] === 'bps' ? 'bps' : '%'}</td></tr>))}
          </tbody></table></div>
          <div className="row"><label>Applies from block<input name="activation" type="number" step="1" min={d.earliest} value={s.activation} onChange={(e) => this.setState({ activation: e.target.value, say: '' })} /></label></div>
          <label>Why <span className="hint">required: what the change does and for whom</span><textarea name="purpose" rows={5} maxLength={4000} required value={s.purpose} onChange={(e) => this.setState({ purpose: e.target.value, say: '' })} /></label>
          <div className="bar"><button className="btn primary" type="submit" disabled={s.busy}>Sign and publish</button><span className={`say${bad ? ' bad' : ''}`}>{words}</span></div>
        </form>
        <h2>Fee proposals</h2>
        {!d.proposals.length ? <div className="empty">No fee proposals yet.</div> : d.proposals.map((p) => (
          <div key={p.id} className="fee-prop">
            <div className="bar"><b>{p.id.slice(0, 12)}…</b><span className="say">{p.decision ? (p.decision.accepted ? `accepted · in force from block ${p.activationHeight}` : `refused · ${p.decision.why}`) : p.vote ? `vote ${p.vote.state}` : `signal ${p.signal ? p.signal.state : '…'}`}</span></div>
            <ul>{p.changes.map((x) => <li key={x.fee}>{d.names[x.fee] || x.fee}: {feeVal(x.fee, x.from)} → {feeVal(x.fee, x.to)}</li>)}</ul>
            {p.needsDevs ? <p className="hint">Changes a donation: protocol developers {p.devs.filter((x) => x.approve).length} approve, {p.devs.filter((x) => !x.approve).length} deny.</p> : null}
            {p.purpose ? <div className="md" dangerouslySetInnerHTML={{ __html: markdown(p.purpose) }} /> : null}
          </div>))}
      </div>);
  }
}
