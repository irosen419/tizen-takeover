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


def main():
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
