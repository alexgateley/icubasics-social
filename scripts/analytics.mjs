// Nightly analytics for the three Instagram accounts and the @TheRNBasics YouTube channel. Runs ONLY on
// Alex's Mac (launchd/com.icubasics.analytics.plist, 2 AM Pacific): insights are private and this
// repository is public, so nothing here writes into the repository. Credentials come from the login
// keychain (scripts/setup-keychain.sh, scripts/setup-youtube.sh); every API call is a read.
//
//   node scripts/analytics.mjs             # fetch tonight's numbers, then rebuild the dashboard
//   node scripts/analytics.mjs fetch       # fetch only
//   node scripts/analytics.mjs dashboard   # rebuild dashboard.html from what is stored
//   FIXTURES=1 ANALYTICS_DIR=/tmp/x node scripts/analytics.mjs   # made-up data, no network (testing)
//
// Store (ANALYTICS_DIR, default ~/basics-growth-work/analytics/):
//   accounts.jsonl   one line per account per night: followers (Instagram followers_count, YouTube subscriberCount)
//   media.jsonl      one line per Reel or video per night with its lifetime totals
//   media-meta.json  per Reel or video: account, posted time, title, permalink, topic, slot
//   state.json       when each keychain Instagram token was last refreshed (no secrets)
//   dashboard.html   static page built from the above
//
// Metric names checked against the docs on 2026-11-03:
//   Instagram media insights (graph.instagram.com, Instagram API with Instagram Login, needs
//   instagram_business_manage_insights): views, reach, saved, shares, likes, comments,
//   total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time (both in milliseconds).
//   plays, clips_replays_count, ig_reels_aggregated_all_plays_count and impressions were removed
//   April 21, 2025, video_views January 8, 2025. Insights can lag up to 48 hours and are kept 2 years.
//   YouTube Analytics v2 reports, dimension video (needs maxResults ≤ 200 and a sort): views,
//   estimatedMinutesWatched, averageViewDuration (seconds), likes, subscribersGained. These lag 2-3 days.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSecret, writeSecret } from './keychain.mjs';

const TZ = 'America/Chicago';
const GRAPH = 'https://graph.instagram.com/v25.0';
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.ANALYTICS_DIR || path.join(os.homedir(), 'basics-growth-work/analytics');
const fixtures = process.env.FIXTURES === '1';
// Reels older than this keep their last stored numbers instead of being fetched every night
const INSIGHTS_DAYS = Number(process.env.INSIGHTS_DAYS || 120);
const REFRESH_DAYS = 7;

const IG_ACCOUNTS = [
  { account: 'icu', label: '@icubasics', suffix: '' },
  { account: 'rn', label: '@rnbasicsnclex', suffix: '_RN' },
  { account: 'medic', label: '@themedicbasics', suffix: '_MEDIC' },
];
const IG_METRICS = ['views', 'reach', 'saved', 'shares', 'likes', 'comments', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
const YT_METRICS = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'likes', 'subscribersGained'];
const SLOTS = { reel: '7 AM', morning: '7 AM', short: 'noon', afternoon: '3 PM', feature: '6 PM', recap: 'recap' };

