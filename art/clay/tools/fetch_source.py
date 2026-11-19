"""fetch_source.py: download the clay source art (raw/ and models/) from the
picture bucket into art/clay/, checking each file against source.sha256.

The source art is not kept in git (it was 33 MB of the repo); it lives in the
public Cloudflare R2 bucket home-hub-pictures under clay/source/v1/. Run this
once before gen.py, cut.py or export.py:

    python3 art/clay/tools/fetch_source.py

Files already present with the right checksum are skipped. Uses only the
standard library."""
import hashlib, os, sys, urllib.request

BASE = 'https://pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev/clay/source/v1/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 16), b''):
            h.update(block)
    return h.hexdigest()


def main():
    got = skipped = 0
    bad = []
    with open(os.path.join(ROOT, 'source.sha256')) as f:
        lines = [l.split() for l in f if l.strip()]
    for want, rel in lines:
        out = os.path.join(ROOT, rel)
        if os.path.exists(out) and sha(out) == want:
            skipped += 1
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        req = urllib.request.Request(BASE + rel, headers={'User-Agent': 'home-hub-art-tools'})  # Cloudflare refuses urllib's default
        with urllib.request.urlopen(req, timeout=60) as r, open(out + '.part', 'wb') as w:
            w.write(r.read())
        if sha(out + '.part') != want:
            os.remove(out + '.part')
            bad.append(rel)
            continue
        os.replace(out + '.part', out)
        got += 1
    print('downloaded %d, already here %d, failed %d' % (got, skipped, len(bad)))
    for rel in bad:
        print('  checksum mismatch: ' + rel)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
