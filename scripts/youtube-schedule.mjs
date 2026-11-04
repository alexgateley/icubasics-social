// Schedules the @TheRNBasics YouTube uploads from the upload kits on Alex's Mac, one topic per day:
// the topic's long at 9:00 AM Pacific and its Shorts right after (9:05, 9:10, ...), each at the time
// in its upload.txt. Runs ONLY on the Mac (the videos live there, the repository is public); the
// credentials come from the login keychain (sh scripts/setup-youtube.sh, docs/youtube-setup.md).
//
//   node scripts/youtube-schedule.mjs --dry-run --all        # the plan: times in PT and UTC, quota
//   node scripts/youtube-schedule.mjs --all                  # upload and schedule every kit not uploaded yet
//   node scripts/youtube-schedule.mjs --day 2026-11-06       # one day folder only
//   node scripts/youtube-schedule.mjs reschedule <videoId> 2026-11-04T09:05 [--dry-run]   # Pacific time
//   node scripts/youtube-schedule.mjs reschedule-file "<CLAUDE TASK - Reschedule ....md>" [--dry-run]
//   node scripts/youtube-schedule.mjs check                  # read-only: credentials, scopes, channel
//
// Without stored credentials every mode is a dry run. Without --day or --all the upload mode is a
// dry run of every kit.
//
// Kits: "<YT_UPLOADS_DIR>/<YYYY-MM-DD Day - Topic>/<n> LONG|SHORT - <name>/" with the mp4 named on the
// upload.txt VIDEO FILE line, upload.txt (scripts/youtube-text.mjs reads it), and for a long
// thumbnail.png and captions.srt. Each new kit becomes:
//   videos.insert       private + status.publishAt (the upload.txt time, Pacific → UTC), Education (27),
//                       not made for kids, containsSyntheticMedia (the voice is synthetic), title,
//                       description and tags from upload.txt
//   thumbnails.set      longs (thumbnail.png)
//   captions.insert     longs (captions.srt, English, not a draft)
//   playlistItems.insert  each "Playlist suggestion" that already exists on the channel (none is created)
// The API cannot set a Short's Related video or pin a comment; the run ends with that list for Alex.
//
// Never twice: the state file (YT_STATE, default ~/basics-growth-work/youtube/uploaded.json) maps each
// kit path to its video id and the steps done, and a kit whose title is already on the channel is not
// uploaded. A failed step (thumbnail, captions, playlist) is retried on the next run without a new
// upload. A kit whose time is less than 15 minutes away or past is skipped and reported.
//
// Quota (checked against Google's quota table on 2026-11-03): videos.insert has its own bucket of 100
// calls a day; in the 10,000-unit daily pool thumbnails.set costs 50, captions.insert 400,
// playlistItems.insert 50, videos.update 50, and each list call 1. The run counts what it spends per
// Pacific day in the state file and stops before the pool passes YT_QUOTA_LIMIT (default 9,000).
//
// Environment (all optional): YT_UPLOADS_DIR, YT_STATE, YT_QUOTA_LIMIT, YT_NOW (an ISO time standing in
// for now, for testing), and YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN instead of the keychain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from './keychain.mjs';
import { parseUpload, weekdayOf } from './youtube-text.mjs';

