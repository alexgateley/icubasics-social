// Uploads RN Basics explainer shorts to the @TheRNBasics YouTube channel as Shorts, after they have
// posted to Instagram. Basics has one YouTube channel and it always gets the RN version (Alex,
// 2026-10-28). A short qualifies when
//   - it is on today's (or yesterday's, so a failed upload retries) schedule in shorts/rn/ (noon) or
//     shorts-am/rn/ (7 AM),
//   - its Instagram marker published-rn/<date>-<kind>.json exists (the Reel went out),
//   - its folder has youtube.json (title and description, written by add-short.mjs),
//   - it is not in youtube-skip.json (the 23 uploads Alex hand-scheduled through Nov 27), and
//   - it has no marker in published-youtube/<slug>.json and no video with the same title on the channel.
// Uploads are public, Education category, not made for kids, and carry the altered or synthetic
// content disclosure (status.containsSyntheticMedia; the voice is synthetic).
//
//   node scripts/youtube.mjs          # upload whatever qualifies (the workflow runs this for RN)
//   node scripts/youtube.mjs check    # read-only: verify the OAuth credentials and show the channel
//   DRY_RUN=true node scripts/youtube.mjs   # list what would upload, without uploading
//
// Environment:
//   YT_CLIENT_ID, YT_CLIENT_SECRET   the Desktop OAuth client from Google Cloud (docs/youtube-setup.md)
//   YT_REFRESH_TOKEN                 made once by scripts/youtube-auth.mjs on Alex's Mac
//   POST_DATE                        optional YYYY-MM-DD instead of today (America/Chicago)
//   YT_LOOKBACK_DAYS                 how many days back to look, default 2 (today and yesterday)
//   DRY_RUN                          "true" to log only
import fs from 'node:fs';
import path from 'node:path';
import { checkYouTube } from './youtube-text.mjs';

const TZ = 'America/Chicago';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const SERIES = [
  { kind: 'morning', dir: 'shorts-am' },
  { kind: 'short', dir: 'shorts' },
];
const MARKERS = 'published-youtube';
const EDUCATION = '27';

const dryRun = process.env.DRY_RUN === 'true';
const forcedDate = process.env.POST_DATE || '';
const lookback = Math.max(1, Number(process.env.YT_LOOKBACK_DAYS || 2));
const creds = { id: process.env.YT_CLIENT_ID, secret: process.env.YT_CLIENT_SECRET, refresh: process.env.YT_REFRESH_TOKEN };
const haveCreds = Boolean(creds.id && creds.secret && creds.refresh);

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const minusDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

