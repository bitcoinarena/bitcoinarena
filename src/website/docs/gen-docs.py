import json, html, os, re
from datetime import date
HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'endpoints.json')))
esc = lambda s: html.escape(str(s))

# THE GROUPS: the audience of each door in endpoints.json, as OpenAPI tags
TAGS = [
    ('game/market developer', 'Builders', 'List your game, read its rounds, follow results and, for a market, report the outcome.'),
    ('player/page', 'Players', 'What the game page uses: the lobby, joining, stake locks, winnings, leaderboards and results.'),
    ('operator/monitoring', 'Operators', 'The dashboard, the owner area, operator tokens, the census and the node\'s health.'),
    ('node-to-node', 'Nodes', 'Signing ceremonies, shares and gossip between the nodes of a committee. You do not call these yourself; they are listed so nothing is hidden.'),
]
TAG_OF = {a: t for a, t, _ in TAGS}
count = {a: sum(1 for e in E if e['audience'] == a) for a, _, _ in TAGS}

# SERVERS: the 14 public testnet4 seats (CORS *, measured 200 on /games)
SERVERS = [{'url': f'https://tn4.bitcoin-arena.io/guardian-{i}', 'description': f'testnet4 federation A, seat {i}'} for i in range(1, 8)] + \
          [{'url': f'https://tn4.bitcoin-arena.io/fed2-{i}', 'description': f'testnet4 federation B, seat {i}'} for i in range(1, 8)]

NEEDS = {'signature': 'Needs a signature: the body or record must be signed by the key named below.',
         'token': 'Needs an operator token: Authorization: Bearer <token>, minted in the owner area.',
         'owner': 'Needs the node owner: a request signed by the claimed owner key (BIP-340 JSON or a NIP-98 kind 27235 event).'}

def openapi():
    paths = {}
    for e in E:
        if e.get('skipOpenapi'): continue
        p = e.get('openapiPath') or e['path']
        m = e['method'].lower()
        if m in ('any', '*'): m = 'get'
        if m not in ('get', 'post', 'put', 'delete', 'patch', 'head'): continue
        if m in paths.get(p, {}): continue
        need = e.get('needsAuth') or 'none'
        desc = [e['purpose']]
        if need in NEEDS: desc.append('**' + NEEDS[need] + '**')
        if e.get('changesState'): desc.append('**Changes state on the node:** this page does not send it.')
        desc.append('Access: ' + e['auth'])
        desc.append('Returns: ' + e['returns'])
        if e.get('headers'): desc.append('Headers: ' + ', '.join('`%s`' % h for h in e['headers']))
        desc.append('Source: `packages/arena-node/src/server.js` line %s.' % e.get('line', '?'))
        op = {'tags': [TAG_OF[e['audience']]], 'summary': (('[signed] ' if need in NEEDS else '') + (e.get('summary') or e['purpose'][:60])),
              'description': '\n\n'.join(desc), 'operationId': re.sub(r'[^A-Za-z0-9]+', '_', m + p).strip('_')}
        params = []
        for q in e.get('pathParams') or []:
            params.append({'name': q['name'], 'in': 'path', 'required': True, 'description': q.get('description', ''), 'schema': {'type': 'string'}})
        for q in e.get('query') or []:
            d = {'name': q['name'], 'in': 'query', 'required': bool(q.get('required')), 'description': q.get('description', ''),
                 'schema': {'type': q.get('type') if q.get('type') in ('string', 'integer', 'boolean', 'number') else 'string'}}
            if 'example' in q and q['example'] not in (None, ''): d['example'] = q['example']
            params.append(d)
        if params: op['parameters'] = params
        b = e.get('body')
        if b and m != 'get':
            op['requestBody'] = {'required': bool(b.get('required', True)), 'description': b.get('description', ''),
                                 'content': {b.get('contentType') or 'application/octet-stream': {'schema': {'type': 'string', 'format': 'binary'} if 'octet' in (b.get('contentType') or 'octet') else {}}}}
        resp = {}
        for r in e.get('responses') or [{'status': '200', 'description': e['returns']}]:
            st = str(r.get('status', '200'))
            if st in resp: continue
            x = {'description': r.get('description') or ''}
            ct = r.get('contentType')
            if ct: x['content'] = {ct: {'schema': {'type': 'string', 'format': 'binary'}} if 'octet' in ct else {}}
            resp[st] = x
        op['responses'] = resp
        if need == 'token': op['security'] = [{'operatorToken': []}]
        if e.get('changesState'): op['x-changes-state'] = True
        paths.setdefault(p, {})[m] = op
    return {
        'openapi': '3.0.3',
        'info': {'title': 'Bitcoin Arena node API', 'version': date.today().isoformat(),
                 'description': 'Every request a Bitcoin Arena node (`arena-node`) answers, generated from `packages/arena-node/src/server.js` '
                                'by `src/website/docs/gen-docs.py`. Concepts and guides: https://docs.bitcoin-arena.io/'},
        'servers': SERVERS,
        'tags': [{'name': t, 'description': d} for _, t, d in TAGS],
        'components': {'securitySchemes': {'operatorToken': {'type': 'http', 'scheme': 'bearer', 'description': 'An operator token minted in the owner area (POST /owner/operator/mint).'}}},
        'paths': dict(sorted(paths.items())),
    }