const PT = 'America/Los_Angeles';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';
const EDUCATION = '27';
const UPLOADS_DIR = process.env.YT_UPLOADS_DIR || path.join(os.homedir(), 'Desktop/YouTube Uploads - TheRNBasics');
const STATE_FILE = process.env.YT_STATE || path.join(os.homedir(), 'basics-growth-work/youtube/uploaded.json');
const POOL_LIMIT = Number(process.env.YT_QUOTA_LIMIT || 9000);
const UPLOADS_PER_DAY = 100;
const COST = { insert: 1, thumbnail: 50, captions: 400, playlistItem: 50, update: 50, list: 1 };
const LEAD_MINUTES = 15;
export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const now = () => (process.env.YT_NOW ? new Date(process.env.YT_NOW) : new Date());
const norm = (s) => s.toLowerCase().replace(/\(long\)/g, '').replace(/#shorts/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- Pacific time ----------

/** Minutes the zone's wall clock is ahead of UTC at the instant ms (negative in the US). */
function offsetMinutes(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: PT, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000;
}

/** "2026-11-06", "09:00" Pacific → "2026-11-06T17:00:00Z" (standard or daylight time, whichever is in force then). */
export function ptToUtc(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ms = wall - offsetMinutes(wall) * 60000;
  ms = wall - offsetMinutes(ms) * 60000; // second pass when the first guess fell on the other side of a change
  const iso = new Date(ms).toISOString().replace('.000Z', 'Z');
  if (ptParts(iso).date !== date || ptParts(iso).time !== time) throw new Error(`${date} ${time} does not exist in Pacific time (clocks skip it)`);
  return iso;
}

const ptParts = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: PT, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
/** "Fri Nov 6, 9:00 AM PT" */
export const fmtPT = (iso) => `${new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/ at /, ', ')} ${offsetMinutes(Date.parse(iso)) === -420 ? 'PDT' : 'PST'}`;
const ptToday = () => ptParts(now().toISOString()).date;

// ---------- state and quota ----------

const state = readJson(STATE_FILE, null) ?? {
  note: 'Written by scripts/youtube-schedule.mjs: upload kit → YouTube video id, so nothing uploads twice. Delete an entry only after deleting that video on YouTube.',
  kits: {}, rescheduled: {}, quota: {},
};
state.kits ??= {};
state.rescheduled ??= {};
if (state.quota?.day !== ptToday()) state.quota = { day: ptToday(), pool: 0, uploads: 0 }; // the quota resets at midnight Pacific

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

// ---------- API ----------

const creds = {
  id: process.env.YT_CLIENT_ID || readSecret('YT_CLIENT_ID'),
  secret: process.env.YT_CLIENT_SECRET || readSecret('YT_CLIENT_SECRET'),
  refresh: process.env.YT_REFRESH_TOKEN || readSecret('YT_REFRESH_TOKEN'),
};
const haveCreds = Boolean(creds.id && creds.secret && creds.refresh);
let token = null;

// The access token lives only in this process (refreshed after 45 minutes; a long upload run can take longer)
async function accessToken() {
  if (token && Date.now() - token.at < 45 * 60000) return token.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: creds.id, client_secret: creds.secret, refresh_token: creds.refresh, grant_type: 'refresh_token' }),
  });
  const json = await res.json();
  // invalid_grant: the refresh token was revoked or expired; rerun sh scripts/setup-youtube.sh
  if (!res.ok || !json.access_token) throw new Error(`token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ''} (rerun sh scripts/setup-youtube.sh)`.trim());
  const missing = SCOPES.filter((s) => !(json.scope ?? '').split(' ').includes(s));
  if (missing.length) throw new Error(`the stored sign-in lacks ${missing.map((s) => s.split('/').pop()).join(', ')}; rerun sh scripts/setup-youtube.sh and tick every box`);
  token = { value: json.access_token, at: Date.now() };
  return token.value;
}

