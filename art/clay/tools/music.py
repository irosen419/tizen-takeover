"""music.py gen|cut|export [SHEET ...]: the Now Playing stage art (Ian and Ember
playing music, their genre outfits and a backing band; docs/band.md).

These sheets are kept out of sheets.SHEETS on purpose, so export.py (the
wanderers' sprite set) never sees them; this script adds them before it runs.

  python3 art/clay/tools/music.py gen mus-ian      # ask Gemini for a sheet (one image)
  python3 art/clay/tools/music.py cut              # cut every music sheet
  python3 art/clay/tools/music.py export           # app/clay/music/*.webp and app/clay/music.js

Sprites are exported at twice the hub's natural size (Ian standing 320 px),
so the stage can show them up to 2x on full screen without blurring; music.js
gives each one's size at 1x. The backing band is darkened here, in the
picture, because the TV must not use CSS filters."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sheets
from sheets import sheet

R = 'side view facing right'
sheet('mus-ian', 'ian', 'green', [
 ('stand', "Standing upright and relaxed, facing the camera, arms at his sides, warm half-smile."),
 ('drums', "Seated on a small stool behind a small chunky clay drum kit (one bass drum with a plain round red front, a snare, one cymbal on a stand), facing the camera, both drumsticks raised high mid-hit, mouth open shouting with joy. The drum kit is part of this pose."),
 ('headphones', "Standing facing the camera wearing big chunky black over-ear headphones, eyes closed blissfully, head tilted, one hand pressing an ear cup, nodding along to music."),
 ('air-guitar', f"Rocking out, {R}: one knee down in a power slide, back arched, playing an invisible air guitar, mouth wide open."),
 ('dance-point', "Disco dancing facing the camera: one arm pointing up diagonally to the sky, the other hand on his hip, hips swung to one side, big grin."),
 ('mic', "Singing his heart out facing the camera into a handheld chunky black clay microphone held close to his mouth, eyes closed, other arm stretched out wide."),
])
sheet('mus-ember', 'ember', 'blue', [
 ('stand', "Standing on all four paws, facing the camera, tail up, happy open mouth."),
 ('guitar', "Standing upright on her hind legs facing the camera, holding a small chunky cherry-red clay electric guitar across her chest, one front paw on the neck, the other strumming, tongue out, rock-star grin."),
 ('mic', "Standing upright on her hind legs facing the camera behind a black clay microphone on a tall stand, both front paws gripping the stand, head tilted back, mouth wide open singing."),
 ('headphones', "Sitting facing the camera wearing big chunky black over-ear headphones over her floppy ears, eyes closed, blissful smile, head tilted to one side."),
 ('dance', "Standing on her hind legs, front paws raised high and out to the sides in a dance, tail wagging, tongue out, a happy bounce."),
 ('howl-mic', "Sitting, side view facing right, howling up at the sky into a small black clay handheld microphone held in one front paw."),
])
sheet('mus-ian-fits', 'ian', 'green', [
 ('stand', "Standing upright and relaxed, facing the camera, arms at his sides, warm half-smile, in his usual hoodie."),
 ('punk', "Standing facing the camera dressed as a 2000s pop-punk rocker INSTEAD of his hoodie: black button-up shirt with a skinny red necktie, black skinny jeans, black eyeliner smudged around his eyes, the small tuft of hair spiked up, a red armband, black skate sneakers, playing a black electric guitar slung low, smirking. Still wears his glasses."),
 ('grunge', "Standing facing the camera dressed for post-grunge hard rock INSTEAD of his hoodie: worn black leather jacket over a dark grey t-shirt, ripped black jeans, a wallet chain, combat boots, fingerless gloves, one fist raised in a rock salute, intense brooding look. Still wears his glasses."),
 ('country', "Standing facing the camera dressed as a country singer INSTEAD of his hoodie: tan cowboy hat, red and white plaid snap shirt, big belt buckle, blue jeans, brown cowboy boots, holding an acoustic guitar by the neck, tipping the hat with a grin."),
 ('hiphop', "Standing facing the camera dressed for hip-hop INSTEAD of his hoodie: oversized white and purple track jacket, a chunky gold chain, a black bucket hat, white high-top sneakers, arms crossed, cool nod."),
 ('synth', "Standing facing the camera dressed for 1980s synth-pop INSTEAD of his hoodie: bright pink and purple windbreaker, white pants, pink shutter-shade sunglasses over his eyes, a small purple keytar held across his body, striking a pose."),
], note="Never use any green in his clothes or props.")
sheet('mus-ember-fits', 'ember', 'blue', [
 ('stand', "Standing on all four paws, facing the camera, tail up, happy open mouth, no clothes."),
 ('punk', "Standing facing the camera wearing a black spiked clay collar and a small red bandana, a tiny black eyeliner smudge, punk-rock grin."),
 ('grunge', "Sitting facing the camera wearing a tiny black leather jacket with silver zips, brooding cool look."),
 ('country', "Sitting facing the camera wearing a small tan cowboy hat and a red bandana around her neck, tongue out."),
 ('hiphop', "Sitting facing the camera wearing a chunky gold chain and small black sunglasses, head tilted, cool."),
 ('synth', "Standing on her hind legs facing the camera wearing pink star-shaped sunglasses and a bright pink sweatband, front paws up, dancing."),
], note="Never use any blue in her clothes or props.")

sheets.REFS['band'] = ['models/ian-and-ember.jpg']
sheets.INTRO['band'] = ("The reference image shows two clay puppets, a man and his dog, from a hand-made stop-motion film. Do NOT draw "
  "those two. Draw a small backing band of OTHER clay puppets for the same film: invented, generic people who look like nobody "
  "real, with the same chunky proportions (large head about one third of the height, big simple hands, small glossy bead eyes), "
  "sculpted from the same plasticine clay with visible fingerprints.")
sheets.WHAT['band'] = 'different clay puppet musicians'
sheet('mus-band', 'band', 'green', [
 ('bass', "A tall woman with a curly red bob and a mustard yellow jumpsuit, standing facing the camera, playing a cream bass guitar, nodding."),
 ('keys', "A round cheerful man with a grey ponytail and a purple shirt, standing facing the camera behind a small red keyboard on a stand, both hands on the keys."),
 ('sax', "A short woman with a black afro and a bright orange suit, standing facing the camera, playing a gold saxophone pointed up, cheeks puffed."),
 ('singers', "Two backup singers side by side touching shoulders, a man and a woman in matching pink sequined outfits, facing the camera, each with one arm raised, mouths open singing."),
], note="Never use any green in their clothes or instruments.")


MUSIC = ['mus-ian', 'mus-ember', 'mus-ian-fits', 'mus-ember-fits', 'mus-band']
ROOT = os.path.dirname(HERE)
UNIT = 320            # Ian standing, in exported pixels (2x the hub's 160)
EMBER_REL = 0.58
BAND_DIM = 0.8
SKIP = {'mus-ian': ['stand'], 'mus-ember': ['stand'], 'mus-ian-fits': ['stand'], 'mus-ember-fits': ['stand']}
PREFIX = {'mus-ian': 'ian/', 'mus-ember': 'ember/', 'mus-ian-fits': 'ian/fit-', 'mus-ember-fits': 'ember/fit-', 'mus-band': 'band/'}

def resize(im, scale):
    """The same premultiplied-alpha scaling as export.py (which runs on import)."""
    import numpy as np
    from PIL import Image
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

def export(out='app/clay'):
    import numpy as np
    from PIL import Image, ImageEnhance
    sprites, total = {}, 0
    for sid in MUSIC:
        s = sheets.SHEETS[sid]
        cutdir = os.path.join(ROOT, 'cut', sid)
        meta = json.load(open(os.path.join(cutdir, '_meta.json')))
        base = UNIT * (EMBER_REL if s['who'] == 'ember' else 0.95 if s['who'] == 'band' else 1)
        for name in meta['poses']:
            if name in SKIP.get(sid, []):
                continue
            im = Image.open(os.path.join(cutdir, name + '.png')).convert('RGBA')
            im = im.crop(im.getbbox())
            im = resize(im, base / (meta['calib_h'] - 16))
            im = im.crop(im.getbbox())
            if s['who'] == 'band':
                r, g, b, a = im.split()
                rgb = ImageEnhance.Brightness(Image.merge('RGB', (r, g, b))).enhance(BAND_DIM)
                im = Image.merge('RGBA', rgb.split() + (a,))
            key = PREFIX[sid] + name
            rel = 'music/' + key.replace('/', '-') + '.webp'
            os.makedirs(os.path.join(out, 'music'), exist_ok=True)
            im.save(os.path.join(out, rel), 'WEBP', quality=88, alpha_quality=100, method=6)
            total += os.path.getsize(os.path.join(out, rel))
            sprites[key] = {'file': rel, 'w': round(im.width / 2), 'h': round(im.height / 2)}
    js = ('// Made by art/clay/tools/music.py export; do not edit. Sizes are at 1x\n'
          '// (Ian standing 160 px); the files are drawn at 2x.\n'
          'var CLAY_MUSIC = ' + json.dumps({'scale': 2, 'sprites': sprites}, sort_keys=True, separators=(',', ':')) + ';\n')
    open(os.path.join(out, 'music.js'), 'w').write(js)
    print(f'{len(sprites)} sprites, {total // 1024} KB')

if __name__ == '__main__':
    what, ids = sys.argv[1], sys.argv[2:] or MUSIC
    if what == 'gen':
        import gen
        for sid in ids: print(gen.gen(sid), flush=True)
    elif what == 'cut':
        import cut
        for sid in ids: print(cut.cut(sid))
    elif what == 'export':
        export()