spec = openapi()
nops_total = sum(len(v) for v in spec['paths'].values())
# the counts the pages show are the operations in the document, per group
count = {a: sum(1 for v in spec['paths'].values() for o in v.values() if o['tags'] == [t]) for a, t, _ in TAGS}
os.makedirs(os.path.join(HERE, 'www', 'api'), exist_ok=True)
json.dump(spec, open(os.path.join(HERE, 'www', 'api', 'openapi.json'), 'w'), indent=1)
api = open(os.path.join(HERE, 'api-template.html')).read()
def counts(s):
    return s.replace('{{NDEV}}', str(count['game/market developer'])).replace('{{NPLAYER}}', str(count['player/page'])) \
            .replace('{{NOPS}}', str(count['operator/monitoring'])).replace('{{NN2N}}', str(count['node-to-node'])).replace('{{NALL}}', str(nops_total))
open(os.path.join(HERE, 'www', 'api', 'index.html'), 'w').write(counts(api))

# THE REPOSITORIES (kanban #753): every repository on GitHub on a page of its own, as the API reference; the footers' GitHub icon leads here
GH = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>'
os.makedirs(os.path.join(HERE, 'www', 'repos'), exist_ok=True)
open(os.path.join(HERE, 'www', 'repos', 'index.html'), 'w').write(open(os.path.join(HERE, 'repos-template.html')).read().replace('{{GH}}', GH))

page = counts(open(os.path.join(HERE, 'docs-template.html')).read())

# SECTIONS AS ACCORDIONS: every h2 section of the main column becomes a <details class="sec">, open in the file
# (a reader without JavaScript sees everything) and folded by the page's script, which opens the one a link points at
m0 = page.index('<main id="top">'); m1 = page.index('</main>')
main = page[m0:m1]
tail = ''
k = main.find('\n  <div class="folds bottom">')
if k > 0: main, tail = main[:k], main[k:]
parts = re.split(r'(?=\n  <h2 id=")', main)
out = [parts[0] + '\n  <div class="folds"><button type="button" id="fold-open">Open all</button><button type="button" id="fold-close">Close all</button></div>']
for p in parts[1:]:
    h = re.match(r'\n  (<h2 id="[^"]+">.*?</h2>)', p, re.S)
    out.append('\n  <details class="sec" open><summary>' + h.group(1) + '</summary><div class="sec-body">' + p[h.end():] + '\n  </div></details>')
page = page[:m0] + ''.join(out) + tail + page[m1:]
open(os.path.join(HERE, 'www', 'index.html'), 'w').write(page)
# the homepage serves the same page at /docs, so both stay one
open(os.path.join(HERE, '..', 'www', 'docs', 'index.html'), 'w').write(page)
print('written docs', len(page), 'api', nops_total, 'operations', count)
