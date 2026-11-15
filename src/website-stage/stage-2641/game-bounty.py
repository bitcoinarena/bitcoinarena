# kanban #2784 (the owner 2026-11-15, Season 2 public): the stage's Season 2 Feedback form on the game page testnet.bitcoinarena.io - the social panel,
# rule links, budget bar, notice and pot banner, reading the faucet through the production Worker (https://bitcoinarena.io/api/faucet/feedback,
# CORS for the game page) and linking the rules to https://bitcoinarena.io/bounty/. The stage keeps its own origin. Run after apply.sh's scripts.
# Usage: game-bounty.py <index.html>
import sys
p = sys.argv[1]; s = open(p).read()
HOSTS = "/^(testnet|testnet-stage)\\.bitcoinarena\\.io$|(^|\\.)bitcoin-arena-site\\.pages\\.dev$/.test(location.hostname)"
API = "(location.hostname === 'testnet-stage.bitcoinarena.io' ? location.origin : 'https://bitcoinarena.io') + '/api/faucet/feedback"
def R(a, b, n=1):
    global s
    assert s.count(a) == n, (a[:70], s.count(a)); s = s.replace(a, b)
R("const SOCIAL_ON = () => location.hostname === 'testnet-stage.bitcoinarena.io' && hasIdentity();", "const SOCIAL_ON = () => " + HOSTS + " && hasIdentity();")
R("const RULES_ON = () => location.hostname === 'testnet-stage.bitcoinarena.io';", "const RULES_ON = () => " + HOSTS + ";")
R("const ruleLink = (anchor, text, cls) => el('a', { href: '/bounty/' + (anchor ? '#' + anchor : '')",
  "const ruleLink = (anchor, text, cls) => el('a', { href: (location.hostname === 'testnet-stage.bitcoinarena.io' ? '/bounty/' : 'https://bitcoinarena.io/bounty/') + (anchor ? '#' + anchor : '')")
R("if (location.hostname === 'testnet-stage.bitcoinarena.io') {\n            fetch(location.origin + '/api/faucet/feedback/season')",
  "if (" + HOSTS + ") {\n            fetch(" + API + "/season')")
R("const S2 = location.origin + '/api/faucet/feedback';", "const S2 = " + API + "';", 2)
open(p, 'w').write(s); print('game-bounty ok')