// The access token lives only in this process; the refresh token never leaves the request body
async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: creds.id, client_secret: creds.secret, refresh_token: creds.refresh, grant_type: 'refresh_token' }),
  });
  const json = await res.json();
  // invalid_grant means the refresh token was revoked or expired (a consent screen left in Testing
  // expires them after 7 days); rerun scripts/youtube-auth.mjs
  if (!res.ok || !json.access_token) throw new Error(`token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
  return json.access_token;
}

async function api(token, endpoint, params) {
  const res = await fetch(`${API}/${endpoint}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${endpoint}: ${JSON.stringify(json.error ?? json)}`);
  return json;
}

/** Titles of the channel's most recent uploads (scheduled and private ones included), lowercased. */
async function channelTitles(token) {
  const { items = [] } = await api(token, 'channels', { part: 'contentDetails,snippet', mine: 'true' });
  const uploads = items[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('no channel found for these credentials');
  const titles = new Set();
  let pageToken = '';
  for (let page = 0; page < 4; page++) {
    const list = await api(token, 'playlistItems', { part: 'snippet', playlistId: uploads, maxResults: '50', ...(pageToken && { pageToken }) });
    for (const it of list.items ?? []) titles.add(it.snippet.title.trim().toLowerCase());
    if (!(pageToken = list.nextPageToken)) break;
  }
  return { channel: items[0].snippet.title, titles };
}

/** Resumable upload: one request with the metadata, one with the video bytes. Returns the video id. */
async function upload(token, file, meta) {
  const bytes = fs.readFileSync(file);
  const body = {
    snippet: { title: meta.title, description: meta.description, categoryId: EDUCATION, defaultLanguage: 'en', defaultAudioLanguage: 'en' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true, embeddable: true },
  };
  const start = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(bytes.length),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
  });
  if (!start.ok) throw new Error(`upload start: ${start.status} ${await start.text()}`);
  const location = start.headers.get('location');
  if (!location) throw new Error('upload start: no upload URL returned');
  const put = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) }, body: bytes });
  const json = await put.json();
  if (!put.ok || !json.id) throw new Error(`upload: ${put.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

/** Today's (and recent days') RN shorts with what stands in the way of each. */
function candidates() {
  const skip = readJson('youtube-skip.json', { shorts: {} }).shorts ?? {};
  const end = forcedDate || today();
  const out = [];
  for (let n = 0; n < lookback; n++) {
    const date = minusDays(end, n);
    for (const { kind, dir } of SERIES) {
      const folder = readJson(path.join(dir, 'rn', 'schedule.json'), {})[date];
      if (!folder) continue;
      const brandDir = path.join(dir, 'rn', folder);
      const marker = path.join(MARKERS, `${folder}.json`);
      const c = { date, kind, folder, video: path.join(brandDir, 'reel.mp4'), marker, meta: readJson(path.join(brandDir, 'youtube.json'), null) };
      if (skip[folder]) c.skip = `Alex scheduled it on YouTube himself (${skip[folder].youtube}; youtube-skip.json)`;
      else if (fs.existsSync(marker)) c.skip = `already uploaded (${marker})`;
      else if (!c.meta) c.skip = `no youtube.json (run: YOUTUBE_ONLY=1${dir === 'shorts-am' ? ' SLOT=am' : ''} node scripts/add-short.mjs "<topic folder>" ${folder})`;
      else if (checkYouTube(c.meta).length) c.skip = `youtube.json has problems: ${checkYouTube(c.meta).join('; ')}`;
      else if (!fs.existsSync(c.video)) c.skip = `no ${c.video}`;
      else if (!fs.existsSync(path.join('published-rn', `${date}-${kind}.json`))) c.wait = 'waits until the Instagram Reel has posted';
      out.push(c);
    }
  }
  return out;
}

async function run() {
  if (!haveCreds && !dryRun) {
    console.log('::notice::YouTube credentials are not stored yet (docs/youtube-setup.md); skipping YouTube uploads');
    return;
  }
  const list = candidates();
  if (!list.length) { console.log(`No RN shorts scheduled in the last ${lookback} day(s).`); return; }
  let token = null;
  let existing = null;
  if (haveCreds) {
    token = await accessToken();
    existing = await channelTitles(token);
    console.log(`Channel: ${existing.channel} (${existing.titles.size} recent uploads checked for duplicate titles)`);
  }
  let failed = 0;
  for (const c of list) {
    const label = `${c.date} ${c.kind} ${c.folder}`;
    if (c.skip) { console.log(`${label}: skipped, ${c.skip}`); continue; }
    if (existing?.titles.has(c.meta.title.trim().toLowerCase())) {
      console.log(`${label}: skipped, a video titled "${c.meta.title}" is already on the channel`);
      continue;
    }
    if (c.wait && !dryRun) { console.log(`${label}: ${c.wait}`); continue; }
    console.log(`${label}: ${dryRun ? 'would upload' : 'uploading'} ${c.video}${c.wait ? ` (${c.wait})` : ''}\n  ${c.meta.title}`);
    if (dryRun) continue;
    try {
      const video = await upload(token, c.video, c.meta);
      fs.mkdirSync(MARKERS, { recursive: true });
      fs.writeFileSync(c.marker, JSON.stringify({ date: c.date, kind: c.kind, folder: c.folder, videoId: video.id, title: c.meta.title, privacy: video.status?.privacyStatus, uploadedAt: new Date().toISOString() }, null, 2) + '\n');
      // YouTube can still hold an upload private (creator account settings); say so instead of assuming public
      console.log(`  uploaded: https://youtube.com/shorts/${video.id} (${video.status?.privacyStatus ?? 'status unknown'})`);
    } catch (e) {
      console.error(`::error::${label}: ${e.message}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
}

async function check() {
  if (!haveCreds) fail('YT_CLIENT_ID, YT_CLIENT_SECRET and YT_REFRESH_TOKEN must be set');
  const token = await accessToken();
  const { items = [] } = await api(token, 'channels', { part: 'snippet,statistics', mine: 'true' });
  const ch = items[0];
  if (!ch) fail('the credentials work but no YouTube channel belongs to that Google account');
  console.log(`Credentials OK for ${ch.snippet.title} (${ch.snippet.customUrl ?? ch.id}); ${ch.statistics.videoCount} videos, ${ch.statistics.subscriberCount} subscribers`);
}

(process.argv[2] === 'check' ? check() : run()).catch((e) => fail(e.message));
