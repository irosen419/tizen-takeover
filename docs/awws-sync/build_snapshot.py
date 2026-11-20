#!/usr/bin/env python3
"""Builds the AWWS snapshot the Pi's awws.set command takes (docs/awws-snapshot.md).

  build_snapshot.py board BOARD_DIR OUT.json   todos, handoffs and reach
  build_snapshot.py money PROFIT_DIR OUT.json  the money section only

BOARD_DIR holds todos/<id>.json and handoffs/<id>.json (the board's collections);
PROFIT_DIR holds the profit page's costs and royalties files. The two modes are
separate so a board sync never pays for reading the profit page. A section left
out of a snapshot keeps its last copy on the Pi. Links and emails are dropped,
librarians are cut to first names, and notes text is never sent.
"""
import json, glob, os, re, sys, datetime as dt

mode, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
iso = lambda t: t.strftime('%Y-%m-%dT%H:%M:%SZ')
BAD = re.compile(r'@|https?:|www\.', re.I)


def clean(s, n):
    s = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(s or '')).strip()
    s = re.sub(r'\s+', ' ', s)
    if BAD.search(s):
        s = BAD.sub('', s).strip()
    return s if len(s) <= n else s[:n - 1].rstrip() + '…'


def load(kind):
    rows = {}
    for f in glob.glob(os.path.join(src, kind, '*.json')):
        rows[os.path.basename(f)[:-5]] = json.load(open(f))
    return rows


MON = {m: i + 1 for i, m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}
DUE = re.compile(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(, \d{1,2}(:\d{2})? (AM|PM))?$')


def due_iso(s):
    m = DUE.match(s or '')
    if not m:
        return None
    for y in (now.year, now.year + 1):
        try:
            d = dt.date(y, MON[m.group(1)], int(m.group(2)))
        except ValueError:
            return None
        if (now.date() - d).days < 90:
            return d.isoformat()


def done_at(s):
    if not s:
        return None
    s = str(s)
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        s += 'T12:00:00Z'
    try:
        t = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(dt.timezone.utc).replace(microsecond=0)


def money_section(pdir):
    # Totals only: no item names, stores, notes or payout details.
    costs = royalties = None
    for f in glob.glob(os.path.join(pdir, '*.json')):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if isinstance(d, list) and d and isinstance(d[0], dict):
            if 'amount_usd' in d[0] and 'item' in d[0]:
                costs = d
            elif 'royalty_usd' in d[0] and 'sale_month' in d[0]:
                royalties = d
    if costs is None or royalties is None:
        return None
    by = {}
    spent = earned = 0.0
    for r in costs:
        try:
            m = str(r['month'])[:7]; a = float(r['amount_usd'])
            assert re.match(r'^\d{4}-\d{2}$', m)
        except Exception:
            continue
        spent += a; by.setdefault(m, [0.0, 0.0])[1] += a
    for r in royalties:
        try:
            m = str(r['sale_month'])[:7]; a = float(r['royalty_usd'])
            assert re.match(r'^\d{4}-\d{2}$', m)
        except Exception:
            continue
        earned += a; by.setdefault(m, [0.0, 0.0])[0] += a
    if not by:
        return None
    y, mo = map(int, min(by).split('-'))
    months = []
    while (y, mo) <= (now.year, now.month):
        k = '%04d-%02d' % (y, mo)
        e, s = by.get(k, [0.0, 0.0])
        months.append({'month': k, 'spent': round(s, 2), 'earned': round(e, 2)})
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return {'asOf': iso(now), 'currency': 'USD', 'spent': round(spent, 2), 'earned': round(earned, 2), 'months': months[-12:]}


def board_snapshot():
    todos = load('todos')
    SEC = {'now': 0, 'next': 1, 'later': 2}
    items, totals = [], {o: {'now': 0, 'next': 0, 'later': 0} for o in ('ian', 'claude', 'both')}
    for id_, r in todos.items():
        owner, sec = r.get('owner'), r.get('when')
        if owner not in totals or sec not in SEC or not re.match(r'^[A-Za-z0-9_-]{1,40}$', id_):
            continue
        d = done_at(r.get('doneAt'))
        if r.get('done'):
            if not d or (now - d).days > 7:
                continue
        else:
            totals[owner][sec] += 1
        it = {'id': id_, 'title': clean(r.get('t'), 80), 'owner': owner, 'section': sec}
        if r.get('stream'):
            it['stream'] = clean(str(r['stream']).capitalize(), 24)
        if r.get('due'):
            it['due'] = clean(r['due'], 40)
            di = due_iso(r['due'])
            if di and not r.get('done'):
                it['dueISO'] = di
        if r.get('waitingOn'):
            w = clean(r['waitingOn'], 40)
            if r.get('stream') == 'schools':
                w = w.split(' ')[0]  # librarians: first name only, never a last name
            it['waitingOn'] = w
        if r.get('done'):
            it['done'] = True
            it['doneAt'] = iso(d)
        if it['title']:
            order = r.get('order')
            order = order if isinstance(order, (int, float)) and not isinstance(order, bool) else 999
            items.append((SEC[sec], bool(r.get('done')), order, it))
    items.sort(key=lambda x: (x[0], x[1], x[2]))
    items = [x[3] for x in items][:200]

    hand = load('handoffs')
    open_n = blocked_n = 0
    hitems = []
    for id_, h in hand.items():
        st = h.get('state')
        if st == 'done' or not re.match(r'^[A-Za-z0-9_-]{1,40}$', id_[:40]):
            continue
        if st == 'blocked':
            blocked_n += 1
        else:
            open_n += 1
        hitems.append({'id': id_[:40], 'title': clean(h.get('title'), 80), 'state': 'blocked' if st == 'blocked' else 'open'})

    snap = {
        'v': 1, 'sentAt': iso(now),
        'todos': {'asOf': iso(now), 'items': items, 'totals': totals},
        'handoffs': {'asOf': iso(now), 'open': open_n, 'blocked': blocked_n, 'items': hitems[:20]},
        # Newsletter subscribers are counted by hand (Kit is not paid for); Ian recounts, then this line changes.
        'reach': {'asOf': iso(now), 'subscribers': 2, 'subscribersAsOf': '2026-11-16'},
    }
    print(len(items), 'todo items;', json.dumps(totals), 'open;', open_n, 'open handoffs,', blocked_n, 'blocked')
    return snap


if mode == 'board':
    snap = board_snapshot()
elif mode == 'money':
    mon = money_section(src)
    if not mon:
        print('NO_MONEY')
        sys.exit(2)
    snap = {'v': 1, 'sentAt': iso(now), 'money': mon}
    print('money', len(mon['months']), 'months')
else:
    sys.exit('mode must be board or money')
json.dump({'snapshot': snap}, open(out, 'w'), separators=(',', ':'), ensure_ascii=False)
print(os.path.getsize(out), 'bytes')
