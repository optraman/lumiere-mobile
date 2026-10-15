"""Зерно плёнки для сцен «Настроения»: пишет src/components/film/grain.ts (PNG строкой base64).
Запуск: python tools/film-grain.py  (нужны numpy и Pillow)."""
import base64, io, os
import numpy as np
from PIL import Image

rng = np.random.default_rng(11)
N = 192
v = rng.normal(0, 1, (N, N))
# лёгкое сглаживание — зерно круглее, не «цифровой шум»
k = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]]) / 16.0
p = np.pad(v, 1, mode='wrap')
v = sum(k[i, j] * p[i:i + N, j:j + N] for i in range(3) for j in range(3))
v = v / v.std()
lv = np.clip(np.round(np.abs(v) * 2.2), 0, 7).astype(int)  # 8 уровней прозрачности
pal = [(c, c, c, a * 13) for c in (255, 0) for a in range(8)]  # максимум ~91/255
idx = np.where(v > 0, lv, 8 + lv).astype(np.uint8)
im = Image.fromarray(idx, 'P')
im.putpalette([ch for c in pal for ch in c[:3]])
buf = io.BytesIO()
im.save(buf, 'PNG', optimize=True, transparency=bytes(c[3] for c in pal))
b = base64.b64encode(buf.getvalue()).decode()
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'components', 'film', 'grain.ts')
head = open(out, encoding='utf-8').read().split('export const')[0] if os.path.exists(out) else ''
with open(out, 'w', encoding='utf-8') as f:
    f.write(head + "export const GRAIN = { uri: 'data:image/png;base64,%s', width: 192, height: 192, scale: 2 };\n" % b)
print('grain.ts', len(b))
