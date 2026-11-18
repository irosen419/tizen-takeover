"""Ask Gemini for new pose sheets of a character, with the old art as reference.

    GEMINI_VIDEO_GEN_KEY=... python3 art/agents/gen.py <out-folder> SHEET [SHEET ...]

Sends the reference pictures (the private sheets kept in the project files,
home-hub-agents/gemini/) with a prompt per sheet to gemini-2.5-flash-image
(REST generateContent) and saves each answer as <out-folder>/<sheet>-<n>.png
(n counts up so a re-roll never overwrites). The raw sheets stay out of this
repository; art/agents/extract.py cuts the poses out of them.

Reads the key from GEMINI_VIDEO_GEN_KEY only (the hub's art key, never
GEMINI_API_KEY, which belongs to another project) and never prints it.
Each image costs about $0.04: count them.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

MODEL = 'gemini-2.5-flash-image'
REFS_DIR = '/mnt/project-files/home-hub-agents/gemini/'
REFS = ['lift-pixel-skate-strip.png', 'lift-pixel-wyndle.png']

KEEP = ('Keep EXACTLY the same character as in the reference pictures: Lift, a small barefoot girl of about '
        'twelve with long wavy dark-brown hair, warm brown skin, an off-white short-sleeved shirt, dark-brown '
        'knee shorts with a knotted rope belt, and Wyndle, her green vine spren with a small round green face '
        'and a thorny vine body, always beside her. Same pixel-art style, same chunky pixel size, same '
        'colours and outline, same proportions as the big skating figure in the first reference. Stormlight '
        'is a soft blue-white glow with small square sparkles. ')
BG = ('The background must be ONE flat, solid, even mid-grey (#a0a0a0) everywhere, no gradient, no floor, '
      'no shadow on the ground, no text, no labels, no frames or boxes. ')

SHEETS = {
    # Sheet A: the skate pose again (for scale), its alternate frame, the skid, the crouch.
    'poses-a': (
        'Draw a single row of FOUR separate full-body poses of her, all facing RIGHT, evenly spaced with wide '
        'empty grey gaps between them (no pose touches another), all drawn at the same scale and standing on '
        'the same invisible baseline: '
        '1) skating forward exactly like the big figure in the first reference (for scale), bread in her hand; '
        '2) the same skate but the other stride: the other leg forward, arms swapped, still gliding on a thin '
        'line of Stormlight under her feet; '
        '3) a braking skid: leaning back, front foot pushed forward sideways, knees bent, one arm flung back, '
        'a spray of blue-white Stormlight sparks flying up from her front foot; '
        '4) crouching low on one knee, one hand pressed flat on the ground in front of her, that hand glowing '
        'bright blue-white with Stormlight, looking at her hand with concentration, Wyndle curled close '
        'beside her. '),
    # Sheet B: the skate pose again (for scale), the leap, the wave with the bread.
    'poses-b': (
        'Draw a single row of THREE separate full-body poses of her, all facing RIGHT, evenly spaced with wide '
        'empty grey gaps between them (no pose touches another), all drawn at the same scale and standing on '
        'the same invisible baseline: '
        '1) skating forward exactly like the big figure in the first reference (for scale), bread in her hand; '
        '2) a joyful spring up into the air: both arms raised high, legs tucked, a big grin, a few blue-white '
        'Stormlight sparkles around her, Wyndle stretching up beside her; '
        '3) standing and waving cheerfully with one hand raised, holding her bread loaf in the other hand, '
        'Wyndle beside her feet. '),
    # One new pose beside the skate pose (for scale): Gemini drew four skating
    # poses when asked for four different ones on one sheet (poses-a).
    'skid': (
        'Draw exactly TWO separate full-body figures of her side by side with a wide empty grey gap between '
        'them, both facing RIGHT, at the same scale on the same invisible baseline. LEFT figure: skating '
        'forward exactly like the big figure in the first reference (for scale). RIGHT figure: a DIFFERENT '
        'pose, stopping hard like a skater: her whole body leans BACKWARD (her head is behind her hips, to the '
        'LEFT), her front (right) leg is stretched out forward and she digs that heel in, her back knee is '
        'bent low, her arms are thrown up and back behind her, she grins, and a big fan-shaped spray of '
        'blue-white Stormlight sparks shoots up and forward off her front heel. Wyndle trails behind her. '),
    'crouch': (
        'Draw exactly TWO separate full-body figures of her side by side with a wide empty grey gap between '
        'them, both facing RIGHT, at the same scale on the same invisible baseline. LEFT figure: skating '
        'forward exactly like the big figure in the first reference (for scale). RIGHT figure: a DIFFERENT, '
        'LOW pose: she kneels down on one knee, leaning forward, her right arm stretched forward and down with '
        'the palm pressed flat on the ground in front of her, that hand glowing bright blue-white with '
        'Stormlight, a few sparkles rising from it, her face looking down at her hand, concentrating, Wyndle '
        'curled close beside her on the ground. She is NOT skating and NOT running. '),
}


def ask(prompt):
    key = os.environ.get('GEMINI_VIDEO_GEN_KEY', '')
    if not key:
        raise SystemExit('GEMINI_VIDEO_GEN_KEY is not set')
    parts = []
    for name in REFS:
        data = open(os.path.join(REFS_DIR, name), 'rb').read()
        parts.append({'inline_data': {'mime_type': 'image/png', 'data': base64.b64encode(data).decode()}})
    parts.append({'text': prompt})
    body = {'contents': [{'role': 'user', 'parts': parts}],
            'generationConfig': {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': '16:9'}}}
    req = urllib.request.Request(
        'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent' % MODEL,
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': key})
    for attempt in range(3):
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=300))
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (429, 500, 503) and attempt < 2:
                time.sleep(20 * (attempt + 1))
                continue
            return None, 'HTTP %d %s' % (e.code, msg)
        except Exception as e:  # network
            if attempt < 2:
                time.sleep(10)
                continue
            return None, repr(e)
        for c in resp.get('candidates', []):
            for p in c.get('content', {}).get('parts', []):
                d = p.get('inlineData') or p.get('inline_data')
                if d:
                    return base64.b64decode(d['data']), 'ok'
        return None, 'no image: ' + json.dumps(resp)[:300]
    return None, 'gave up'


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for sid in sys.argv[2:]:
        data, why = ask(KEEP + BG + SHEETS[sid])
        if data is None:
            print('%s: %s' % (sid, why), flush=True)
            continue
        n = 1
        while os.path.exists(os.path.join(out, '%s-%d.png' % (sid, n))):
            n += 1
        path = os.path.join(out, '%s-%d.png' % (sid, n))
        open(path, 'wb').write(data)
        print('%s: saved %s (1 image)' % (sid, path), flush=True)


if __name__ == '__main__':
    main()
