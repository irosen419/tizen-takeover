"""review.py OUT.jpg SPRITE_DIR [scale] [per_row] [bg]: every sprite at one scale, feet on a line, named."""
import os, sys
from PIL import Image, ImageDraw
out, d = sys.argv[1], sys.argv[2]
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
per = int(sys.argv[4]) if len(sys.argv) > 4 else 10
bg = sys.argv[5] if len(sys.argv) > 5 else 'dark'
files = sorted(f for f in os.listdir(d) if f.endswith('.webp'))
ims = []
for f in files:
    im = Image.open(os.path.join(d, f)).convert('RGBA')
    ims.append((f[:-5], im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)))
rows = [ims[i:i + per] for i in range(0, len(ims), per)]
gap = 18
W = max(sum(im.width + gap for _, im in r) for r in rows) + gap
hs = [max(im.height for _, im in r) + 34 for r in rows]
col = (18, 28, 44) if bg == 'dark' else (214, 226, 236)
sheet = Image.new('RGB', (W, sum(hs)), col)
dr = ImageDraw.Draw(sheet)
y = 0
for r, h in zip(rows, hs):
    x = gap
    for name, im in r:
        sheet.paste(im, (x, y + h - 22 - im.height), im)
        dr.text((x, y + h - 16), name, fill=(235, 235, 235) if bg == 'dark' else (20, 20, 20))
        x += im.width + gap
    y += h
sheet.save(out, quality=88)
print(out, sheet.size)