/** One API request. The quota is counted before the call (a failed call can cost quota too). */
async function call(cost, method, url, { params, json, body, headers = {} } = {}) {
  if (cost.bucket === 'uploads') state.quota.uploads += cost.units; else state.quota.pool += cost.units;
  saveState();
  const res = await fetch(params ? `${url}?${new URLSearchParams(params)}` : url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(json && { 'Content-Type': 'application/json; charset=UTF-8' }), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let out = {};
  try { out = text ? JSON.parse(text) : {}; } catch { out = { raw: text }; }
  if (!res.ok || out.error) {
    const e = out.error;
    throw new Error(`${method} ${url.replace(/^https:\/\/[^/]+/, '')}: ${res.status} ${e?.errors?.[0]?.reason ?? ''} ${e?.message ?? text.slice(0, 200)}`.replace(/\s+/g, ' ').trim());
  }
  return { json: out, res };
}
const pool = (units) => ({ bucket: 'pool', units });
const list = (endpoint, params) => call(pool(COST.list), 'GET', `${API}/${endpoint}`, { params }).then((r) => r.json);

async function myChannel() {
  const { items = [] } = await list('channels', { part: 'snippet,contentDetails,statistics', mine: 'true' });
  const ch = items[0];
  if (!ch) throw new Error('the credentials work but no YouTube channel belongs to that Google account');
  if (!/rn\s*basics/i.test(`${ch.snippet.title} ${ch.snippet.customUrl ?? ''}`)) throw new Error(`signed in to "${ch.snippet.title}", not @TheRNBasics; rerun sh scripts/setup-youtube.sh`);
  return ch;
}

/** Every upload on the channel (scheduled and private ones included, since the owner is asking): normalized title → id. */
async function channelTitles(ch) {
  const titles = new Map();
  let pageToken = '';
  do {
    const page = await list('playlistItems', { part: 'snippet', playlistId: ch.contentDetails.relatedPlaylists.uploads, maxResults: '50', ...(pageToken && { pageToken }) });
    for (const it of page.items ?? []) titles.set(norm(it.snippet.title), it.snippet.resourceId?.videoId ?? '');
    pageToken = page.nextPageToken;
  } while (pageToken);
  return titles;
}

/** The channel's own playlists: lowercased title → id. */
async function channelPlaylists() {
  const out = new Map();
  let pageToken = '';
  do {
    const page = await list('playlists', { part: 'snippet', mine: 'true', maxResults: '50', ...(pageToken && { pageToken }) });
    for (const p of page.items ?? []) out.set(p.snippet.title.trim().toLowerCase(), { id: p.id, title: p.snippet.title });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** A suggested playlist name → the channel's playlist, also matching without a trailing "(Shorts)"-style note. */
function findPlaylist(playlists, name) {
  const key = name.trim().toLowerCase();
  return playlists.get(key) ?? playlists.get(key.replace(/\s*\([^)]*\)\s*$/, '')) ?? null;
}

/** Resumable upload: one request with the metadata, one with the video bytes. Returns the video resource. */
async function insertVideo(kit) {
  const bytes = fs.readFileSync(kit.video);
  const meta = {
    snippet: { title: kit.title, description: kit.description, tags: kit.tags, categoryId: EDUCATION, defaultLanguage: 'en', defaultAudioLanguage: 'en' },
    status: { privacyStatus: 'private', publishAt: kit.publishAt, selfDeclaredMadeForKids: false, containsSyntheticMedia: true, embeddable: true },
  };
  const { res } = await call({ bucket: 'uploads', units: COST.insert }, 'POST', `${UPLOAD_API}/videos`, {
    params: { uploadType: 'resumable', part: 'snippet,status' },
    json: meta,
    headers: { 'X-Upload-Content-Length': String(bytes.length), 'X-Upload-Content-Type': 'video/mp4' },
  });
  const location = res.headers.get('location');
  if (!location) throw new Error('upload start: no upload URL returned');
  const put = await fetch(location, { method: 'PUT', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) }, body: bytes });
  const json = await put.json().catch(() => ({}));
  if (!put.ok || !json.id) throw new Error(`upload: ${put.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json;
}

const setThumbnail = (videoId, file) => call(pool(COST.thumbnail), 'POST', `${UPLOAD_API}/thumbnails/set`, {
  params: { videoId, uploadType: 'media' }, body: fs.readFileSync(file), headers: { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' },
});

/** captions.insert as a multipart upload: the snippet as JSON, then the .srt file. */
async function insertCaptions(videoId, file) {
  const boundary = `basics${Date.now().toString(36)}`;
  const snippet = { snippet: { videoId, language: 'en', name: 'English', isDraft: false } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(snippet)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fs.readFileSync(file),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { json } = await call(pool(COST.captions), 'POST', `${UPLOAD_API}/captions`, {
    params: { uploadType: 'multipart', part: 'snippet' }, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
  return json.id;
}

const addToPlaylist = (playlistId, videoId) => call(pool(COST.playlistItem), 'POST', `${API}/playlistItems`, {
  params: { part: 'snippet' }, json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
}).then((r) => r.json.id);

// ---------- kits ----------

/** Every kit in the uploads folder, in day and folder order, with what is wrong with it (problems[]). */
function readKits() {
  if (!fs.existsSync(UPLOADS_DIR)) fail(`no folder ${UPLOADS_DIR}`);
  const kits = [];
  const days = fs.readdirSync(UPLOADS_DIR).filter((d) => /^\d{4}-\d{2}-\d{2} \w{3} - .+/.test(d) && fs.statSync(path.join(UPLOADS_DIR, d)).isDirectory()).sort();
  for (const day of days) {
    const date = day.slice(0, 10);
    const topic = day.replace(/^\S+ \w{3} - /, '');
    const folders = fs.readdirSync(path.join(UPLOADS_DIR, day)).map((f) => [f, f.match(/^(\d+) (LONG|SHORT) - (.+)$/)]).filter(([, m]) => m).sort((a, b) => a[1][1] - b[1][1]);
    for (const [folder, m] of folders) {
      const dir = path.join(UPLOADS_DIR, day, folder);
      const key = `${day}/${folder}`;
      const kit = { key, day, date, topic, n: Number(m[1]), type: m[2], name: m[3], dir, problems: [] };
      const txt = path.join(dir, 'upload.txt');
      if (!fs.existsSync(txt)) { kit.problems.push('no upload.txt'); kits.push(kit); continue; }
      Object.assign(kit, parseUpload(fs.readFileSync(txt, 'utf8')));
      kit.problems = [...kit.problems];
      if (kit.schedule) {
        if (kit.schedule.date !== date) kit.problems.push(`SCHEDULE date ${kit.schedule.date} is not the day folder's date ${date}`);
        if (weekdayOf(date).slice(0, 3) !== day.slice(11, 14).toLowerCase()) kit.problems.push(`${date} is a ${weekdayOf(date)}, the folder says ${day.slice(11, 14)}`);
        try { kit.publishAt = ptToUtc(kit.schedule.date, kit.schedule.time); } catch (e) { kit.problems.push(e.message); }
      }
      kit.video = path.join(dir, kit.videoFile || 'missing.mp4');
      if (!fs.existsSync(kit.video)) kit.problems.push(`no video file ${kit.videoFile}`);
      if (kit.type === 'LONG') {
        kit.thumbnail = path.join(dir, 'thumbnail.png');
        kit.captions = path.join(dir, 'captions.srt');
        if (!fs.existsSync(kit.thumbnail)) kit.problems.push('no thumbnail.png');
        else if (fs.statSync(kit.thumbnail).size > 2 * 1024 * 1024) kit.problems.push('thumbnail.png is over 2 MB (YouTube custom thumbnail limit)');
        if (!fs.existsSync(kit.captions)) kit.problems.push('no captions.srt');
      }
      kits.push(kit);
    }
  }
  return kits;
}

