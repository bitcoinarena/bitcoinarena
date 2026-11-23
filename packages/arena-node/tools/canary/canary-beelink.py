#!/usr/bin/env python3
# kanban #2905: the test host side of the live canary, called by the test laptop over ssh (LAN). Nothing here is exposed; signal-cli and the board
# stay on 127.0.0.1. No secret is printed.
#   canary-beelink.py quiet          -> one JSON line {quiet, why}: a seat roll is running (a user unit roll-* active, or a roll log written in
#                                       the last ROLL_QUIET_MIN minutes, default 60 - the second host part runs on after the test host unit ends)
#   canary-beelink.py signal  < text -> Signal to the owner (signal-cli JSON-RPC on 127.0.0.1:8080, signal-user)
#   canary-beelink.py card ID < text -> a comment on kanban card ID (key from ~/.config/blwp/kanban-key)
import glob, json, os, subprocess, sys, time, urllib.request

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


def post(url, body, headers):
    r = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={'Content-Type': 'application/json', **headers})
    return urllib.request.urlopen(r, timeout=30).status


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'quiet': return quiet()
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
        print('#2905 usage: quiet | signal | card ID'); sys.exit(2)


main()
