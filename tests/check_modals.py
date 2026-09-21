import os
import re

for f in os.listdir('templates'):
    if f.endswith('.html'):
        p = os.path.join('templates', f)
        c = open(p, encoding='utf-8').read()
        for m in re.findall(r'class="modal-overlay"[^>]*id="([^"]+)"', c):
            idx = c.find(f'id="{m}"')
            snip = c[idx:idx+600].lower()
            has_close = ('close' in snip) or ('cancel' in snip) or ('modal-close' in snip)
            print(f'{f}: {m} (has close: {has_close})')