/** Pool units a kit still needs (thumbnail, captions, playlists not done yet). */
function kitCost(kit, entry, playlistCount) {
  let units = 0;
  if (kit.type === 'LONG' && !entry?.thumbnail) units += COST.thumbnail;
  if (kit.type === 'LONG' && !entry?.captions) units += COST.captions;
  units += Math.max(0, playlistCount - (entry?.playlists?.length ?? 0)) * COST.playlistItem;
  return units;
}

function printFollowUps(kits) {
  const byDay = new Map();
  for (const k of kits.filter((k) => k.type === 'SHORT' && k.related)) {
    const long = kits.find((l) => l.day === k.day && l.type === 'LONG' && norm(l.title) === norm(k.related));
    const when = long ? `after ${fmtPT(long.publishAt)} (when the long is public)` : /already public/i.test(k.relatedNote) ? 'any time (the long is already public)' : 'when the long is public';
    const id = state.kits[k.key]?.videoId;
    if (!byDay.has(k.date)) byDay.set(k.date, []);
    byDay.get(k.date).push(`  ${when}: ${id ? `https://youtube.com/shorts/${id}` : `"${k.title}"`}\n      → Related video: ${k.related}`);
  }
  if (byDay.size) {
    console.log('\nRelated video, by hand (the API cannot set it): YouTube Studio > Content > Shorts > the Short > Related video');
    for (const [date, lines] of byDay) console.log(`${date}\n${lines.join('\n')}`);
  }
  const pins = kits.filter((k) => k.pinnedComment);
  if (pins.length) {
    console.log('\nPinned "Sources and corrections" comment, by hand (the API cannot pin): from upload.txt once each long is public');
    for (const k of pins) console.log(`  ${fmtPT(k.publishAt ?? now().toISOString())}: ${state.kits[k.key]?.videoId ? `https://youtu.be/${state.kits[k.key].videoId}` : k.title}`);
  }
}

// ---------- modes ----------

async function upload({ day, all, dryRun }) {
  const kits = readKits().filter((k) => !day || k.date === day);
  if (!kits.length) fail(day ? `no day folder for ${day} in ${UPLOADS_DIR}` : `no kits in ${UPLOADS_DIR}`);
  const live = haveCreds && !dryRun && (day || all);
  if (!haveCreds) console.log('No YouTube credentials in the keychain (docs/youtube-setup.md): dry run.');
  else if (!live) console.log(`Dry run${!(day || all) ? ' (give --day or --all to upload)' : ''}.`);
  console.log(`Kits: ${UPLOADS_DIR}\nState: ${STATE_FILE}\nQuota used today (Pacific ${state.quota.day}): ${state.quota.pool} of ${POOL_LIMIT} pool units, ${state.quota.uploads} of ${UPLOADS_PER_DAY} uploads\n`);

  let ch = null;
  let titles = null;
  let playlists = null;
  if (haveCreds) {
    ch = await myChannel();
    titles = await channelTitles(ch);
    playlists = await channelPlaylists();
    console.log(`Channel: ${ch.snippet.title} (${ch.id}), ${titles.size} uploads checked for identical titles, ${playlists.size} playlists\n`);
  }

  const soon = now().getTime() + LEAD_MINUTES * 60000;
  const tally = { upload: 0, long: 0, short: 0, pool: 0, done: 0, already: 0, past: [], dup: [], problem: [], failed: 0, stopped: [] };
  let lastDay = '';
  for (const kit of kits) {
    if (kit.day !== lastDay) { console.log(`${kit.day}`); lastDay = kit.day; }
    const entry = state.kits[kit.key];
    const label = `  ${kit.n} ${kit.type.padEnd(5)} ${kit.publishAt ? `${fmtPT(kit.publishAt)} = ${kit.publishAt}` : '(no time)'}`;
    const say = (msg) => console.log(`${label}  ${msg}\n           ${kit.title || kit.name}`);
    if (kit.problems.length) { say(`PROBLEM, not uploaded: ${kit.problems.join('; ')}`); tally.problem.push(kit.key); continue; }

    const found = playlists ? kit.playlists.map((p) => [p, findPlaylist(playlists, p)]) : kit.playlists.map((p) => [p, { id: '?', title: p }]);
    const lists = found.filter(([, p]) => p);
    const listNote = `playlists: ${found.map(([name, p]) => (p ? p.title : `${name} (not on the channel; not created)`)).join(', ') || 'none'}`;
    const cost = kitCost(kit, entry, lists.length);

    if (entry?.videoId && cost === 0) { say(`already uploaded: ${entry.videoId}`); tally.already++; continue; }
    if (!entry?.videoId) {
      const dupId = titles?.get(norm(kit.title));
      if (dupId !== undefined) { say(`SKIPPED: a video with this title is already on the channel (${dupId || 'id unknown'}); not in the state file, so check it by hand`); tally.dup.push(kit.key); continue; }
      if (Date.parse(kit.publishAt) < soon) { say(`SKIPPED: the publish time is past or under ${LEAD_MINUTES} minutes away`); tally.past.push(kit.key); continue; }
    }
    const needsUpload = !entry?.videoId;
    // Once one kit does not fit, the rest wait too, so the uploads stay in day order
    // A live run's spending is already in state.quota; a dry run adds up what it would spend
    const [poolSoFar, uploadsSoFar] = live ? [state.quota.pool, state.quota.uploads] : [state.quota.pool + tally.pool, state.quota.uploads + tally.upload];
    if (tally.stopped.length || poolSoFar + cost > POOL_LIMIT || (needsUpload && uploadsSoFar + 1 > UPLOADS_PER_DAY)) {
      tally.stopped.push(kit.key);
      say('NOT THIS RUN: it would pass the daily quota; run again after midnight Pacific');
      continue;
    }
    const steps = [needsUpload && 'videos.insert', kit.type === 'LONG' && !entry?.thumbnail && 'thumbnails.set', kit.type === 'LONG' && !entry?.captions && 'captions.insert',
      ...lists.filter(([, p]) => !entry?.playlists?.includes(p.id)).map(([, p]) => `playlist "${p.title}"`)].filter(Boolean);
    tally.pool += cost;
    if (needsUpload) { tally.upload++; tally[kit.type === 'LONG' ? 'long' : 'short']++; }
    if (!live) { say(`${needsUpload ? 'would upload' : `would finish ${entry.videoId}`}: ${steps.join(', ')}\n           ${listNote}`); continue; }

    say(`${needsUpload ? 'uploading' : `finishing ${entry.videoId}`}: ${steps.join(', ')}`);
    try {
      let e = entry;
      if (needsUpload) {
        const v = await insertVideo(kit);
        e = state.kits[kit.key] = { videoId: v.id, title: kit.title, type: kit.type, topic: kit.topic, publishAt: kit.publishAt, uploadedAt: now().toISOString(), playlists: [] };
        saveState();
        const got = v.status ?? {};
        console.log(`           uploaded ${v.id}: ${got.privacyStatus ?? 'status unknown'}, publishAt ${got.publishAt ?? 'NOT SET'}`);
        if (got.privacyStatus !== 'private' || !got.publishAt) console.log(`           WARNING: YouTube did not keep it private and scheduled; check https://studio.youtube.com/video/${v.id}/edit`);
      }
      if (kit.type === 'LONG' && !e.thumbnail) { await setThumbnail(e.videoId, kit.thumbnail); e.thumbnail = true; saveState(); console.log('           thumbnail set'); }
      if (kit.type === 'LONG' && !e.captions) { e.captions = await insertCaptions(e.videoId, kit.captions); saveState(); console.log('           captions uploaded (English)'); }
      e.playlists ??= [];
      for (const [, p] of lists) {
        if (e.playlists.includes(p.id)) continue;
        await addToPlaylist(p.id, e.videoId);
        e.playlists.push(p.id);
        saveState();
        console.log(`           added to playlist ${p.title}`);
      }
      tally.done++;
    } catch (err) {
      tally.failed++;
      console.error(`           FAILED: ${err.message}${state.kits[kit.key] ? ' (the upload is recorded; the next run finishes the remaining steps without uploading again)' : ''}`);
    }
  }

  console.log(`\n${live ? 'Done' : 'Plan'}: ${tally.upload} new upload(s) (${tally.long} long, ${tally.short} Shorts) of ${kits.length} kit(s)` +
    `${live ? `; ${tally.done} kit(s) completed this run` : ''}${tally.failed ? `; ${tally.failed} FAILED` : ''}${tally.already ? `; ${tally.already} already uploaded` : ''}`);
  console.log(`Quota: ${tally.upload} of the ${UPLOADS_PER_DAY} daily uploads (own bucket, 1 unit each), and about ${tally.pool} pool units` +
    ` (thumbnails ${COST.thumbnail}, captions ${COST.captions}, playlist adds ${COST.playlistItem} each${playlists ? '' : ', assuming every suggested playlist exists'}) plus a few units of list calls;` +
    ` limit ${POOL_LIMIT} of 10,000 per Pacific day${live ? `; used today: ${state.quota.pool} pool, ${state.quota.uploads} uploads` : ''}`);
  if (tally.past.length) console.log(`Skipped, time already past (${tally.past.length}): ${tally.past.join(' | ')}`);
  if (tally.dup.length) console.log(`Skipped, title already on the channel (${tally.dup.length}): ${tally.dup.join(' | ')}`);
  if (tally.problem.length) console.log(`Not uploaded, problems in the kit (${tally.problem.length}): ${tally.problem.join(' | ')}`);
  if (tally.stopped.length) console.log(`Left for the next run, quota (${tally.stopped.length}): ${tally.stopped.join(' | ')}`);
  printFollowUps(kits);
  if (tally.failed) process.exit(1);
}

/** "2026-11-04T09:05" (Pacific) → UTC ISO */
function parsePtArg(s) {
  const m = (s ?? '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (!m) fail(`expected a Pacific time like 2026-11-04T09:05, got "${s ?? ''}"`);
  return ptToUtc(m[1], `${m[2].padStart(2, '0')}:${m[3]}`);
}

/** Moves already-scheduled videos: [{ id, label, publishAt }]. Skips public, unscheduled, missing or mismatched ones. */
async function reschedule(moves, { dryRun }) {
  const live = haveCreds && !dryRun;
  if (!haveCreds) console.log('No YouTube credentials in the keychain (docs/youtube-setup.md): dry run, nothing is checked on YouTube.');
  else if (!live) console.log('Dry run: reading each video, changing nothing.');
  const cost = moves.length * (COST.list + COST.update);
  console.log(`${moves.length} move(s); quota at most ${cost} pool units (videos.list ${COST.list} + videos.update ${COST.update} each). Used today: ${state.quota.pool} of ${POOL_LIMIT}.\n`);
  if (haveCreds) { const ch = await myChannel(); console.log(`Channel: ${ch.snippet.title} (${ch.id})\n`); }
  const soon = now().getTime() + LEAD_MINUTES * 60000;
  const results = [];
  let failed = 0;
  for (const mv of moves) {
    const head = `${mv.n ? `${String(mv.n).padStart(2)}. ` : ''}${mv.id}  → ${fmtPT(mv.publishAt)} = ${mv.publishAt}`;
    const done = (outcome) => { console.log(`${head}  ${outcome}${mv.label ? `\n      ${mv.label}` : ''}`); results.push({ ...mv, outcome }); };
    if (Date.parse(mv.publishAt) < soon) { done('SKIPPED: the new time is past or under 15 minutes away'); continue; }
    if (!haveCreds) { done('would move'); continue; }
    if (state.quota.pool + COST.list + COST.update > POOL_LIMIT) { done('NOT THIS RUN: daily quota'); continue; }
    try {
      const v = (await list('videos', { part: 'snippet,status', id: mv.id })).items?.[0];
      if (!v) { done('SKIPPED: not found on the channel'); continue; }
      const s = v.status;
      const from = s.publishAt ? fmtPT(s.publishAt) : s.privacyStatus;
      if (mv.label && !norm(v.snippet.title).includes(norm(mv.label)) && !norm(mv.label).includes(norm(v.snippet.title))) { done(`SKIPPED: the title on YouTube is "${v.snippet.title}"`); continue; }
      if (s.privacyStatus !== 'private' || !s.publishAt) { done(`SKIPPED: ${s.privacyStatus === 'public' ? 'already public' : `${s.privacyStatus} and not scheduled`}`); continue; }
      if (Date.parse(s.publishAt) === Date.parse(mv.publishAt)) { done(`already at ${from}`); continue; }
      if (!live) { done(`would move from ${from}`); continue; }
      // Only the status part is sent, so the title, description and the rest stay as they are. Every writable
      // status field is sent back unchanged (an omitted one would be cleared), with the new publishAt.
      const keep = Object.fromEntries(['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'].filter((k) => k in s).map((k) => [k, s[k]]));
      const { json } = await call(pool(COST.update), 'PUT', `${API}/videos`, { params: { part: 'status' }, json: { id: mv.id, status: { ...keep, privacyStatus: 'private', publishAt: mv.publishAt } } });
      const now2 = json.status?.publishAt;
      if (Date.parse(now2) !== Date.parse(mv.publishAt)) throw new Error(`YouTube answered with publishAt ${now2 ?? 'none'}`);
      state.rescheduled[mv.id] = { from: s.publishAt, to: mv.publishAt, title: v.snippet.title, at: now().toISOString() };
      saveState();
      done(`moved from ${from}; YouTube now shows ${fmtPT(now2)}`);
    } catch (err) {
      failed++;
      done(`FAILED: ${err.message}`);
    }
  }
  if (failed) process.exit(1);
  return results;
}

/**
 * The 17 moves from "CLAUDE TASK - Reschedule existing YouTube videos.md": the table with a "Link" and a
 * "Move to" column ("Wed Nov 4, 9:05 AM", Pacific; the year is the one whose date falls on that weekday,
 * this year or next).
 */
export function parseRescheduleFile(text, today = ptToday()) {
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|')).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/\*\*/g, '').trim()));
  const header = rows.findIndex((r) => r.some((c) => /^link$/i.test(c)) && r.some((c) => /^move to/i.test(c)));
  if (header < 0) throw new Error('no table with "Link" and "Move to" columns');
  const col = (re) => rows[header].findIndex((c) => re.test(c));
  const [cN, cVideo, cLink, cTo] = [col(/^#$/), col(/^video$/i), col(/^link$/i), col(/^move to/i)];
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const moves = [];
  for (const r of rows.slice(header + 1)) {
    if (r.every((c) => /^:?-+:?$/.test(c))) continue;
    if (r.length < rows[header].length) continue;
    const id = r[cLink].match(/(?:shorts\/|youtu\.be\/|[?&]v=|video\/)([\w-]{11})/)?.[1];
    const t = r[cTo].match(/(\w{3})\w*,?\s+(\w{3})\w*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!id || !t) throw new Error(`cannot read the row: | ${r.join(' | ')} |`);
    const month = months.indexOf(t[2].toLowerCase()) + 1;
    let hour = Number(t[4]) % 12;
    if (t[6].toUpperCase() === 'PM') hour += 12;
    const pad = (n) => String(n).padStart(2, '0');
    const thisYear = Number(today.slice(0, 4));
    const date = [thisYear, thisYear + 1].map((y) => `${y}-${pad(month)}-${pad(t[3])}`).find((d) => weekdayOf(d).startsWith(t[1].toLowerCase()));
    if (!date) throw new Error(`"${r[cTo]}": ${t[2]} ${t[3]} is not a ${t[1]} this year or next`);
    moves.push({ n: cN >= 0 ? Number(r[cN]) || undefined : undefined, id, label: cVideo >= 0 ? r[cVideo] : '', publishAt: ptToUtc(date, `${pad(hour)}:${t[5]}`) });
  }
  if (!moves.length) throw new Error('the table has no rows');
  return moves;
}

async function check() {
  if (!haveCreds) fail('YT_CLIENT_ID, YT_CLIENT_SECRET and YT_REFRESH_TOKEN are not in the keychain; run sh scripts/setup-youtube.sh');
  const ch = await myChannel();
  console.log(`Credentials OK for ${ch.snippet.title} (${ch.snippet.customUrl ?? ch.id}); all ${SCOPES.length} permissions granted; ${ch.statistics.videoCount} videos, ${ch.statistics.subscriberCount} subscribers`);
}

// ---------- command line ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  const run = async () => {
    if (rest[0] === 'check') return check();
    if (rest[0] === 'reschedule') {
      if (!/^[\w-]{11}$/.test(rest[1] ?? '')) fail('usage: node scripts/youtube-schedule.mjs reschedule <videoId> <YYYY-MM-DDTHH:MM> [PT] [--dry-run]');
      const time = rest.slice(2).filter((a) => !/^P[SD]?T$/i.test(a)).join(' ').replace(/\s*P[SD]?T$/i, '');
      return reschedule([{ id: rest[1], label: '', publishAt: parsePtArg(time) }], { dryRun });
    }
    if (rest[0] === 'reschedule-file') {
      if (!rest[1]) fail('usage: node scripts/youtube-schedule.mjs reschedule-file "<file.md>" [--dry-run]');
      return reschedule(parseRescheduleFile(fs.readFileSync(rest[1], 'utf8')), { dryRun });
    }
    const dayAt = rest.indexOf('--day');
    const day = dayAt >= 0 ? rest[dayAt + 1] : '';
    if (dayAt >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) fail('--day needs a date like 2026-11-06');
    const unknown = rest.filter((a, i) => !['--all', '--day'].includes(a) && !(dayAt >= 0 && i === dayAt + 1));
    if (unknown.length) fail(`unknown argument(s): ${unknown.join(' ')} (see the top of scripts/youtube-schedule.mjs)`);
    return upload({ day, all: rest.includes('--all'), dryRun });
  };
  run().catch((e) => fail(e.message));
}
