#!/usr/bin/env python3
"""Stage Reels whose video lives in alexgateley/basics-social-videos (Pages) instead of this repo.

  python3 scripts/stage-hosted.py <brand> <rows.tsv> <start YYYY-MM-DD> <days> [--paused] [--skip-first N]

rows.tsv: tab-separated with a header containing brand, topic (or topic_folder), mp4 (upload_mp4 or mp4_path),
cover (cover_jpg or cover_path), caption (optional: else read from the topic folder's captions file by add-short
rules is NOT done here; rows without caption are skipped) and optional keyword (keyword_suggestion).
Each date gets a noon post (shorts/) and an 8 PM post (features/). Rows already staged (same slug in either dir)
are skipped. Copies <slug>.mp4 into ../basics-social-videos/<brand>/ and writes, here, <dir>/<brand>/<slug>/
caption.txt, video_url.txt and cover.jpg (if any). With --paused the dates go into schedule.paused.json.
Keywords from the rows are added to comment-keywords.json "slugs" when the slug has none.
Commit and push BOTH repos afterwards (videos first, so the URLs resolve before the post time).
"""
import csv, datetime as dt, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIDEOS = os.path.join(os.path.dirname(HERE), 'basics-social-videos')
BASE = 'https://alexgateley.github.io/basics-social-videos'

args = sys.argv[1:]
paused = '--paused' in args
skip = 0
if '--skip-first' in args:
    skip = int(args[args.index('--skip-first') + 1])
brand, rows_path, start, days = args[0], args[1], args[2], int(args[3])

def col(r, *names):
    for n in names:
        if r.get(n):
            return r[n]
    return ''

def slugify(topic):
    t = re.sub(r'^(RT|ER|Oxygen|CEN|Trauma|EKG|Labs|Pharm|NP)\s*-\s*', '', topic, flags=re.I)
    return re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')

rows = [r for r in csv.DictReader(open(rows_path), delimiter='\t') if r.get('brand') == brand]
rows = rows[skip:]
os.chdir(HERE)
sched_name = 'schedule.paused.json' if paused else 'schedule.json'
scheds = {}
for d in ('shorts', 'features'):
    p = f'{d}/{brand}/{sched_name}'
    scheds[d] = json.load(open(p)) if os.path.exists(p) else {}
staged = {f for d in ('shorts', 'features') for f in os.listdir(f'{d}/{brand}') if os.path.isdir(f'{d}/{brand}/{f}')}
kw = json.load(open('comment-keywords.json'))
os.makedirs(f'{VIDEOS}/{brand}', exist_ok=True)

queue = []
for r in rows:
    slug = slugify(col(r, 'topic', 'topic_folder'))
    mp4 = col(r, 'upload_mp4', 'mp4_path', 'mp4')
    cap = col(r, 'caption').replace('\\n', '\n').strip()
    if not slug or slug in staged or not mp4 or not os.path.exists(mp4) or not cap:
        continue
    queue.append((slug, mp4, col(r, 'cover_jpg', 'cover_path', 'cover'), cap, col(r, 'keyword_suggestion', 'keyword')))

day = dt.date.fromisoformat(start)
made = []
for i in range(days):
    ds = (day + dt.timedelta(days=i)).isoformat()
    for d in ('shorts', 'features'):
        if ds in scheds[d] or not queue:
            continue
        slug, mp4, cover, cap, keyword = queue.pop(0)
        folder = f'{d}/{brand}/{slug}'
        os.makedirs(folder, exist_ok=True)
        shutil.copy(mp4, f'{VIDEOS}/{brand}/{slug}.mp4')
        open(f'{folder}/caption.txt', 'w').write(cap + '\n')
        open(f'{folder}/video_url.txt', 'w').write(f'{BASE}/{brand}/{slug}.mp4\n')
        if cover and os.path.exists(cover):
            shutil.copy(cover, f'{folder}/cover.jpg')
        scheds[d][ds] = slug
        if keyword and keyword.upper() in kw['keywords'] and slug not in kw['slugs']:
            kw['slugs'][slug] = keyword.upper()
        made.append((ds, d, slug))
for d, s in scheds.items():
    p = f'{d}/{brand}/{sched_name}'
    open(p, 'w').write(json.dumps(dict(sorted(s.items())), indent=2) + '\n')
open('comment-keywords.json', 'w').write(json.dumps(kw, indent=2, ensure_ascii=False) + '\n')
for m in made:
    print(*m)
print(f'{brand}: staged {len(made)}, {len(queue)} left in rows', '(paused schedule)' if paused else '')
