"""gen.py SHEET_ID [...]: ask Gemini for pose sheets. Needs GEMINI_API_KEY.
Saves raw/<sheet>.jpg next to this folder's parent (art/clay/raw)."""
import base64, json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sheets
ROOT = os.path.dirname(HERE)          # art/clay
MODEL = os.environ.get('GEMINI_IMAGE_MODEL', 'gemini-nano-banana-2.1')

def gen(sid):
    s = sheets.SHEETS[sid]
    parts = []
    for r in sheets.REFS[s['who']] + [p for p, _ in s['refs']]:
        data = open(os.path.join(ROOT, r), 'rb').read()
        mime = {'.png': 'image/png', '.webp': 'image/webp'}.get(os.path.splitext(r)[1], 'image/jpeg')
        parts.append({'inline_data': {'mime_type': mime, 'data': base64.b64encode(data).decode()}})
    parts.append({'text': sheets.prompt(sid)})
    body = {'contents': [{'role': 'user', 'parts': parts}],
            'generationConfig': {'responseModalities': ['IMAGE'],
                                 'imageConfig': {'aspectRatio': s.get('aspect', '21:9'), 'imageSize': '2K'}}}
    req = urllib.request.Request(
        f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': os.environ['GEMINI_API_KEY']})
    for attempt in range(4):
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=300))
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(20 * (attempt + 1)); continue
            return f'{sid}: HTTP {e.code} {msg}'
        except Exception as e:
            if attempt < 3:
                time.sleep(10); continue
            return f'{sid}: {e!r}'
        for c in resp.get('candidates', []):
            for p in c.get('content', {}).get('parts', []):
                d = p.get('inlineData') or p.get('inline_data')
                if d:
                    os.makedirs(os.path.join(ROOT, 'raw'), exist_ok=True)
                    out = os.path.join(ROOT, 'raw', sid + '.jpg')
                    open(out, 'wb').write(base64.b64decode(d['data']))
                    return f'{sid}: saved'
        if attempt < 3:
            time.sleep(5); continue
        return f'{sid}: no image ({json.dumps(resp)[:300]})'

if __name__ == '__main__':
    ids = sys.argv[1:]
    with ThreadPoolExecutor(max_workers=4) as ex:
        for line in ex.map(gen, ids):
            print(line, flush=True)