const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const file = (name) => path.join(DIR, name);
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const chicagoHour = (iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date(iso))) % 24;
// Errors can echo request URLs, which carry the Instagram token; strip anything token-like before logging
const scrub = (s) => String(s).replace(/access_token=[^&\s"]+/g, 'access_token=…').replace(/\b(IG|EA)[A-Za-z0-9_-]{40,}/g, '…');

// ---------- Instagram ----------

async function ig(token, endpoint, params = {}) {
  const url = endpoint.startsWith('https://') ? new URL(endpoint) : new URL(`${GRAPH}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${endpoint.split('?')[0].replace(GRAPH, '')}: ${json.error?.message ?? res.status}`);
  return json;
}

/** Refreshes the keychain copy of a long-lived token once a week so it never reaches its 60 days. */
async function maybeRefresh(acct, token, state) {
  const last = state.igRefreshedAt?.[acct.account];
  if (last && Date.now() - Date.parse(last) < REFRESH_DAYS * 86400000) return token;
  try {
    const json = await ig(token, 'refresh_access_token', { grant_type: 'ig_refresh_token' });
    writeSecret(`IG_ACCESS_TOKEN${acct.suffix}`, json.access_token);
    (state.igRefreshedAt ??= {})[acct.account] = new Date().toISOString();
    log(`${acct.label}: keychain token refreshed (${Math.round(json.expires_in / 86400)} days)`);
    return json.access_token;
  } catch (e) {
    // A token under 24 hours old cannot be refreshed yet; keep using it
    log(`${acct.label}: token not refreshed (${scrub(e.message)})`);
    return token;
  }
}

/** One Reel's insights; if the combined request fails, asks metric by metric so one bad name costs only itself. */
async function reelInsights(token, id) {
  const read = (data) => Object.fromEntries((data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? null]));
  try {
    return { metrics: read((await ig(token, `${id}/insights`, { metric: IG_METRICS.join(',') })).data), errors: [] };
  } catch {
    const metrics = {};
    const errors = [];
    for (const m of IG_METRICS) {
      try { Object.assign(metrics, read((await ig(token, `${id}/insights`, { metric: m })).data)); } catch (e) { errors.push(`${m}: ${scrub(e.message)}`); }
    }
    return { metrics, errors };
  }
}

async function fetchInstagram(acct, state) {
  const userId = readSecret(`IG_USER_ID${acct.suffix}`);
  let token = readSecret(`IG_ACCESS_TOKEN${acct.suffix}`);
  if (!userId || !token) { log(`${acct.label}: not in the keychain (sh scripts/setup-keychain.sh ${acct.account || 'icu'}); skipped`); return null; }
  token = await maybeRefresh(acct, token, state);
  const profile = await ig(token, userId, { fields: 'username,followers_count,media_count' });
  const cutoff = Date.now() - INSIGHTS_DAYS * 86400000;
  const reels = [];
  let next = `${userId}/media`;
  let params = { fields: 'id,caption,media_type,media_product_type,timestamp,permalink', limit: '50' };
  while (next) {
    const page = await ig(token, next, params);
    params = {};
    for (const m of page.data ?? []) if (m.media_product_type === 'REELS' && Date.parse(m.timestamp) >= cutoff) reels.push(m);
    const last = page.data?.[page.data.length - 1];
    next = last && Date.parse(last.timestamp) >= cutoff ? page.paging?.next?.replace(/&?access_token=[^&]+/, '') : null;
  }
  const rows = [];
  const metas = {};
  let failed = 0;
  for (const m of reels) {
    const { metrics, errors } = await reelInsights(token, m.id);
    if (errors.length) { failed++; if (failed <= 3) log(`${acct.label} ${m.id}: ${errors.join('; ')}`); }
    rows.push({ date: today, platform: 'instagram', account: acct.account, id: m.id, ...metrics });
    metas[m.id] = { platform: 'instagram', account: acct.account, posted: m.timestamp, permalink: m.permalink, title: (m.caption ?? '').split('\n')[0].slice(0, 120) };
  }
  log(`${acct.label}: ${profile.followers_count} followers, ${reels.length} Reels from the last ${INSIGHTS_DAYS} days${failed ? `, ${failed} with missing metrics` : ''}`);
  return { account: { date: today, platform: 'instagram', account: acct.account, followers: profile.followers_count, mediaCount: profile.media_count }, rows, metas };
}

// ---------- YouTube ----------

async function ytToken() {
  const [id, secret, refresh] = ['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN'].map(readSecret);
  if (!id || !secret || !refresh) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  const json = await res.json();
  if (!json.access_token) throw new Error(`YouTube token refresh failed: ${json.error ?? res.status} (rerun sh scripts/setup-youtube.sh)`);
  return json.access_token;
}

async function yt(token, url, params) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${url.split('/').pop()}: ${json.error?.message ?? res.status}`);
  return json;
}

const isoSeconds = (d = '') => { const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) ?? []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };

async function fetchYouTube() {
  const token = await ytToken();
  if (!token) { log('YouTube: not in the keychain (sh scripts/setup-youtube.sh); skipped'); return null; }
  const V3 = 'https://www.googleapis.com/youtube/v3';
  const ch = (await yt(token, `${V3}/channels`, { part: 'snippet,statistics,contentDetails', mine: 'true' })).items[0];
  const ids = [];
  let pageToken = '';
  do {
    const page = await yt(token, `${V3}/playlistItems`, { part: 'contentDetails', playlistId: ch.contentDetails.relatedPlaylists.uploads, maxResults: '50', ...(pageToken && { pageToken }) });
    ids.push(...page.items.map((i) => i.contentDetails.videoId));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const videos = {};
  for (let i = 0; i < ids.length; i += 50) {
    const page = await yt(token, `${V3}/videos`, { part: 'snippet,contentDetails,statistics,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
    for (const v of page.items) videos[v.id] = v;
  }
  const report = await yt(token, 'https://youtubeanalytics.googleapis.com/v2/reports', {
    ids: 'channel==MINE', startDate: ch.snippet.publishedAt.slice(0, 10), endDate: today,
    metrics: YT_METRICS.join(','), dimensions: 'video', sort: '-views', maxResults: '200',
  });
  const cols = report.columnHeaders.map((h) => h.name);
  const stats = Object.fromEntries((report.rows ?? []).map((r) => [r[0], Object.fromEntries(cols.slice(1).map((c, i) => [c, r[i + 1]]))]));
  const rows = [];
  const metas = {};
  for (const [id, v] of Object.entries(videos)) {
    const s = stats[id] ?? {};
    rows.push({
      date: today, platform: 'youtube', account: 'yt', id,
      views: s.views ?? 0, liveViews: Number(v.statistics?.viewCount ?? 0), minutesWatched: s.estimatedMinutesWatched ?? 0,
      avgViewDuration: s.averageViewDuration ?? 0, likes: s.likes ?? Number(v.statistics?.likeCount ?? 0), subscribersGained: s.subscribersGained ?? 0,
    });
    const seconds = isoSeconds(v.contentDetails?.duration);
    metas[id] = {
      platform: 'youtube', account: 'yt', posted: v.status?.publishAt ?? v.snippet.publishedAt, title: v.snippet.title,
      permalink: seconds <= 180 ? `https://youtube.com/shorts/${id}` : `https://youtu.be/${id}`, format: seconds <= 180 ? 'short' : 'long', privacy: v.status?.privacyStatus,
    };
  }
  log(`YouTube ${ch.snippet.title}: ${ch.statistics.subscriberCount} subscribers, ${ids.length} videos`);
  return { account: { date: today, platform: 'youtube', account: 'yt', followers: Number(ch.statistics.subscriberCount), mediaCount: Number(ch.statistics.videoCount) }, rows, metas };
}

