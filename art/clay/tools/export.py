"""export.py OUT_DIR: scale every cut-out to one common size and write WebP
sprites plus sprites.json into OUT_DIR (app/clay). Ian standing is IAN_H pixels
tall; everything else is sized against him."""
import json, os, sys
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sheets
ROOT = os.path.dirname(HERE)          # art/clay
OUT = sys.argv[1]
IAN_H = 400            # Ian, standing, in sprite pixels: about twice his size on the 1080p hub
EMBER_REL = 0.58       # Ember standing on four legs, to the top of her head, against his height

def resize(im, scale):
    """Scale an RGBA image with premultiplied alpha so edges don't pick up a fringe."""
    a = np.asarray(im, dtype=np.float32) / 255
    pm = np.dstack([a[..., :3] * a[..., 3:], a[..., 3:]])
    w, h = max(1, round(im.width * scale)), max(1, round(im.height * scale))
    chans = [Image.fromarray(pm[..., i], 'F').resize((w, h), Image.LANCZOS) for i in range(4)]
    r = np.clip(np.dstack([np.asarray(c) for c in chans]), 0, 1)
    al = r[..., 3:]
    rgb = np.where(al > 1e-4, r[..., :3] / np.maximum(al, 1e-4), 0)
    out = np.clip(np.dstack([rgb, al]), 0, 1)
    out[out[..., 3] < 0.02] = 0
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGBA')

def facing(desc):
    if 'BEHIND' in desc:
        return 'back'
    if 'facing right' in desc:
        return 'right'
    return 'front'

sprites, total = {}, 0
for sid, s in sheets.SHEETS.items():
    cutdir = os.path.join(ROOT, 'cut', sid)
    meta = json.load(open(os.path.join(cutdir, '_meta.json')))
    descs = dict(s['poses'])
    sizes = dict(zip([p[0] for p in s['poses']], s['sizes'] or []))
    base = {'ian': IAN_H, 'duo': IAN_H, 'ember': IAN_H * EMBER_REL}.get(s['who'])
    for name in meta['poses']:
        im = Image.open(os.path.join(cutdir, name + '.png')).convert('RGBA')
        im = im.crop(im.getbbox())
        if s['who'] == 'props':
            scale = sizes[name] * IAN_H / max(im.size)
        else:
            scale = base / (meta['calib_h'] - 16) * s['scales'].get(name, 1)   # 16 = the cut-out's padding
        im = resize(im, scale)
        im = im.crop(im.getbbox())
        al = np.asarray(im)[..., 3].astype(np.float32)
        cx = float((al.sum(axis=0) * np.arange(im.width)).sum() / al.sum())
        rel = f"{s['who']}/{name}.webp"
        os.makedirs(os.path.dirname(os.path.join(OUT, 'sprites', rel)), exist_ok=True)
        im.save(os.path.join(OUT, 'sprites', rel), 'WEBP', quality=90, alpha_quality=100, method=6)
        total += os.path.getsize(os.path.join(OUT, 'sprites', rel))
        key = f"{s['who']}/{name}"
        if key in sprites:
            raise SystemExit(f'duplicate sprite {key}')
        entry = {'file': 'sprites/' + rel, 'w': im.width, 'h': im.height, 'cx': round(cx, 1), 'sheet': sid}
        about = sheets.EXTRA.get(key) or descs.get(name, '')
        if s['who'] != 'props':
            entry['faces'] = facing(about)
        if about:
            entry['about'] = about
        sprites[key] = entry
for name, frames in sheets.SEQUENCES.items():
    missing = [f for f in frames if f not in sprites]
    if missing:
        raise SystemExit(f'sequence {name} names missing sprites: {missing}')
manifest = {
    'about': 'Clay sprites of Ian and Ember. Made by art/clay/tools; do not edit by hand.',
    'unit': IAN_H,
    'sprites': dict(sorted(sprites.items())),
    'sequences': sheets.SEQUENCES,
}
json.dump(manifest, open(os.path.join(OUT, 'sprites.json'), 'w'), indent=1)
print(len(sprites), 'sprites,', total // 1024, 'KB')
