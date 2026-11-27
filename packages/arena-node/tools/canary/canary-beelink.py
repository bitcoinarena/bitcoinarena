#!/usr/bin/env python3
# kanban #2905: the test host side of the live canary, called by the test laptop over ssh (LAN). Nothing here is exposed; signal-cli and the board
# stay on 127.0.0.1. No secret is printed.
#   canary-beelink.py quiet          -> one JSON line {quiet, why}: a seat roll is running (a user unit roll-* active, or a roll log written in
#                                       the last ROLL_QUIET_MIN minutes, default 60 - the second host part runs on after the test host unit ends)
#   canary-beelink.py signal  < text -> Signal to the owner (signal-cli JSON-RPC on 127.0.0.1:8080, signal-user)
#   canary-beelink.py card ID < text -> a comment on kanban card ID (key from ~/.config/blwp/kanban-key)
#   canary-beelink.py bot ROUND8     -> one JSON line {ok, seen, entered, broke, why, balanceSat, low}: what the RPS opponent bot logged for that
#                                       round, and its balance file (kanban #3893: a void round because the bot was broke says so)
import glob, json, os, re, subprocess, sys, time, urllib.request

ROLL_DIRS = [d for d in os.environ.get('ROLL_DIRS', '').split(':') if d]   # the roll logs' directories (kanban #3388: set by the host)
QUIET_MIN = float(os.environ.get('ROLL_QUIET_MIN', '60'))
OWNER = os.environ.get('CANARY_SIGNAL_TO') or open(os.path.expanduser('~/.config/blwp/canary-signal-to')).read().strip()


def quiet():
    why = []
    try:
        out = subprocess.run(['systemctl', '--user', 'list-units', '--no-legend', '--plain', '--state=active,activating', 'roll-*'],
                             capture_output=True, text=True, timeout=20).stdout
        units = [l.split()[0] for l in out.splitlines() if l.strip()]
        if units: why.append('unit ' + ','.join(units))
    except Exception as e:
        why.append('unit check failed: %s' % str(e)[:80])
    now = time.time()
    for d in ROLL_DIRS:
        for f in glob.glob(os.path.join(d, 'roll-*.log')):
            age = (now - os.path.getmtime(f)) / 60
            if age < QUIET_MIN:
                tail = ''
                try:
                    with open(f, 'rb') as h:
                        h.seek(max(0, os.path.getsize(f) - 400)); tail = h.read().decode('utf8', 'replace').strip().splitlines()[-1][:120]
                except Exception: pass
                why.append('%s written %.0f min ago (%s)' % (os.path.basename(f), age, tail))
    print(json.dumps({'quiet': bool(why), 'why': why}))


BOT_HOST = os.environ.get('CANARY_BOT_HOST', '')   # the bot's host (ssh), set by the host
BOT_LOG = os.environ.get('CANARY_BOT_LOG', 'm808/bot926/opp/run.log')
BOT_BALANCE = os.environ.get('CANARY_BOT_BALANCE', 'm808/bot926/opp/bot/balance.json')


def bot(r8):
    if not BOT_HOST:
        print(json.dumps({'ok': False, 'why': 'CANARY_BOT_HOST not set'})); return
    if not re.fullmatch('[0-9a-f]{8}', r8 or ''):
        print(json.dumps({'ok': False, 'why': 'round: 8 hex'})); return
    cmd = "grep -F '\"round\":\"%s\"' %s | tail -20; echo ---; cat %s 2>/dev/null" % (r8, BOT_LOG, BOT_BALANCE)
    try:
        out = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', BOT_HOST, cmd], capture_output=True, text=True, timeout=40).stdout
    except Exception as e:
        print(json.dumps({'ok': False, 'why': 'ssh: %s' % str(e)[:80]})); return
    lines, _, bal = out.partition('---\n')
    steps = []
    for l in lines.splitlines():
        try: steps.append(json.loads(l))
        except ValueError: pass
    fails = [s.get('why', '') for s in steps if s.get('step') == 'entry failed']
    r = {'ok': True, 'seen': len(steps), 'entered': any(s.get('step') == 'entered' for s in steps),
         'broke': any('Insufficient' in w for w in fails), 'why': (fails[-1] if fails else '')[:120], 'balanceSat': None, 'low': None}
    try:
        b = json.loads(bal)
        sats = [int(m) // 1000 for m in (b.get('balanceMsat') or {}).values()]
        r['balanceSat'] = min(sats) if sats else None
        r['low'] = bool(sats) and min(sats) < int(b.get('belowSat') or 0)
    except (ValueError, TypeError): pass
    print(json.dumps(r))


def post(url, body, headers):
    r = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={'Content-Type': 'application/json', **headers})
    return urllib.request.urlopen(r, timeout=30).status


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'quiet': return quiet()
    if cmd == 'bot': return bot(sys.argv[2] if len(sys.argv) > 2 else '')
    text = sys.stdin.read().strip()[:1500]
    if not text: print('#2905 empty message'); sys.exit(2)
    if cmd == 'signal':
        st = post('http://127.0.0.1:8080/api/v1/rpc', {'jsonrpc': '2.0', 'id': 1, 'method': 'send', 'params': {'recipient': [OWNER], 'message': text}}, {})
        print('#2905 signal sent (%s)' % st)
    elif cmd == 'card':
        card = int(sys.argv[2])
        key = open(os.path.expanduser('~/.config/blwp/kanban-key')).read().strip()
        st = post('http://127.0.0.1:18850/api/tasks/%d/comments' % card, {'body': text}, {'Authorization': 'Bearer ' + key})
        print('#2905 card %d comment (%s)' % (card, st))
    else:
        print('#2905 usage: quiet | bot ROUND8 | signal | card ID'); sys.exit(2)


main()
