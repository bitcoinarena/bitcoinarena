// THE OWNER PAGE'S LIQUIDITY CARD (kanban #494, §23A.10): the free coins against the deposit minimum - below it, no share - the channels
// given, and the top-up address; a node that is no provider is told how to become one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const a = HTML.indexOf('const LIQUIDITY_DEPOSIT');
const body = HTML.slice(a, HTML.indexOf('\n}\n', HTML.indexOf('async function liquidityPanel() {', a)) + 2);
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
async function render(claim) {
  const el = { innerHTML: '' };
  const fetch = async () => ({ ok: !!claim, json: async () => claim });
  await new Function('$', 'at', 'fetch', 'esc', `${body}; return liquidityPanel;`)(() => el, (p) => `https://seat${p}`, fetch, esc)();
  return el.innerHTML;
}

test('a provider: free vs the deposit minimum, the channels it gave, the top-up address; below the minimum, no share said', async () => {
  const claim = { freeSats: '420000', depositAddress: 'tb1pdeposit', channels: [{ peer: '03' + 'aa'.repeat(32), capacitySats: '100000' }] };
  const low = await render(claim);
  assert.match(low, /Free for new channels<\/span><b>420,000 sat/); assert.match(low, /Deposit minimum<\/span><b>500,000 sat/);
  assert.match(low, /earns no share of the liquidity pool<\/b> until it is topped up by 80,000 sat/);
  assert.match(low, /Channels given to new nodes<\/span><b>1 \(100,000 sat\)/); assert.match(low, /tb1pdeposit/);
  assert.match(await render({ ...claim, freeSats: '600000' }), /Above the deposit minimum/);
  assert.match(await render(null), /no liquidity provider[\s\S]*Liquidity provider/);
  assert.ok(/liquidityPanel\(\);/.test(HTML) && HTML.includes('<div class="card" id="liquidity">'));
});
