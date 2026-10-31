// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CREATE A MARKET (kanban #920, the owner 2026-10-31: "es wird immer die selbe ui verwendet ... Alles schaut sehr modern aus und ist einfach zu
// verstehen, keine wall of Text"): one step on screen, the card as players will see it beside it. A draft stays in this browser. Signing comes
// with the protocol field the market needs (docs/MARKET-CREATOR.md), so the last step says so and keeps the draft.
import React from 'react';
import { parse } from 'acorn';
import { checkMarketCode } from '../../../arena-protocol/src/market-check.js';
import { CodeEditor } from './CodeEditor.jsx';
import { readAll, runCode } from './marketRun.js';
import { SOURCES, SOURCE_GROUPS } from '../../../arena-protocol/src/market-sources.js';
import { CATEGORIES, EVERY, EXAMPLES, KEPT, OUTCOMES_MAX, READS_MAX, STEPS, TEMPLATES, fieldsOf, fromTemplate, manifestOfDraft, outcomeOf, outcomeOfCode, problemsOf, readAnswer, urlProblem } from './marketDraft.js';

const Err = ({ of }) => (of ? <span className="mc-err">{of}</span> : null);
const Field = ({ label, why, children }) => <label className="mc-f"><span>{label}</span>{children}<Err of={why} /></label>;
const Seg = ({ value, options, onPick }) => <div className="mc-seg" role="radiogroup">{options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? 'on' : undefined} onClick={() => onPick(v)}>{l}</button>)}</div>;
const scheduleLine = (s) => (s.mode === 'once' ? (s.resolveAt ? `Ends ${new Date(s.resolveAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'One round')
  : `Every ${(EVERY.find(([k]) => k === s.every) || [])[1]} · ${s.rounds} rounds`);

export class MarketCreator extends React.Component {
  constructor(props) {
    super(props);
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(KEPT) || 'null'); } catch { draft = null; }
    this.state = { step: draft ? 'question' : 'start', draft: draft || fromTemplate('blank'), sample: '', held: null, test: null, reading: false, shown: false, saved: false, srcGroup: SOURCE_GROUPS[0], demoOf: null };
  }
  // WHAT THE ANSWER GIVES UNDER THE DRAFT AS IT STANDS (the owner 2026-10-31: "Auch die Optionen können live getestet werden"): every change of a field,
  // rule, level or outcome is read against the answer already held, with no new read; a new address drops that answer
  tryOn(draft, text) {
    if (!text) return null;
    const got = readAnswer(draft.source, text);
    return got.why ? { why: got.why } : { value: got.value, ...outcomeOf(draft, got.value) };
  }
  // the check of the code, as it stands
  componentDidMount() { if (this.props.readListed) this.props.readListed().then((r) => this.setState({ donationSetId: r.donationSetId })).catch(() => {}); }
  /** Signed here with the owner's developer key: the key never leaves this page. */
  sign() {
    try { this.setState({ signed: this.props.signManifest(JSON.stringify(manifestOfDraft(this.state.draft, { donationSetId: this.state.donationSetId }))), signWhy: '' }); }
    catch (e) { this.setState({ signed: null, signWhy: e.message }); }
  }
  async publish() {
    try { await this.props.publishMarket({ manifest: this.state.signed.hex }); this.setState({ published: true, signWhy: '' }); }
    catch (e) { this.setState({ signWhy: e.message }); }
  }
  checked(d = this.state.draft) { return d.source.kind === 'code' && d.source.code.trim() ? checkMarketCode(d.source.code, parse) : null; }
  set(more, sample = this.state.sample) {
    const draft = { ...this.state.draft, ...more };
    this.setState({ draft, saved: false, sample, test: draft.source.kind === 'code' ? this.state.test : this.tryOn(draft, sample) });
    if (draft.source.kind === 'code' && this.state.held) { clearTimeout(this.again); this.again = setTimeout(() => this.tryCode(), 350); }
    try { localStorage.setItem(KEPT, JSON.stringify(draft)); } catch { /* this draft lasts until the page goes */ }
  }
  source(more) { this.set({ source: { ...this.state.draft.source, ...more } }, 'url' in more ? '' : this.state.sample); }
  // CODE LIVE: what was read stays held, so each edit is run on it at once; only "Test it live" reads again
  async tryCode() {
    const { draft: d, held } = this.state; const check = this.checked(d);
    if (!check || !check.ok || !held) { if (check && !check.ok) this.setState({ test: { why: 'Fix what the check names' } }); return; }
    const got = await runCode({ code: d.source.code, reads: held, market: { outcomes: d.outcomes, low: Number(d.low), high: Number(d.high) } });
    if (!got.ok) { this.setState({ test: { why: got.why } }); return; }
    const o = outcomeOfCode(d, got.out);
    this.setState({ test: { value: JSON.stringify(got.out), ...o } });
  }
  async readCode() {
    const { draft: d } = this.state;
    this.setState({ reading: true, test: null });
    // read by the node when there is one: that is what a round will do, and no site can refuse it as sites refuse a browser
    const got = this.props.tryOnNode ? await this.props.tryOnNode({ reads: d.source.reads }).catch((e) => ({ why: e.message })) : await readAll(d.source.reads);
    if (got.why) { this.setState({ reading: false, held: null, test: { why: `Could not read ${got.why}` } }); return; }
    this.setState({ reading: false, held: got.reads }, () => this.tryCode());
  }
  example(e) { this.setState({ held: null, test: null }); this.set({ source: { ...this.state.draft.source, kind: 'code', code: e.code, reads: e.reads.map((r) => ({ ...r })) } }); }
  // tapped, it shows at once: read live, or a site's recorded answer where a browser may not read it
  sampleUrl(s) { this.setState({ test: null, demoOf: null }); this.set({ source: { ...this.state.draft.source, url: s.url, read: s.read, path: s.path, ...(s.rule ? { rule: s.rule } : {}) } }, ''); setTimeout(() => this.read(s), 0); }
  read1(i, more) { this.source({ reads: this.state.draft.source.reads.map((r, j) => (j === i ? { ...r, ...more } : r)) }); this.setState({ held: null }); }
  schedule(more) { this.set({ schedule: { ...this.state.draft.schedule, ...more } }); }
  go(step) { this.setState({ step, shown: false }); }
  next() {
    const { step, draft } = this.state; const at = STEPS.findIndex(([k]) => k === step);
    if (Object.keys(problemsOf(draft, step, this.checked(draft))).length) { this.setState({ shown: true }); return; }
    this.go(STEPS[at + 1][0]);
  }
  pick(id) { this.setState({ draft: fromTemplate(id), step: 'question', shown: false, test: null, sample: '' }); }
  run(text) { this.setState({ test: this.tryOn(this.state.draft, text) }); }
  // THE LIVE TEST, AT THE FIELD (the owner 2026-10-31: "Test Funktion um es live zu testen, ob es z.B. amount gibt"): the source read now, the field found
  // or not, and the fields the answer does hold to pick from. The browser reads it here; a site that forbids that needs the pasted answer
  async read(known = null) {
    if (this.state.draft.source.kind === 'code') { await this.readCode(); return; }
    const bad = urlProblem(this.state.draft.source.url);
    if (bad) { this.setState({ test: { why: bad } }); return; }
    this.setState({ reading: true, test: null });
    try {
      if (this.props.tryOnNode) {
        const got = await this.props.tryOnNode({ reads: [{ id: 'page', kind: 'http', url: this.state.draft.source.url }] });
        if (!got.ok) throw new Error(got.why);
        const text = typeof got.reads.page === 'string' ? got.reads.page : JSON.stringify(got.reads.page);
        this.setState({ sample: text.slice(0, 1000000), reading: false }); this.run(text); return;
      }
      const r = await fetch(this.state.draft.source.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`answered ${r.status}`);
      this.setState({ sample: text.slice(0, 1000000), reading: false }); this.run(text);
    } catch (e) {
      if (known && known.demo) { this.setState({ sample: known.demo, reading: false, demoOf: known.name }); this.run(known.demo); return; }
      this.setState({ reading: false, test: { why: `This browser could not read it (${e.message}). Paste the answer in the Test step.` } });
    }
  }
  tested() {
    const { test, sample, draft: d, demoOf } = this.state;
    if (!test) return null;
    const fields = d.source.kind === 'url' && d.source.read === 'json' ? fieldsOf(sample) : [];
    return (<>
      {test.why ? <div className="mc-result bad">{test.why}</div>
        : <div className="mc-result ok"><span>Value <b>{test.value === '' ? 'nothing' : test.value}</b></span><span>Outcome <b>{test.outcome}</b></span>{test.note ? <small>{test.note}</small> : null}{demoOf ? <small>A recorded answer from {demoOf}: this site lets nodes read it, not a browser.</small> : null}</div>}
      {fields.length ? <div className="mc-fields" aria-label="Fields in the answer">{fields.map(([path, value]) => <button key={path} type="button" className={path === d.source.path ? 'on' : undefined} title={value}
        onClick={() => this.source({ path })}><code>{path}</code><small>{value}</small></button>)}</div> : null}
    </>);
  }
  card() {
    const { draft: d, test } = this.state; const won = test && !test.why ? test.outcome : null;
    return (
      <div className="mc-card" aria-label="Preview">
        <small>{d.category || 'Category'}</small>
        <b>{d.title || 'Your question'}</b>
        {d.kind === 'number' ? <div className="mc-range"><span>{d.low || '–'}</span><i /><span>{d.high || '–'}</span>{won !== null ? <b>{won}</b> : null}</div>
          : <div className="mc-odds">{d.outcomes.map((o, i) => <span key={i} className={won !== null && o === won ? 'on' : undefined}>{o || '…'}</span>)}</div>}
        <small>{scheduleLine(d.schedule)}</small>
      </div>);
  }
  stepView() {
    const { step, draft: d, shown, test, sample, reading, srcGroup, signed, signWhy, published } = this.state;
    const check = this.checked(d);
    const bad = shown ? problemsOf(d, step, check) : {};
    if (step === 'start') return (
      <div className="mc-tiles">{TEMPLATES.map((t) => <button key={t.id} type="button" className="mc-tile" onClick={() => this.pick(t.id)}><i aria-hidden="true">{t.icon}</i><b>{t.name}</b><small>{t.hint}</small></button>)}</div>);
    if (step === 'question') return (<>
      <Field label="Question" why={bad.title}><input maxLength={120} value={d.title} onChange={(e) => this.set({ title: e.target.value })} /></Field>
      <div className="mc-f"><span>Category</span><div className="mc-chips" role="radiogroup" aria-label="Category">{CATEGORIES.map((c) => <button key={c} type="button" role="radio" aria-checked={c === d.category} className={c === d.category ? 'on' : undefined} onClick={() => this.set({ category: c })}>{c}</button>)}</div><Err of={bad.category} /></div>
      <Seg value={d.kind} options={[['choice', 'Outcomes'], ['number', 'A number']]} onPick={(kind) => this.set({ kind, outcomes: kind === 'choice' && !d.outcomes.length ? ['Yes', 'No'] : d.outcomes })} />
      {d.kind === 'number' ? <div className="mc-two"><Field label="Low"><input inputMode="decimal" value={d.low} onChange={(e) => this.set({ low: e.target.value })} /></Field>
        <Field label="High" why={bad.bounds}><input inputMode="decimal" value={d.high} onChange={(e) => this.set({ high: e.target.value })} /></Field></div>
        : <div className="mc-list">{d.outcomes.map((o, i) => <div key={i} className="mc-row"><input aria-label={`Outcome ${i + 1}`} maxLength={40} value={o} onChange={(e) => this.set({ outcomes: d.outcomes.map((x, j) => (j === i ? e.target.value : x)) })} />
          {d.outcomes.length > 2 ? <button type="button" aria-label={`Remove outcome ${i + 1}`} onClick={() => this.set({ outcomes: d.outcomes.filter((x, j) => j !== i) })}>×</button> : null}</div>)}
          {d.outcomes.length < OUTCOMES_MAX ? <button type="button" className="mc-add" onClick={() => this.set({ outcomes: [...d.outcomes, ''] })}>Add outcome</button> : null}<Err of={bad.outcomes} /></div>}
    </>);
    if (step === 'result') {
      const s = d.source, chosen = SOURCES.find((m) => m.url === s.url);
      const kinds = <Seg value={s.kind} options={[['url', 'A URL'], ['code', 'Code']]} onPick={(kind) => { this.setState({ test: null, held: null }); this.source({ kind }); }} />;
      if (s.kind === 'code') return (<>
        {kinds}
        <div className="mc-chips" aria-label="Examples">{EXAMPLES.map((e) => <button key={e.id} type="button" onClick={() => this.example(e)}>{e.name}</button>)}</div>
        {s.reads.some((r) => r.kind === 'ws') ? <div className="mc-check">Nodes see different trades on a socket. Five of seven must reach the same outcome, so a close call refunds the round.</div> : null}
        <div className="mc-list" aria-label="Reads">{s.reads.map((r, i) => <div key={i} className="mc-read">
          <input aria-label="Name" className="mono" value={r.id} onChange={(e) => this.read1(i, { id: e.target.value })} />
          <Seg value={r.kind} options={[['http', 'Page'], ['ws', 'Socket']]} onPick={(kind) => this.read1(i, { kind })} />
          <input aria-label="Address" inputMode="url" placeholder={r.kind === 'ws' ? 'wss://' : 'https://'} value={r.url} onChange={(e) => this.read1(i, { url: e.target.value })} />
          {r.kind === 'ws' ? <input aria-label="Message to send" className="mono" placeholder="Message to send after connecting" value={r.subscribe} onChange={(e) => this.read1(i, { subscribe: e.target.value })} /> : null}
          <button type="button" aria-label={`Remove ${r.id}`} onClick={() => this.source({ reads: s.reads.filter((x, j) => j !== i) })}>×</button></div>)}
          {s.reads.length < READS_MAX ? <button type="button" className="mc-add" onClick={() => this.source({ reads: [...s.reads, { id: `read${s.reads.length + 1}`, kind: 'http', url: '', subscribe: '' }] })}>Add a read</button> : null}<Err of={bad.reads} /></div>
        <CodeEditor value={s.code} onChange={(code) => this.source({ code })} marked={check ? check.problems.map((p) => p.line) : []} />
        {check ? (check.ok ? <div className="mc-check ok">Readable code · check {check.version}</div> : <ul className="mc-check bad">{check.problems.map((p, i) => <li key={i}><b>Line {p.line}</b> {p.why}</li>)}</ul>) : null}
        <Err of={bad.code} />
        <button type="button" className="mc-test" disabled={reading} onClick={() => this.read()}>{reading ? 'Reading…' : 'Test it live'}</button>
        {this.tested()}
      </>);
      return (<>
        {kinds}
        <Seg value={srcGroup} options={SOURCE_GROUPS.map((g) => [g, g])} onPick={(g) => this.setState({ srcGroup: g })} />
        <div className="mc-sources" aria-label="Listed sources">{SOURCES.filter((m) => m.group === srcGroup && !m.socket).map((m) => <div key={m.name} className={m.url === s.url ? 'mc-src on' : 'mc-src'}>
          <button type="button" onClick={() => this.sampleUrl(m)}><b>{m.name}</b><small>{m.hint}</small></button>
          <a href={m.docs} target="_blank" rel="noopener noreferrer" aria-label={`${m.name} documentation`}>Docs ↗</a></div>)}</div>
        <Field label="Address the nodes read" why={bad.url}><input inputMode="url" placeholder="https://" value={s.url} onChange={(e) => this.source({ url: e.target.value })} /></Field>
        {chosen ? <a className="mc-docs" href={chosen.docs} target="_blank" rel="noopener noreferrer">Other values from {chosen.name} ↗</a> : null}
        <Seg value={s.read} options={[['json', 'JSON field'], ['regex', 'Pattern'], ['text', 'Whole answer']]} onPick={(read) => this.source({ read })} />
        {s.read === 'text' ? null : <Field label={s.read === 'json' ? 'Field' : 'Pattern'} why={bad.path}><input className="mono" placeholder={s.read === 'json' ? 'data.amount' : 'Price: ([0-9.]+)'} value={s.path} onChange={(e) => this.source({ path: e.target.value })} /></Field>}
        <button type="button" className="mc-test" disabled={reading} onClick={() => this.read()}>{reading ? 'Reading…' : 'Test it live'}</button>
        {this.tested()}
        {d.kind === 'number' ? null : <>
          <Seg value={s.rule} options={[['above', 'At or above'], ['below', 'Below'], ['rises', 'Rises'], ['equals', 'Names outcome'], ['found', 'Is found']]} onPick={(rule) => this.source({ rule })} />
          {s.rule === 'above' || s.rule === 'below' ? <Field label="Level" why={bad.value}><input inputMode="decimal" value={s.value} onChange={(e) => this.source({ value: e.target.value })} /></Field> : null}</>}
      </>);
    }
    if (step === 'test') return (<>
      <button type="button" className="primary" disabled={reading} onClick={() => this.read()}>{reading ? 'Reading…' : 'Read it now'}</button>
      {d.source.kind === 'code' ? null : <Field label="Or paste an answer"><textarea className="mono" rows={5} spellCheck={false} value={sample} onChange={(e) => { this.setState({ sample: e.target.value }); this.run(e.target.value); }} /></Field>}
      {this.tested()}
    </>);
    if (step === 'schedule') {
      const s = d.schedule;
      return (<>
        <Seg value={s.mode} options={[['once', 'One time'], ['repeat', 'Repeats']]} onPick={(mode) => this.schedule({ mode })} />
        {s.mode === 'once' ? <div className="mc-two"><Field label="Result at" why={bad.resolveAt}><input type="datetime-local" value={s.resolveAt} onChange={(e) => this.schedule({ resolveAt: e.target.value })} /></Field>
          <Field label="Entries close, minutes before" why={bad.closeBeforeMin}><input inputMode="numeric" value={s.closeBeforeMin} onChange={(e) => this.schedule({ closeBeforeMin: e.target.value })} /></Field></div>
          : <><Seg value={s.every} options={EVERY.map(([k, l]) => [k, l])} onPick={(every) => this.schedule({ every })} />
            <Field label="Rounds" why={bad.rounds}><input inputMode="numeric" value={s.rounds} onChange={(e) => this.schedule({ rounds: e.target.value })} /></Field></>}
        <Field label="Smallest stake, sat" why={bad.minStakeSat}><input inputMode="numeric" value={s.minStakeSat} onChange={(e) => this.schedule({ minStakeSat: e.target.value })} /></Field>
      </>);
    }
    const rows = [['Question', d.title], ['Category', d.category], ['Source', d.source.kind === 'code' ? `Code, ${d.source.reads.length} read${d.source.reads.length === 1 ? '' : 's'}` : d.source.url], ['When', scheduleLine(d.schedule)]];
    return (<>
      <dl className="mc-sum">{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
      <button type="button" className="primary" disabled={!this.props.signManifest || !!signed} onClick={() => this.sign()}>Sign</button>
      {signed ? <div className="mc-check ok">Signed. Market id <span className="mono">{signed.gameId.slice(0, 16)}</span></div> : null}
      {signWhy ? <div className="mc-check bad">{signWhy}</div> : null}
      {signed && this.props.publishMarket ? <button type="button" className="primary" disabled={!!published} onClick={() => this.publish()}>Publish</button> : null}
      {published ? <div className="mc-check ok">Published. Other nodes check it and host it within 5 minutes.</div> : null}
      {this.props.signManifest ? null : <p className="mc-note">Signing needs your 24 words or your nsec on this page.</p>}
    </>);
  }
  render() {
    const { step, draft } = this.state; const at = STEPS.findIndex(([k]) => k === step);
    return (
      <div className="mc">
        <ol className="mc-steps">{STEPS.map(([k, l], i) => <li key={k} className={i === at ? 'on' : i < at ? 'done' : undefined}>
          {i < at ? <button type="button" onClick={() => this.go(k)}>{l}</button> : <span aria-current={i === at ? 'step' : undefined}>{l}</span>}</li>)}</ol>
        <div className="mc-body">
          <div className="mc-pane">
            {this.stepView()}
            {step === 'start' ? null : <div className="mc-nav">
              <button type="button" onClick={() => this.go(STEPS[at - 1][0])}>Back</button>
              {step === 'sign' ? null : <button type="button" className="primary" onClick={() => this.next()}>Next</button>}</div>}
          </div>
          {step === 'start' ? null : this.card()}
        </div>
        {draft && step !== 'start' ? <button type="button" className="mc-link" onClick={() => { try { localStorage.removeItem(KEPT); } catch { /* nothing kept */ } this.setState({ draft: fromTemplate('blank'), step: 'start', test: null, sample: '' }); }}>Start over</button> : null}
      </div>);
  }
}
