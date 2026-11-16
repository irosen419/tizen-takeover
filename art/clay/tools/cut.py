"""cut.py SHEET_ID [...]: key out the chroma backdrop of raw/<sheet>.jpg and
slice it into one transparent PNG per pose (cut/<sheet>/<pose>.png, full size).
Prints what it found so a wrong pose count is obvious."""
import os, sys, json
import numpy as np
from PIL import Image
from scipy import ndimage
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sheets
ROOT = os.path.dirname(HERE)          # art/clay

def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)

def key(rgb, colour):
    """rgb: float array 0..1. Returns straight (un-premultiplied) RGBA float."""
    kc = {'green': 1, 'blue': 2}[colour]
    oc = [c for c in (0, 1, 2) if c != kc]
    k = rgb[..., kc]
    other = np.maximum(rgb[..., oc[0]], rgb[..., oc[1]])
    dom = k - other                                   # how much the key colour wins
    ratio = dom / np.maximum(k, 1e-3)
    # backdrop colour, from the image border
    b = np.concatenate([rgb[:6].reshape(-1, 3), rgb[-6:].reshape(-1, 3),
                        rgb[:, :6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3)])
    bg = np.median(b, axis=0)
    bg_ratio = (bg[kc] - max(bg[oc[0]], bg[oc[1]])) / max(bg[kc], 1e-3)
    alpha = 1 - smoothstep(0.12 * bg_ratio, 0.62 * bg_ratio, ratio)
    alpha[dom < 0.03] = 1.0                           # near-neutral darks are never backdrop
    # pull the matte in by about a pixel to drop the JPEG fringe, then soften
    alpha = ndimage.minimum_filter(alpha, size=3)
    alpha = ndimage.gaussian_filter(alpha, 0.6)
    alpha[alpha < 0.02] = 0
    if colour == 'blue':
        # motion blur over blue turns purple; nothing in these sheets is purple
        alpha[(rgb[..., 2] - rgb[..., 1]) > 0.08] = 0
    # Edge pixels are a blend of clay and backdrop. Rather than un-mix them (which
    # tints pale clay), give them the colour of the solid clay next to them.
    solid = (alpha > 0.98).astype(np.float32)
    fg = rgb.copy()
    todo = (alpha > 0) & (alpha <= 0.98)
    for sigma in (1.5, 4.0):
        w = ndimage.gaussian_filter(solid, sigma)
        ext = np.dstack([ndimage.gaussian_filter(rgb[..., i] * solid, sigma) for i in range(3)]) / np.maximum(w, 1e-4)[..., None]
        use = todo & (w > 0.02)
        fg[use] = ext[use]
        todo &= ~use
    # anything still unresolved (glass, far from solid clay): un-mix, then clamp the spill
    a = np.maximum(alpha, 0.05)[..., None]
    unmixed = np.clip((rgb - (1 - a) * bg) / a, 0, 1)
    fg[todo] = unmixed[todo]
    spill = np.maximum(fg[..., oc[0]], fg[..., oc[1]])
    fg[..., kc] = np.minimum(fg[..., kc], spill)
    return np.dstack([fg, alpha])

def reading_order(blobs, rows):
    if rows <= 1:
        return sorted(blobs, key=lambda b: b['cx'])
    by_y = sorted(blobs, key=lambda b: b['cy'])
    gaps = sorted(range(1, len(by_y)), key=lambda i: by_y[i]['cy'] - by_y[i - 1]['cy'], reverse=True)[:rows - 1]
    out, start = [], 0
    for cut in sorted(gaps) + [len(by_y)]:
        out += sorted(by_y[start:cut], key=lambda b: b['cx'])
        start = cut
    return out

