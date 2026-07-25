#!/usr/bin/env python3
"""Project Planetarium — bundled-description fetcher (run by data-refresh.yml).

Builds data/descriptions.json: two-sentence English Wikipedia lead extracts
for the most notable deep-sky objects — every Messier object, every curated
NGC/IC showpiece, every commonly-named catalog entry, then the brightest of
the full NGC/IC catalog up to a fixed attempt budget. The app bundles the
result so the detail panel and crosshair card can say something worth
reading at every stop, offline, with zero per-user Wikipedia traffic.

Text license: CC BY-SA 4.0 — the app shows a per-description attribution
link to the source article (js/descriptions.js).

Lookup keys mirror js/objnames.js normalizeName(); change one and you must
change the other.
"""

import collections
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

UA = 'ProjectPlanetariumDataRefresh/1.0 (+https://github.com/AlexJCurry42/Proj1)'
API = 'https://en.wikipedia.org/api/rest_v1/page/summary/'
ATTEMPT_BUDGET = 1000   # articles tried; misses (no article) simply drop out
MIN_EXTRACT = 60        # shorter than this is a stub, not a description
MAX_CHARS = 360         # two sentences, roughly — keeps the file compact
MIN_ARTICLES = 300      # validation gate: fewer means something broke
MAX_BYTES = 900_000     # validation gate: the file must stay bundle-sized

# Politeness: shared CI runner IPs get rate-limited fast (a first run at
# 8 unpaced threads drew ~60% errors). Low concurrency + a global pace of
# ~7 req/s keeps the whole harvest inside Wikimedia's comfort zone and
# still finishes 1,000 titles in ~3 minutes.
CONCURRENCY = 3
PACE_SECONDS = 0.15

_pace_lock = threading.Lock()
_pace_last = [0.0]


def pace():
    """Global request pacing across all worker threads."""
    with _pace_lock:
        wait = _pace_last[0] + PACE_SECONDS - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _pace_last[0] = time.monotonic()

# A wrong-topic hit (a common name that is also a place, a band, a ship…)
# won't read like astronomy; require at least one tell-tale term.
ASTRO_RE = re.compile(
    r'galax|nebul|cluster|star|supernov|remnant|light[- ]year|parsec|'
    r'milky way|constellation|ngc|messier|magellanic|interstellar', re.I)


def norm(s):
    """Mirror of js/objnames.js normalizeName()."""
    s = re.sub(r'\s+', ' ', str(s or '').lower()).strip()
    s = re.sub(r'^name\s+', '', s)
    s = re.sub(r'^v?\*\s+', '', s)
    s = re.sub(r'^messier\s*(?=\d)', 'm', s)
    s = re.sub(r'^m\s+(?=\d)', 'm', s)
    s = re.sub(r'^(ngc|ic)\s*(?=\d)', r'\1 ', s)
    return s


