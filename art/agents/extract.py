"""Cut Lift (and Wyndle) out of the private reference sheet for app/agents.js.

    python3 art/agents/extract.py <lift-pixel-skate-strip.png> [out-folder] [preview-folder]

The source sheet (1088x960, flat grey background) is private reference art
kept in the project files (home-hub-agents/gemini/), never in this repo.
Its big top frame is the one used: the four small frames in the boxed strip
under it are near copies of each other (only the last holds the bread), too
alike to read as a skate cycle, so the motion on the TV is made from
transform (glide, bob, lean) on this one picture instead.

What it does, needing only Pillow:
  1. Background: a flood fill from the edges over pixels close to the grey
     (low saturation, near the local grey), so the grey inside her hair and
     between her legs that touches the outside goes too; then the fringe:
     any kept pixel touching the background that is still greyish is
     dropped, so there is no grey halo on the TV's dark blue.
  2. Down to the art's own pixels: the sheet is drawn with art pixels about
     4 source pixels wide. Each 4x4 block becomes one pixel (the median of
     its opaque pixels, kept when over half the block is opaque), at the grid
     phase that gives the least colour spread inside blocks.
  3. Wyndle's head and neck (a box right of the bread, above where the
     neck meets the vine) go into a picture of their own so the hub can sway it
     (rotate about its base); the rest is Lift with Wyndle's body.
  4. Writes, as lossless transparent WebP:
       <out>/lift.webp     Lift skating, Wyndle's vine body (no head)
       <out>/wyndle.webp   Wyndle's head and neck
     and prints their sizes and where the head sits on the body picture
     (the numbers go into the roster in app/agents.js).
  With a preview folder, also writes the two joined at 4x on a dark and a
  light backdrop (preview-dark.png, preview-light.png) to check the fringe.

The other poses (the sequence in docs/agents.md: skid, crouch, leap, wave):

    python3 art/agents/extract.py --poses <raw-folder> [out-folder] [preview-folder]

<raw-folder> holds the sheets art/agents/gen.py asked Gemini for (kept in
the project files, home-hub-agents/lift-v2/raw/, never in this repo). Each
of those sheets has the old skating pose on its left (for scale) and the
new pose on its right (POSES below: which sheet, which box). For each:
  1. The background is cut as above, with two more kinds of pixel taken as
     background when they touch it: the faint blue-grey ground shadow and
     the pale glow Gemini paints round Stormlight (both greyish and no
     warmer than neutral, so skin, shirt, hair and Wyndle never match).
     Bits not joined to the figure go, except bright sparkles near it.
  2. The scale: the skating figure on the same sheet is measured and the
     whole sheet is brought down so that figure would be exactly as tall
     as lift.webp (112 art pixels), so every pose has the same art-pixel
     size and Lift and Wyndle look the same size in every pose. Each art
     pixel is the median of its block's opaque source pixels, kept when
     over half the block is opaque (as above, with a fractional block).
  3. Writes <out>/<pose>.webp (lossless, transparent) and prints each size
     and where its feet are (for the roster in app/agents.js). With a
     preview folder: every pose (and the skate) at 4x on dark and light
     (poses-dark.png, poses-light.png), to check the fringe.
"""
import sys
import os
from collections import deque
from PIL import Image

BIG = (240, 40, 800, 540)      # the big frame on the sheet (left, top, right, bottom)
CELL = 4                        # source pixels per art pixel
GREY_TOL = 26                   # how far from the grey a background pixel may be
SAT_TOL = 14                    # and how colourful (max - min of r, g, b)
HOLE_MIN = 40                   # a closed-in grey patch this big (source pixels) is background
# Wyndle's head and neck, in art pixels of the cut picture (left, top,
# right, bottom), found by eye on the 4x preview: clear of the bread and her
# front foot, down to where the neck meets the vine.
HEAD_BOX = (112, 48, 132, 88)
NECK_BOX = (106, 58, 112, 88)   # the neck's left edge, under the bread


def greyish(p, ref):
    r, g, b = p[:3]
    if max(r, g, b) - min(r, g, b) > SAT_TOL:
        return False
    return abs(r - ref[0]) + abs(g - ref[1]) + abs(b - ref[2]) <= GREY_TOL * 3