// ---------- topics and slots from the repository's markers ----------

/** mediaId / videoId → { kind, folder, brand } from the published markers on origin/main (read through git; the checkout is untouched). */
function markerIndex() {
  const git = (args, input) => execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8', input, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
  try { git(['fetch', '-q', 'origin', 'main']); } catch { log('git fetch failed; using the last fetched origin/main'); }
  const paths = git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'published', 'published-rn', 'published-medic', 'published-youtube'])
    .split('\n').filter((p) => p.endsWith('.json'));
  const out = Buffer.from(git(['cat-file', '--batch'], paths.map((p) => `origin/main:${p}`).join('\n') + '\n'), 'utf8');
  const index = {};
  // --batch prints "<sha> blob <size>\n<content>\n" per object; size is in bytes
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(' ')[2]);
    const body = out.subarray(nl + 1, nl + 1 + size).toString('utf8');
    at = nl + 1 + size + 1;
    try {
      const m = JSON.parse(body);
      const brand = p.startsWith('published-youtube') ? 'yt' : p.startsWith('published-rn') ? 'rn' : p.startsWith('published-medic') ? 'medic' : 'icu';
      if (m.mediaId) index[m.mediaId] = { kind: m.kind, folder: m.folder, brand };
      if (m.videoId) index[m.videoId] = { kind: m.kind, folder: m.folder, brand };
    } catch { /* not a marker */ }
  }
  const skip = readJson(path.join(REPO_DIR, 'youtube-skip.json'), {});
  for (const kind of ['shorts', 'long']) {
    for (const [slug, v] of Object.entries(skip[kind] ?? {})) if (v.videoId) index[v.videoId] = { kind, folder: slug, brand: 'yt' };
  }
  return index;
}