def two_sentences(text):
    """First two sentences of a lead extract, bounded by MAX_CHARS."""
    text = re.sub(r'\s+', ' ', text).strip()
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z0-9("\'])', text)
    picked = []
    for p in parts:
        if picked and len(' '.join(picked + [p])) > MAX_CHARS:
            break
        picked.append(p)
        if len(picked) == 2:
            break
    out = ' '.join(picked)
    return out if len(out) <= MAX_CHARS + 60 else out[:MAX_CHARS].rsplit(' ', 1)[0] + '…'


errors = 0
error_kinds = collections.Counter()  # HTTP code / exception class → count
errors_lock = threading.Lock()


def fetch_summary(title):
    """One REST summary with backoff; 404 = no article (normal, not an error).

    429/503 honor Retry-After; other failures back off and retry. Errors are
    counted BY KIND so a failed run's log says what actually went wrong."""
    global errors
    req = Request(API + quote(title.replace(' ', '_')),
                  headers={'User-Agent': UA, 'Accept': 'application/json'})
    kind = 'unknown'
    for attempt in range(1, 5):
        pace()
        try:
            with urlopen(req, timeout=25) as r:
                return json.load(r)
        except HTTPError as e:
            if e.code == 404:
                return None
            kind = f'http {e.code}'
            if attempt < 4:
                if e.code in (429, 503):
                    try:
                        time.sleep(min(30, float(e.headers.get('Retry-After') or 5)))
                    except ValueError:
                        time.sleep(5)
                else:
                    time.sleep(2 * attempt)
                continue
        except OSError as e:
            kind = type(e).__name__
            if attempt < 4:
                time.sleep(2 * attempt)
                continue
    with errors_lock:
        errors += 1
        error_kinds[kind] += 1
    return None


def resolve(cand):
    """(keys, titles) -> (keys, article title, trimmed text) or None."""
    keys, titles = cand
    for t in titles:
        s = fetch_summary(t)
        if not s or s.get('type') != 'standard':
            continue
        extract = (s.get('extract') or '').strip()
        if len(extract) < MIN_EXTRACT or not ASTRO_RE.search(extract):
            continue
        return keys, s.get('title') or t, two_sentences(extract)
    return None


def main():
    curated = json.load(open('data/messier_ngc.json'))
    ngc = json.load(open('data/ngc_full.json'))['objects']

    cands, seen = [], set()

    def add(keys, titles):
        keys = [norm(k) for k in keys if k]
        keys = list(dict.fromkeys(keys))  # dedupe, keep order
        if not keys or keys[0] in seen:
            return
        seen.add(keys[0])
        cands.append((keys, [t for t in titles if t]))

    # Every Messier object (the designation article redirects to the common
    # one where a common one exists, so one title suffices).
    for o in curated['messier']:
        num = int(o['id'][1:])
        add([o['id'], o.get('name')], [f'Messier {num}'])

    # Every curated NGC/IC showpiece (ids arrive space-less: "NGC104" —
    # article titles want the space).
    for o in curated['ngc_ic']:
        title = re.sub(r'^(NGC|IC)\s*', r'\1 ', o['id'])
        add([o['id'], o.get('name')],
            [title, o.get('name') if o.get('name') != o['id'] else None])

    # The full catalog: commonly-named entries first (a name is the strongest
    # predictor an article exists), then the brightest of the rest.
    named = [o for o in ngc if o[5]]
    unnamed = sorted((o for o in ngc if not o[5] and o[4] is not None), key=lambda o: o[4])
    for o in named + unnamed:
        if len(cands) >= ATTEMPT_BUDGET:
            break
        add([o[0], o[5]], [o[0], o[5]])

    print(f'attempting {len(cands)} candidates')
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = list(pool.map(resolve, cands))

    hits = [r for r in results if r]
    if error_kinds:
        print('error breakdown:', dict(error_kinds))
    assert errors <= len(cands) // 10, f'{errors} network errors out of {len(cands)} — aborting'
    assert len(hits) >= MIN_ARTICLES, f'only {len(hits)} descriptions resolved'

    # One article can serve several designations (M42 and NGC 1976 both land
    # on "Orion Nebula"): store each article once, point every key at it.
    articles, article_idx, index = [], {}, {}
    for keys, title, text in hits:
        i = article_idx.setdefault(title, len(articles))
        if i == len(articles):
            articles.append([title, text])
        for k in keys + [norm(title)]:
            index.setdefault(k, i)

    out = {
        '_comment': ('Two-sentence lead extracts from English Wikipedia for notable deep-sky objects, '
                     'trimmed by tools/fetch_descriptions.py. Text CC BY-SA 4.0 (attribution links '
                     'rendered in-app by js/descriptions.js). articles: [title, text]; index: '
                     'normalized name/designation -> articles offset (keys mirror js/objnames.js).'),
        'articles': articles,
        'index': index
    }
    path = 'data/descriptions.json'
    json.dump(out, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))

    size = os.path.getsize(path)
    assert size < MAX_BYTES, f'{size} bytes — too big to bundle'
    m31 = articles[index['m31']][1].lower()
    assert 'andromeda' in m31, f'M31 sanity check failed: {m31[:120]}'
    print(f'wrote {len(articles)} articles / {len(index)} keys, {size} bytes ({errors} soft errors)')


if __name__ == '__main__':
    sys.exit(main())