def cut_background(im):
    w, h = im.size
    px = im.load()
    bg = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        q.append((x, 0, px[x, 0]))
        q.append((x, h - 1, px[x, h - 1]))
    for y in range(h):
        q.append((0, y, px[0, y]))
        q.append((w - 1, y, px[w - 1, y]))
    while q:
        x, y, ref = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or bg[y][x]:
            continue
        p = px[x, y]
        if not greyish(p, ref):
            continue
        bg[y][x] = True
        # The reference follows the grey slowly, for the sheet's soft gradient.
        nref = tuple((ref[i] * 3 + p[i]) // 4 for i in range(3))
        q.append((x + 1, y, nref))
        q.append((x - 1, y, nref))
        q.append((x, y + 1, nref))
        q.append((x, y - 1, nref))
    # Grey closed in by her (between her legs and the vine, behind the
    # bread, inside Wyndle's coil): any grey patch of HOLE_MIN pixels or more
    # that is the sheet's grey goes too.
    seen = [[False] * w for _ in range(h)]
    for y0 in range(h):
        for x0 in range(w):
            if bg[y0][x0] or seen[y0][x0] or not greyish(px[x0, y0], (182, 182, 182)):
                continue
            patch = []
            q = deque([(x0, y0)])
            seen[y0][x0] = True
            while q:
                x, y = q.popleft()
                patch.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and not bg[ny][nx] and greyish(px[nx, ny], (182, 182, 182)):
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(patch) >= HOLE_MIN:
                for x, y in patch:
                    bg[y][x] = True
    # Fringe: kept pixels next to the background that are still greyish
    # (anti-aliasing towards the grey), twice.
    for _ in range(2):
        drop = []
        for y in range(h):
            for x in range(w):
                if bg[y][x]:
                    continue
                near = False
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and bg[ny][nx]:
                        near = True
                        break
                if near and greyish(px[x, y], (182, 182, 182)):
                    drop.append((x, y))
        for x, y in drop:
            bg[y][x] = True
    out = Image.new('RGBA', (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            op[x, y] = (0, 0, 0, 0) if bg[y][x] else (r, g, b, 255)
    return out


def median(vals):
    vals = sorted(vals)
    return vals[len(vals) // 2]


def to_art_pixels(im, ox, oy):
    w, h = im.size
    px = im.load()
    W = (w - ox) // CELL
    H = (h - oy) // CELL
    out = Image.new('RGBA', (W, H))
    op = out.load()
    spread = 0
    for j in range(H):
        for i in range(W):
            cols = []
            for y in range(oy + j * CELL, oy + (j + 1) * CELL):
                for x in range(ox + i * CELL, ox + (i + 1) * CELL):
                    p = px[x, y]
                    if p[3]:
                        cols.append(p)
            if len(cols) * 2 <= CELL * CELL:
                op[i, j] = (0, 0, 0, 0)
                continue
            m = tuple(median([c[k] for c in cols]) for k in range(3))
            spread += sum(abs(c[k] - m[k]) for c in cols for k in range(3))
            op[i, j] = m + (255,)
    return out, spread


# The new poses: (name, sheet, the skating figure's box, the pose's box),
# boxes in sheet pixels (left, top, right, bottom), found by eye.
POSES = [
    ('skid', 'skid-2.png', (0, 0, 650, 768), (690, 0, 1344, 768)),
    ('crouch', 'crouch-1.png', (0, 0, 660, 768), (700, 0, 1344, 768)),
    ('leap', 'poses-b-1.png', (0, 0, 505, 768), (515, 0, 955, 768)),
    ('wave', 'poses-b-1.png', (0, 0, 505, 768), (960, 0, 1344, 768)),
]
SKATE_H = 112                   # lift.webp's height, art pixels


def shadowish(p, bgv):
    """The ground shadow and the pale Stormlight haze: greyish, near the
    grey's brightness, and blue or neutral (never warm like skin)."""
    r, g, b = p[:3]
    if max(r, g, b) - min(r, g, b) > 45 or b < r - 4:
        return False
    return abs((r + g + b) / 3.0 - bgv) <= 45


def cut_pose(im):
    """cut_background, then the shadow and haze touching the background,
    then the bits not joined to the biggest piece (bright sparkles near it stay)."""
    out = cut_background(im)
    w, h = im.size
    src = im.load()
    op = out.load()
    c = src[2, 2]
    bgv = sum(c[:3]) / 3.0
    q = deque()
    for y in range(h):
        for x in range(w):
            if op[x, y][3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and op[nx, ny][3] and shadowish(src[nx, ny], bgv):
                        q.append((nx, ny))
    while q:
        x, y = q.popleft()
        if not op[x, y][3] or not shadowish(src[x, y], bgv):
            continue
        op[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and op[nx, ny][3]:
                q.append((nx, ny))
    # Pieces (8-connected): keep the biggest, and small bright ones within
    # 40 px of its box (Stormlight sparkles); drop the rest.
    lab = [[0] * w for _ in range(h)]
    pieces = []
    for y0 in range(h):
        for x0 in range(w):
            if not op[x0, y0][3] or lab[y0][x0]:
                continue
            n = len(pieces) + 1
            pts = []
            q = deque([(x0, y0)])
            lab[y0][x0] = n
            while q:
                x, y = q.popleft()
                pts.append((x, y))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and op[nx, ny][3] and not lab[ny][nx]:
                            lab[ny][nx] = n
                            q.append((nx, ny))
            pieces.append(pts)
    if not pieces:
        return out
    big = max(pieces, key=len)
    bx0 = min(p[0] for p in big) - 40
    bx1 = max(p[0] for p in big) + 40
    by0 = min(p[1] for p in big) - 40
    by1 = max(p[1] for p in big) + 40
    for pts in pieces:
        if pts is big:
            continue
        bright = sum(sum(src[x, y][:3]) for x, y in pts) / float(len(pts)) > 600
        near = all(bx0 <= x <= bx1 and by0 <= y <= by1 for x, y in pts)
        if len(pts) > 400 and not bright:
            continue          # a big piece of the figure (Wyndle apart from her): keep
        if not (bright and near) and len(pts) < 400:
            for x, y in pts:
                op[x, y] = (0, 0, 0, 0)
    return out


def shrink(im, f):
    """Down by a (fractional) factor f: each art pixel the median of its
    block's opaque pixels, kept when over half the block is opaque."""
    w, h = im.size
    W = int(w / f)
    H = int(h / f)
    px = im.load()
    out = Image.new('RGBA', (W, H))
    op = out.load()
    for j in range(H):
        y0, y1 = int(round(j * f)), max(int(round(j * f)) + 1, int(round((j + 1) * f)))
        for i in range(W):
            x0, x1 = int(round(i * f)), max(int(round(i * f)) + 1, int(round((i + 1) * f)))
            cols = []
            for y in range(y0, min(h, y1)):
                for x in range(x0, min(w, x1)):
                    p = px[x, y]
                    if p[3]:
                        cols.append(p)
            if len(cols) * 2 <= (y1 - y0) * (x1 - x0):
                op[i, j] = (0, 0, 0, 0)
                continue
            op[i, j] = tuple(median([c[k] for c in cols]) for k in range(3)) + (255,)
    return out


def despeck(art):
    ap = art.load()
    W, H = art.size
    for y in range(H):
        for x in range(W):
            if not ap[x, y][3]:
                continue
            n = 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and ap[nx, ny][3]:
                    n += 1
            if n == 0 and sum(ap[x, y][:3]) < 600:
                ap[x, y] = (0, 0, 0, 0)
    return art


def poses_main(args):
    raw = args[0]
    out_dir = args[1] if len(args) > 1 else 'app/agents/lift'
    prev_dir = args[2] if len(args) > 2 else ''
    os.makedirs(out_dir, exist_ok=True)
    done = [('skate', Image.open(os.path.join(out_dir, 'lift.webp')).convert('RGBA'))]
    w0 = Image.open(os.path.join(out_dir, 'wyndle.webp')).convert('RGBA')
    done[0][1].alpha_composite(w0, (109, 57))
    scale = {}
    for name, sheet, ref_box, box in POSES:
        im = Image.open(os.path.join(raw, sheet)).convert('RGB')
        if sheet not in scale:
            ref = cut_pose(im.crop(ref_box))
            bb = ref.getbbox()
            scale[sheet] = (bb[3] - bb[1]) / float(SKATE_H)
        f = scale[sheet]
        cut = cut_pose(im.crop(box))
        cut = cut.crop(cut.getbbox())
        best = None
        # The grid phase with the least spread, as for the skate.
        for o in range(4):
            shifted = Image.new('RGBA', (cut.size[0] + 4, cut.size[1] + 4))
            shifted.alpha_composite(cut, (o, o))
            art = despeck(shrink(shifted, f))
            a = art.crop(art.getbbox())
            n = sum(1 for p in a.getdata() if p[3])
            if best is None or n > best[1]:
                best = (a, n)
        art = best[0]
        art.save(os.path.join(out_dir, name + '.webp'), 'WEBP', lossless=True, quality=100, method=6)
        done.append((name, art))
        # The feet: the lowest opaque row's middle.
        W, H = art.size
        ap = art.load()
        xs = [x for x in range(W) if ap[x, H - 1][3]]
        print('%s.webp %dx%d (scale 1/%.2f), feet at x %d' % (name, W, H, f, (min(xs) + max(xs)) // 2 if xs else -1))
    if prev_dir:
        os.makedirs(prev_dir, exist_ok=True)
        tw = sum(a.size[0] * 4 + 32 for _, a in done) + 32
        th = max(a.size[1] for _, a in done) * 4 + 64
        for bname, colour in (('dark', (14, 26, 42)), ('light', (236, 236, 230))):
            bgim = Image.new('RGBA', (tw, th), colour + (255,))
            x = 32
            for _, a in done:
                big = a.resize((a.size[0] * 4, a.size[1] * 4), Image.NEAREST)
                bgim.alpha_composite(big, (x, th - 32 - big.size[1]))
                x += big.size[0] + 32
            bgim.convert('RGB').save(os.path.join(prev_dir, 'poses-' + bname + '.png'))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--poses':
        poses_main(sys.argv[2:])
        return
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else 'app/agents/lift'
    prev_dir = sys.argv[3] if len(sys.argv) > 3 else ''
    sheet = Image.open(src).convert('RGB')
    frame = cut_background(sheet.crop(BIG))
    best = None
    for oy in range(CELL):
        for ox in range(CELL):
            art, spread = to_art_pixels(frame, ox, oy)
            if best is None or spread < best[1]:
                best = (art, spread)
    art = best[0].crop(best[0].getbbox())
    # Lone opaque pixels with no opaque neighbour (specks) go.
    ap = art.load()
    W, H = art.size
    for y in range(H):
        for x in range(W):
            if not ap[x, y][3]:
                continue
            n = 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and ap[nx, ny][3]:
                    n += 1
            # (The Stormlight sparkles are bright and kept even alone.)
            if n == 0 and sum(ap[x, y][:3]) < 600:
                ap[x, y] = (0, 0, 0, 0)
    head = Image.new('RGBA', (W, H))
    body = art.copy()
    hp = head.load()
    bp = body.load()
    for box in (HEAD_BOX, NECK_BOX):
        for y in range(box[1], min(H, box[3])):
            for x in range(box[0], min(W, box[2])):
                hp[x, y] = ap[x, y]
                bp[x, y] = (0, 0, 0, 0)
    hb = head.getbbox()
    head = head.crop(hb)
    os.makedirs(out_dir, exist_ok=True)
    body.save(os.path.join(out_dir, 'lift.webp'), 'WEBP', lossless=True, quality=100, method=6)
    head.save(os.path.join(out_dir, 'wyndle.webp'), 'WEBP', lossless=True, quality=100, method=6)
    print('lift.webp %dx%d, wyndle.webp %dx%d at left %d top %d (art pixels)' % (W, H, head.size[0], head.size[1], hb[0], hb[1]))
    if prev_dir:
        os.makedirs(prev_dir, exist_ok=True)
        joined = body.copy()
        joined.alpha_composite(head, (hb[0], hb[1]))
        for name, colour in (('dark', (14, 26, 42)), ('light', (236, 236, 230))):
            bgim = Image.new('RGBA', (W * 4 + 64, H * 4 + 64), colour + (255,))
            bgim.alpha_composite(joined.resize((W * 4, H * 4), Image.NEAREST), (32, 32))
            bgim.convert('RGB').save(os.path.join(prev_dir, 'preview-' + name + '.png'))


if __name__ == '__main__':
    main()
