// Schedules an explainer short on all three Instagram accounts. Copies each brand's video from a
// topic folder in ~/Desktop/Social Media Uploads/ (short - <Brand> Basics.mp4), takes that brand's
// "INSTAGRAM REELS" caption from "short - captions and tags.txt", converts short - cover.png to a
// JPEG cover, and adds the date to shorts/<brand>/schedule.json. A brand without a video (for
// example Vasopressors has no Medic version) is skipped. Commit and push afterwards; the workflow
// posts it with kind=short from noon Chicago on that date.
//
// For RN Basics it also writes youtube.json (title and description from the file's YOUTUBE SHORTS
// part), which scripts/youtube.mjs uploads to @TheRNBasics once the Instagram Reel has posted. A topic
// without a YouTube part gets no youtube.json and is not uploaded.
//
//   node scripts/add-short.mjs "<topic folder>" <YYYY-MM-DD> [slug]
//   SLOT=pm node scripts/add-short.mjs ...   # the afternoon series instead (shorts-pm/, posts from 3 PM Chicago)
//   SLOT=am node scripts/add-short.mjs ...   # the morning series (shorts-am/, posts from 7 AM Chicago)
//   YOUTUBE_ONLY=1 [SLOT=am] node scripts/add-short.mjs "<topic folder>" <slug>
//                                            # only (re)write youtube.json for a short scheduled earlier
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYouTube, checkYouTube } from './youtube-text.mjs';

const youtubeOnly = process.env.YOUTUBE_ONLY === '1';
const args = process.argv.slice(2);
const [folderArg, date, slugArg] = youtubeOnly ? [args[0], null, args[1]] : args;
const ROOT = { pm: 'shorts-pm', am: 'shorts-am' }[process.env.SLOT] ?? 'shorts';
if (!folderArg || (youtubeOnly ? !slugArg : !/^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))) {
  console.error('Usage: node scripts/add-short.mjs "<topic folder>" <YYYY-MM-DD> [slug]\n       YOUTUBE_ONLY=1 node scripts/add-short.mjs "<topic folder>" <slug>');
  process.exit(1);
}
const src = path.isAbsolute(folderArg) ? folderArg : path.join(process.env.HOME, 'Desktop/Social Media Uploads', folderArg);
const slug = slugArg || path.basename(src).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const text = fs.readFileSync(path.join(src, 'short - captions and tags.txt'), 'utf8');

/** Writes youtube.json next to the RN reel, or explains why not (a missing file means no YouTube upload). */
function writeYouTube(dest) {
  const yt = parseYouTube(text);
  if (!yt) { console.log('rn: no YOUTUBE SHORTS part in the captions file; it will not upload to YouTube'); return; }
  const problems = checkYouTube(yt);
  if (problems.length) { console.log(`rn: youtube.json NOT written (${problems.join('; ')}); fix the captions file and rerun with YOUTUBE_ONLY=1`); return; }
  fs.writeFileSync(path.join(dest, 'youtube.json'), JSON.stringify(yt, null, 2) + '\n');
  console.log(`rn: youtube.json → ${dest} (${yt.title})`);
}

if (youtubeOnly) {
  const dest = path.join(ROOT, 'rn', slug);
  if (!fs.existsSync(path.join(dest, 'reel.mp4'))) { console.error(`No scheduled RN short at ${dest}`); process.exit(1); }
  writeYouTube(dest);
  process.exit(0);
}

const BRANDS = { rn: 'RN', icu: 'ICU', medic: 'MEDIC' };
const NAMES = { rn: 'RN Basics', icu: 'ICU Basics', medic: 'Medic Basics' };

/** The Instagram caption inside one brand's section of the captions file. */
function caption(brand) {
  const sections = text.split(/^═+ (RN|ICU|MEDIC) BASICS ═+$/m);
  const i = sections.indexOf(BRANDS[brand]);
  if (i < 0) return null;
  const lines = sections[i + 1].split('\n');
  const start = lines.findIndex((l) => l.startsWith('INSTAGRAM REELS'));
  if (start < 0 || !lines[start + 1]?.startsWith('Caption:')) return null;
  const out = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.trim()) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

for (const brand of Object.keys(BRANDS)) {
  const video = path.join(src, `short - ${NAMES[brand]}.mp4`);
  if (!fs.existsSync(video)) { console.log(`${brand}: no video in ${src}; skipped`); continue; }
  const cap = caption(brand);
  if (!cap) { console.log(`${brand}: no INSTAGRAM REELS caption found; skipped`); continue; }
  const dest = path.join(ROOT, brand, slug);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(video, path.join(dest, 'reel.mp4'));
  fs.writeFileSync(path.join(dest, 'caption.txt'), cap + '\n');
  if (brand === 'rn') writeYouTube(dest);
  const cover = path.join(src, 'short - cover.png');
  if (fs.existsSync(cover)) {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', cover, '--out', path.join(dest, 'cover.jpg')], { stdio: 'ignore' });
  }
  const schedulePath = path.join(ROOT, brand, 'schedule.json');
  const schedule = fs.existsSync(schedulePath) ? JSON.parse(fs.readFileSync(schedulePath, 'utf8')) : {};
  schedule[date] = slug;
  const sorted = Object.fromEntries(Object.entries(schedule).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(schedulePath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`${brand}: ${date} → ${dest}`);
}
