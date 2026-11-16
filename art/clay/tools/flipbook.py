"""flipbook.py OUT SEQ [options]: play a sequence as motion, to check a gait cycle.

Writes OUT.jpg (every frame of the cycle on one floor line, named) and OUT.mp4
(the character crossing a dark strip with a floor line, one stride per cycle,
each frame raised by its lift). SEQ is a sequence name from sprites.json or
frame keys joined by commas. Needs ffmpeg.

  --stride PX     px travelled per cycle (default: the manifest's strides)
  --before SEQ    a second lane above, labelled Before / After, at the same speed
  --fps N         poses a second (default 12)
  --zoom Z        draw the sprites Z times their size (default 2)
  --seconds S     length of the clip (default 8)
  --app DIR       where sprites.json lives (default app/clay)"""
import argparse, json, os, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('seq')
ap.add_argument('--stride', type=float); ap.add_argument('--before')
ap.add_argument('--fps', type=float, default=12); ap.add_argument('--zoom', type=float, default=2)
ap.add_argument('--seconds', type=float, default=8); ap.add_argument('--app', default='app/clay')
ap.add_argument('--width', type=int, default=1280)
a = ap.parse_args()

M = json.load(open(os.path.join(a.app, 'sprites.json')))
def frames(seq):
    return M['sequences'][seq] if seq in M['sequences'] else seq.split(',')
cache = {}
def sprite(key):
    if key not in cache:
        e = M['sprites'][key]
        im = Image.open(os.path.join(a.app, e['file'])).convert('RGBA')
        im = im.resize((round(im.width * a.zoom), round(im.height * a.zoom)), Image.LANCZOS)
        cache[key] = (im, e['cx'] * a.zoom)
    return cache[key]
lifts = M.get('lifts', {})
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
    small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 13)
except OSError:
    font = small = ImageFont.load_default()
BG, FLOOR, INK = (18, 28, 44), (120, 140, 170), (235, 235, 235)

new = frames(a.seq)
stride = a.stride if a.stride is not None else M.get('strides', {}).get(a.seq)
if stride is None:
    raise SystemExit(f'no stride for {a.seq}: pass --stride')
lanes = [('After' if a.before else None, new)]
if a.before:
    lanes.insert(0, ('Before', frames(a.before)))
step = stride * a.zoom / len(new)              # px per pose, the same in both lanes
lane_h = round(max(sprite(k)[0].height + lifts.get(k, 0) * a.zoom for _, fr in lanes for k in fr) + 40)

# the strip: each frame of the new cycle on one floor line
gap = 16
ims = [sprite(k)[0] for k in new]
W = sum(im.width + gap for im in ims) + gap
strip = Image.new('RGB', (W, lane_h + 24), BG)
d = ImageDraw.Draw(strip)
floor = lane_h - 8
d.line([(0, floor), (W, floor)], fill=FLOOR, width=2)
x = gap
for k, im in zip(new, ims):
    strip.paste(im, (x, round(floor - im.height - lifts.get(k, 0) * a.zoom)), im)
    d.text((x, floor + 6), k.split('/')[-1], fill=INK, font=small)
    x += im.width + gap
strip.save(a.out + '.jpg', quality=90)

# the clip
H = lane_h * len(lanes)
n = round(a.seconds * a.fps)
cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{a.width}x{H}',
       '-r', str(a.fps), '-i', '-', '-vf', 'fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
       '-movflags', '+faststart', a.out + '.mp4']
p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
margin = 150 * a.zoom
for i in range(n):
    fr = Image.new('RGB', (a.width, H), BG)
    d = ImageDraw.Draw(fr)
    for li, (label, seq) in enumerate(lanes):
        top = li * lane_h
        fl = top + lane_h - 10
        d.line([(0, fl), (a.width, fl)], fill=FLOOR, width=2)
        for t in range(0, a.width, 40):             # ticks, so sliding feet show
            d.line([(t, fl), (t, fl + 6)], fill=FLOOR, width=1)
        if label:
            d.text((14, top + 10), label, fill=INK, font=font)
        k = seq[i % len(seq)]
        im, cx = sprite(k)
        x = (margin + i * step) % (a.width + margin) - margin / 2
        fr.paste(im, (round(x - cx), round(fl - im.height - lifts.get(k, 0) * a.zoom)), im)
        if li:
            d.line([(0, top), (a.width, top)], fill=(40, 52, 70), width=2)
    p.stdin.write(fr.tobytes())
p.stdin.close(); p.wait()
print(a.out + '.jpg', strip.size, a.out + '.mp4', f'{a.width}x{H}', f'{n} poses')
