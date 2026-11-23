# kanban #2873: no leading "@" in the social name fields - the placeholders lose it, and a typed or pasted "@" at the start is taken off at once.
# Works on the sources (owner.html, the stage index.patch) and on the built pages (whitespace-stripped owner page, the game page). Usage: files...
import sys, re, os
STRIP = "input.addEventListener('input', () => { const v = input.value.replace(/^\\s*@+/, ''); if (v !== input.value) input.value = v; });   // kanban #2873: no leading @"
STRIP_MIN = 'input.addEventListener("input",()=>{const v=input.value.replace(/^\\s*@+/,"");if(v!==input.value)input.value=v});'
for f in sys.argv[1:]:
    s = open(f, encoding='utf-8').read(); n0 = s
    for q in ("'", '"'):
        for w in ('X', 'Telegram'):
            s = s.replace(f"ph: {q}@yourname on {w}{q}", f"ph: {q}yourname on {w}{q}").replace(f"ph:{q}@yourname on {w}{q}", f"ph:{q}yourname on {w}{q}")
    if '#2873' not in s and 'input.value.replace(/^\\s*@+/' not in s:
        # readable form: the line that makes the input, then the strip on the next line with the same indent (a patch's '+' kept)
        def add(m):
            line = m.group(0); pre = re.match(r'^(\+?\s*)', line).group(1)
            return line + '\n' + pre + STRIP
        s, k = re.subn(r"^\+?[ \t]*const input = el\('input', \{[^\n]*placeholder: r\.ph[^\n]*\);[^\n]*$", add, s, flags=re.M)
        # stripped form
        s, k2 = re.subn(r'(const input=el\("input",\{[^}]*placeholder:r\.ph[^}]*\}\);)', lambda m: m.group(1) + STRIP_MIN, s)
        print(f, 'strip added', k, k2)
    open(f + '.new', 'w', encoding='utf-8').write(s); os.replace(f + '.new', f)
    print(f, 'changed' if s != n0 else 'UNCHANGED', 'left @yourname:', s.count('@yourname'))