def cut(sid):
    s = sheets.SHEETS[sid]
    im = Image.open(os.path.join(ROOT, 'raw', sid + '.jpg')).convert('RGB')
    rgba = key(np.asarray(im, dtype=np.float32) / 255, s['key'])
    solid = rgba[..., 3] > 0.5
    lab, n = ndimage.label(solid)
    if n == 0:
        return f'{sid}: nothing found'
    areas = ndimage.sum(solid, lab, range(1, n + 1))
    objs = ndimage.find_objects(lab)
    cents = ndimage.center_of_mass(solid, lab, range(1, n + 1))
    big_min = (0.02 if s['who'] == 'props' else 0.15) * areas.max()
    mains, minors = [], []
    for i in range(n):
        ys, xs = objs[i]
        b = dict(label=i + 1, area=float(areas[i]), cy=cents[i][0], cx=cents[i][1],
                 box=[xs.start, ys.start, xs.stop, ys.stop], labels=[i + 1])
        (mains if areas[i] >= big_min else minors).append(b)
    # loose bits (a flying sock, a toggle) join the nearest pose; specks are dropped
    for m in minors:
        if m['area'] < 0.0004 * areas.max():
            continue
        near = min(mains, key=lambda b: max(b['box'][0] - m['cx'], m['cx'] - b['box'][2], 0) +
                                        max(b['box'][1] - m['cy'], m['cy'] - b['box'][3], 0))
        d = max(near['box'][0] - m['cx'], m['cx'] - near['box'][2], 0) + max(near['box'][1] - m['cy'], m['cy'] - near['box'][3], 0)
        if d < 0.04 * im.width:
            near['labels'].append(m['label'])
            near['box'] = [min(near['box'][0], m['box'][0]), min(near['box'][1], m['box'][1]),
                           max(near['box'][2], m['box'][2]), max(near['box'][3], m['box'][3])]
    mains = reading_order(mains, s['rows'])
    if s.get('join'):
        # One pose can be several pieces. join='stack': pieces sitting over each other
        # (the dot of an exclamation mark). join='near': pieces that nearly touch
        # (a man and a dog standing side by side).
        joined = [mains[0]]
        for b in mains[1:]:
            a = joined[-1]
            overlap = min(a['box'][2], b['box'][2]) - max(a['box'][0], b['box'][0])
            if s['join'] == 'stack':
                same = overlap > 0.5 * min(a['box'][2] - a['box'][0], b['box'][2] - b['box'][0])
            else:
                same = -overlap < 0.03 * im.width
            if same:
                a['labels'] += b['labels']
                a['box'] = [min(a['box'][0], b['box'][0]), min(a['box'][1], b['box'][1]),
                            max(a['box'][2], b['box'][2]), max(a['box'][3], b['box'][3])]
            else:
                joined.append(b)
        mains = joined
    names = s.get('found') or [p[0] for p in s['poses']]
    outdir = os.path.join(ROOT, 'cut', sid)
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        os.remove(os.path.join(outdir, f))
    ok = len(mains) == len(names)
    msg = f"{sid}: found {len(mains)} of {len(names)}" + ('' if ok else '  <-- MISMATCH, nothing named')
    meta = {'calib_h': mains[0]['box'][3] - mains[0]['box'][1], 'poses': {}, 'boxes': {}}
    for i, b in enumerate(mains):
        name = names[i] if ok else f'_{i + 1}'
        if name is None:
            continue
        x0, y0, x1, y1 = b['box']
        meta['boxes'][name] = [int(v) for v in b['box']]     # where it sat on the sheet (for lifts)
        pad = 8
        x0, y0, x1, y1 = max(x0 - pad, 0), max(y0 - pad, 0), min(x1 + pad, im.width), min(y1 + pad, im.height)
        crop = rgba[y0:y1, x0:x1].copy()
        mine = np.isin(lab[y0:y1, x0:x1], b['labels'])
        mine = ndimage.binary_dilation(mine, iterations=4)      # keep this pose's soft edge only
        crop[..., 3] *= mine
        crop[crop[..., 3] == 0, :3] = 0
        Image.fromarray((crop * 255 + 0.5).astype(np.uint8), 'RGBA').save(os.path.join(outdir, name + '.png'))
        meta['poses'][name] = [x1 - x0, y1 - y0]
        msg += f"\n   {name}: {x1 - x0}x{y1 - y0}"
    json.dump(meta, open(os.path.join(outdir, '_meta.json'), 'w'))
    touch = [b for b in mains if b['box'][0] <= 1 or b['box'][1] <= 1 or b['box'][2] >= im.width - 1 or b['box'][3] >= im.height - 1]
    if touch:
        msg += f"\n   WARNING: {len(touch)} pose(s) touch the image edge"
    return msg

if __name__ == '__main__':
    for sid in sys.argv[1:]:
        print(cut(sid), flush=True)