/** Topic and slot for each Reel or video: from its marker when there is one, else from the posting hour. */
function label(metas, index) {
  for (const [id, m] of Object.entries(metas)) {
    const mk = index[id];
    if (m.platform === 'youtube') {
      m.slot = 'YouTube';
      m.topic = mk?.folder ?? m.title.replace(/\s*#shorts\s*$/i, '');
      continue;
    }
    if (mk?.kind === 'reel') m.topic = 'Question of the Day';
    else if (mk?.folder) m.topic = mk.folder;
    else m.topic = m.title || '(no caption)';
    if (mk?.kind && SLOTS[mk.kind]) m.slot = SLOTS[mk.kind];
    else { const h = chicagoHour(m.posted); m.slot = h < 10 ? '7 AM' : h < 14 ? 'noon' : h < 17 ? '3 PM' : '6 PM'; }
  }
}

// ---------- store ----------

/** Replaces tonight's lines for the accounts that were fetched (a second run the same night overwrites). */
function save(results) {
  fs.mkdirSync(DIR, { recursive: true });
  const fetched = new Set(results.map((r) => `${r.account.platform}:${r.account.account}`));
  const keep = (row) => !(row.date === today && fetched.has(`${row.platform}:${row.account}`));
  const write = (name, rows) => fs.writeFileSync(file(name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('accounts.jsonl', [...readLines(file('accounts.jsonl')).filter(keep), ...results.map((r) => r.account)]);
  write('media.jsonl', [...readLines(file('media.jsonl')).filter(keep), ...results.flatMap((r) => r.rows)]);
  const metas = { ...readJson(file('media-meta.json'), {}) };
  for (const r of results) Object.assign(metas, r.metas);
  return metas;
}

async function fetchAll() {
  const state = readJson(file('state.json'), {});
  const results = [];
  let errors = 0;
  for (const acct of IG_ACCOUNTS) {
    try { const r = await fetchInstagram(acct, state); if (r) results.push(r); } catch (e) { errors++; log(`ERROR ${acct.label}: ${scrub(e.message)}`); }
  }
  try { const r = await fetchYouTube(); if (r) results.push(r); } catch (e) { errors++; log(`ERROR YouTube: ${scrub(e.message)}`); }
  const metas = save(results);
  try { label(metas, markerIndex()); } catch (e) { log(`Could not read markers (${e.message}); topics come from captions`); label(metas, {}); }
  fs.writeFileSync(file('media-meta.json'), JSON.stringify(metas, null, 2) + '\n');
  fs.writeFileSync(file('state.json'), JSON.stringify(state, null, 2) + '\n');
  return errors;
}

// ---------- made-up data for testing the store and the dashboard without any network ----------

function writeFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  const topics = ['sodium', 'potassium', 'heparin-antidotes', 'sepsis', 'abg-rome', 'stemi-reciprocal', 'Question of the Day', 'rhythm-drill', 'dka-vs-hhs', 'types-of-shock'];
  const slots = ['noon', 'noon', 'noon', 'noon', 'noon', '7 AM', '7 AM', '6 PM', 'noon', '3 PM'];
  const accounts = [...IG_ACCOUNTS.map((a) => ({ platform: 'instagram', account: a.account })), { platform: 'youtube', account: 'yt' }];
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const acc = [];
  const media = [];
  const metas = {};
  for (let d = 30; d >= 0; d--) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) - d * 86400000).toISOString().slice(0, 10);
    accounts.forEach((a, ai) => {
      acc.push({ date, ...a, followers: Math.round([420, 1350, 260, 85][ai] + (30 - d) * [6, 14, 4, 3][ai] + rand() * 5), mediaCount: 60 + 30 - d });
      topics.forEach((t, ti) => {
        const id = `${a.account}-${ti}`;
        const age = 30 - d - ti * 3;
        if (age < 0) return;
        const v = Math.round(Math.min(age, 6) * (200 + 90 * ((ti * 7 + ai) % 5)) * (1 + rand() * 0.1));
        const row = a.platform === 'youtube'
          ? { views: v, liveViews: v + 40, minutesWatched: Math.round(v * 0.6), avgViewDuration: 31 + ti, likes: Math.round(v / 25), subscribersGained: Math.round(v / 300) }
          : { views: v, reach: Math.round(v * 0.7), saved: Math.round(v / 40), shares: Math.round(v / 60), likes: Math.round(v / 20), comments: Math.round(v / 200), total_interactions: Math.round(v / 12), ig_reels_avg_watch_time: 9000 + ti * 800, ig_reels_video_view_total_time: v * 9000 };
        media.push({ date, ...a, id, ...row });
        metas[id] = { platform: a.platform, account: a.account, posted: new Date(Date.parse(`${today}T17:00:00Z`) - (30 - ti * 3) * 86400000).toISOString(), title: `${t} (fixture)`, permalink: 'https://example.com/', topic: t, slot: a.platform === 'youtube' ? 'YouTube' : slots[ti] };
      });
    });
  }
  fs.writeFileSync(file('accounts.jsonl'), acc.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(file('media.jsonl'), media.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(file('media-meta.json'), JSON.stringify(metas, null, 2) + '\n');
  log(`Wrote fixture data to ${DIR}`);
}

// ---------- dashboard ----------

const ACCOUNT_LABELS = { icu: '@icubasics', rn: '@rnbasicsnclex', medic: '@themedicbasics', yt: 'YouTube @TheRNBasics' };

/** Each Reel or video with its latest totals and the totals about a week earlier (for "this week"). */
function buildData() {
  const metas = readJson(file('media-meta.json'), {});
  const byId = {};
  for (const r of readLines(file('media.jsonl'))) (byId[r.id] ??= []).push(r);
  const lastDate = Object.values(byId).flat().reduce((m, r) => (r.date > m ? r.date : m), '');
  const weekAgo = lastDate && new Date(Date.parse(`${lastDate}T12:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const media = Object.entries(byId).map(([id, rows]) => {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows[rows.length - 1];
    const m = metas[id] ?? {};
    const before = [...rows].reverse().find((r) => r.date <= weekAgo);
    // No snapshot a week back: new this week counts from zero; older ones count from their first snapshot
    const base = before ?? (m.posted && m.posted.slice(0, 10) > weekAgo ? {} : rows[0]);
    const { date, platform, account, id: _, ...totals } = latest;
    return { id, platform, account, date, ...m, totals, weekViews: (latest.views ?? 0) - (base.views ?? 0), weekExact: Boolean(before) };
  });
  const followers = {};
  for (const r of readLines(file('accounts.jsonl'))) (followers[r.account] ??= []).push([r.date, r.followers]);
  for (const s of Object.values(followers)) s.sort((a, b) => a[0].localeCompare(b[0]));
  return { generatedAt: new Date().toISOString(), lastDate, labels: ACCOUNT_LABELS, followers, media };
}

function writeDashboard() {
  const template = fs.readFileSync(path.join(REPO_DIR, 'scripts/dashboard-template.html'), 'utf8');
  const data = JSON.stringify(buildData()).replace(/</g, '\\u003c');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file('dashboard.html'), template.replace('/*DATA*/null', data));
  log(`Dashboard: ${file('dashboard.html')}`);
}

const mode = process.argv[2] ?? 'all';
let errors = 0;
if (fixtures) writeFixtures();
else if (mode !== 'dashboard') errors = await fetchAll();
if (mode !== 'fetch') writeDashboard();
if (errors) process.exit(1);
