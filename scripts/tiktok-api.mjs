// TikTok Content Posting API helpers shared by tiktok-auth.mjs, tiktok-poster.mjs and the tests.
// Everything here runs on Alex's Mac only (the videos live there, the repository is public). The app's
// client key and secret, and each TikTok account's tokens, live in the login keychain (service
// icubasics-social, scripts/keychain.mjs); nothing is printed or written to the repository.
//
// Checked against developers.tiktok.com on 2026-11-03 (docs/tiktok-setup.md lists every page):
//   OAuth      https://www.tiktok.com/v2/auth/authorize/ (desktop: PKCE required, code_challenge is the
//              HEX SHA-256 of the verifier, not base64url) and POST https://open.tiktokapis.com/v2/oauth/token/
//              (form-encoded). Access token 2 hours, refresh token 180 days, and the refresh token
//              ROTATES: every refresh returns a new one and the old one stops working, so it is saved
//              before anything else happens.
//   Posting    creator_info/query (20/min per token), video/init (Direct Post, 6/min), inbox/video/init
//              (Upload as a draft, 6/min), status/fetch (30/min). FILE_UPLOAD chunks: 5-64 MB each,
//              the last one may hold the trailing bytes (up to 128 MB), under 5 MB in one piece, over
//              64 MB in several, total_chunk_count = floor(video_size / chunk_size), 1-1000 chunks,
//              sequential PUTs (206 per chunk, 201 at the end), upload_url valid one hour.
//   Videos     MP4/WebM/MOV, H.264 recommended, 23-60 fps, 360-4096 px each side, at most 4 GB, and no
//              longer than creator_info's max_video_post_duration_sec.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecret, writeSecret } from './keychain.mjs';

export const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const API = 'https://open.tiktokapis.com';
export const TOKEN_URL = `${API}/v2/oauth/token/`;
// user.info.basic: the signed-in account's name and avatar (sign-in check); video.publish: creator_info
// and Direct Post; video.upload: "send to TikTok inbox as a draft"
export const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
export const REQUIRED_SCOPES = ['user.info.basic', 'video.publish'];
// Exactly the Desktop redirect URI registered in the app's Login Kit settings (TikTok compares it as a
// string: no trailing slash). TIKTOK_AUTH_PORT exists only for the tests.
export const AUTH_PORT = Number(process.env.TIKTOK_AUTH_PORT || 8763);
export const REDIRECT_URI = `http://localhost:${AUTH_PORT}/callback`;
export const UPLOADS_DIR = process.env.TIKTOK_UPLOADS_DIR || path.join(os.homedir(), 'Desktop/Social Media Uploads');
export const STATE_FILE = process.env.TIKTOK_STATE || path.join(os.homedir(), 'basics-growth-work/tiktok/posted.json');

const MB = 1024 * 1024;
export const MAX_VIDEO_BYTES = 4 * 1024 * MB;
const CHUNK = 10_000_000; // the docs' own example size; any 5-64 MB value works

// One TikTok account per brand. The video is "short - <file>.mp4" in each topic folder, and its caption
// is the TIKTOK block of that brand's section in "short - captions and tags.txt". Only RN has a TikTok
// account so far (@thernbasics); the others are ready for when they get one.
export const BRANDS = {
  rn: { name: 'RN Basics', file: 'RN Basics', section: 'RN BASICS', match: /rn\s*basics/i, handles: ['thernbasics'] },
  icu: { name: 'ICU Basics', file: 'ICU Basics', section: 'ICU BASICS', match: /icu\s*basics/i, handles: ['icubasics'] },
  medic: { name: 'Medic Basics', file: 'Medic Basics', section: 'MEDIC BASICS', match: /medic\s*basics/i, handles: ['themedicbasics'] },
};

export class TikTokError extends Error {
  constructor(message, { status = 0, code = '', logId = '' } = {}) {
    super(message);
    Object.assign(this, { status, code, logId });
  }
}

// ---------- credentials ----------
// TIKTOK_FAKE_STORE (set only by tiktok-fake-api.mjs) swaps the keychain for a JSON file in a test folder.

function store() {
  const file = process.env.TIKTOK_FAKE_STORE;
  if (!file) return { read: readSecret, write: writeSecret };
  const all = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    read: (k) => all()[k] ?? '',
    write: (k, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...all(), [k]: v }, null, 2)); },
  };
}

// Two sets of credentials: the app's Sandbox ("Basics Sandbox", for testing and the audit demo) and
// Production have different client keys, and a sign-in made with one does not work with the other.
//   sandbox     TIKTOK_SANDBOX_CLIENT_KEY, TIKTOK_SANDBOX_CLIENT_SECRET, TIKTOK_SANDBOX_TOKENS_<ACCOUNT>
//   production  TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_TOKENS_<ACCOUNT>
// The one in use is TIKTOK_ACTIVE_ENV in the keychain (setup-tiktok.sh sets it), or TIKTOK_ENV for one run.
export const ENVS = ['sandbox', 'production'];
export function activeEnv() {
  const env = process.env.TIKTOK_ENV || store().read('TIKTOK_ACTIVE_ENV') || 'sandbox';
  if (!ENVS.includes(env)) throw new TikTokError(`TIKTOK_ENV must be sandbox or production, not "${env}"`);
  return env;
}
export const prefix = (env = activeEnv()) => (env === 'sandbox' ? 'TIKTOK_SANDBOX_' : 'TIKTOK_');
export const tokenKey = (account, env) => `${prefix(env)}TOKENS_${account.toUpperCase()}`;
export const clientCreds = (env) => ({ key: store().read(`${prefix(env)}CLIENT_KEY`), secret: store().read(`${prefix(env)}CLIENT_SECRET`) });

/** The stored sign-in for an account ({ open_id, access_token, access_expires_at, refresh_token, ... }) or null. */
export function loadTokens(account) {
  const raw = store().read(tokenKey(account));
  if (!raw) return null;
  try { return JSON.parse(raw.startsWith('b64:') ? Buffer.from(raw.slice(4), 'base64url').toString('utf8') : raw); } catch { return null; }
}

/** Stores a token response (expires_in seconds → absolute times). Base64url JSON: keychain.mjs takes no spaces or emoji, and display names can have both. */
export function saveTokens(account, json, extra = {}) {
  const now = Date.now();
  const prev = loadTokens(account) ?? {};
  const t = {
    ...prev,
    ...extra,
    open_id: json.open_id ?? prev.open_id,
    scope: json.scope ?? prev.scope,
    access_token: json.access_token,
    access_expires_at: new Date(now + Number(json.expires_in ?? 0) * 1000).toISOString(),
    refresh_token: json.refresh_token ?? prev.refresh_token,
    refresh_expires_at: json.refresh_expires_in ? new Date(now + Number(json.refresh_expires_in) * 1000).toISOString() : prev.refresh_expires_at,
  };
  store().write(tokenKey(account), `b64:${Buffer.from(JSON.stringify(t)).toString('base64url')}`);
  return t;
}

/** Accounts with a stored sign-in, plus every known brand (signed in or not). */
export function accounts() {
  return Object.entries(BRANDS).map(([id, b]) => {
    const t = loadTokens(id);
    return { id, brand: b.name, signedIn: Boolean(t?.refresh_token), name: t?.display_name ?? '', username: t?.username ?? '', refreshExpiresAt: t?.refresh_expires_at ?? '' };
  });
}

/** Form POST to the token endpoint; throws with TikTok's error and log id. */
export async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || !json.access_token) {
    throw new TikTokError(`token request failed: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim(), { status: res.status, code: json.error ?? '', logId: json.log_id ?? '' });
  }
  return json;
}

const refreshing = new Map();

/** A valid access token for the account, refreshing (and saving the rotated refresh token) when under 5 minutes are left. */
export async function accessToken(account) {
  const t = loadTokens(account);
  if (!t?.refresh_token) throw new TikTokError(`${account}: not signed in to TikTok; run sh scripts/setup-tiktok.sh ${account}`, { code: 'not_signed_in' });
  if (t.access_token && Date.parse(t.access_expires_at) - Date.now() > 5 * 60000) return t.access_token;
  if (t.refresh_expires_at && Date.parse(t.refresh_expires_at) < Date.now()) throw new TikTokError(`${account}: the TikTok sign-in expired (180 days); run sh scripts/setup-tiktok.sh ${account}`, { code: 'refresh_expired' });
  // One refresh at a time per account: a second refresh with the old token would fail after rotation
  if (!refreshing.has(account)) {
    const { key, secret } = clientCreds();
    if (!key || !secret) throw new TikTokError(`the ${activeEnv()} client key and secret are not in the keychain; run sh scripts/setup-tiktok.sh`, { code: 'no_client' });
    refreshing.set(account, tokenRequest({ client_key: key, client_secret: secret, grant_type: 'refresh_token', refresh_token: t.refresh_token })
      .then((json) => saveTokens(account, json).access_token)
      .catch((e) => { throw new TikTokError(`${account}: token refresh failed (${e.code || e.message}); run sh scripts/setup-tiktok.sh ${account}`, { code: e.code, logId: e.logId }); })
      .finally(() => refreshing.delete(account)));
  }
  return refreshing.get(account);
}

/**
 * One Open API call. TikTok answers { data, error: { code, message, log_id } }; any code but "ok" is a failure.
 * account is an account id ("rn"), or { accessToken } for a token that is not stored yet (the sign-in check).
 */
export async function api(account, method, endpoint, body) {
  const bearer = typeof account === 'string' ? await accessToken(account) : account.accessToken;
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body && { 'Content-Type': 'application/json; charset=UTF-8' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Post ids are int64 (19 digits), past JavaScript's exact integers: quote them before parsing
  const text = (await res.text()).replace(/("publicaly_available_post_id"\s*:\s*\[)([^\]]*)\]/g, (_, head, ids) => `${head}${ids.replace(/(\d{16,})/g, '"$1"')}]`);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON: the status code tells */ }
  const err = json.error ?? {};
  if (!res.ok || (err.code && err.code !== 'ok')) {
    throw new TikTokError(`${endpoint}: ${res.status} ${err.code ?? ''} ${err.message ?? ''}`.replace(/\s+/g, ' ').trim(), { status: res.status, code: err.code ?? '', logId: err.log_id ?? err.logid ?? '' });
  }
  return json.data ?? {};
}

export const userInfo = (account) => api(account, 'GET', '/v2/user/info/?fields=open_id,avatar_url,display_name').then((d) => d.user ?? {});
export const creatorInfo = (account) => api(account, 'POST', '/v2/post/publish/creator_info/query/', {});
export const fetchStatus = (account, publishId) => api(account, 'POST', '/v2/post/publish/status/fetch/', { publish_id: publishId });

// ---------- upload ----------

/** source_info for FILE_UPLOAD under TikTok's chunk rules. */
export function chunkPlan(size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('empty video file');
  if (size > MAX_VIDEO_BYTES) throw new Error('the video is over 4 GB, TikTok\'s limit');
  if (size <= 64 * MB) return { video_size: size, chunk_size: size, total_chunk_count: 1 };
  const count = Math.floor(size / CHUNK);
  return { video_size: size, chunk_size: CHUNK, total_chunk_count: count };
}

/** Byte ranges for a plan: every chunk is chunk_size, the last one also takes the trailing bytes. */
export function chunkRanges({ video_size: size, chunk_size: chunk, total_chunk_count: count }) {
  return Array.from({ length: count }, (_, i) => [i * chunk, i === count - 1 ? size - 1 : (i + 1) * chunk - 1]);
}

/** Direct Post init (FILE_UPLOAD). postInfo is the post_info object TikTok documents. */
export function initDirectPost(account, postInfo, size) {
  return api(account, 'POST', '/v2/post/publish/video/init/', { post_info: postInfo, source_info: { source: 'FILE_UPLOAD', ...chunkPlan(size) } });
}

/** Upload-as-draft init (FILE_UPLOAD): the video lands in the creator's TikTok inbox to finish in the app. */
export function initInbox(account, size) {
  return api(account, 'POST', '/v2/post/publish/inbox/video/init/', { source_info: { source: 'FILE_UPLOAD', ...chunkPlan(size) } });
}

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

/** Sends the file to upload_url in sequential chunks; onProgress(bytesSent, total). Retries a chunk once on 5xx. */
export async function uploadFile(uploadUrl, file, onProgress = () => {}) {
  const size = fs.statSync(file).size;
  const plan = chunkPlan(size);
  const type = MIME[path.extname(file).toLowerCase()] ?? 'video/mp4';
  const fd = fs.openSync(file, 'r');
  try {
    const ranges = chunkRanges(plan);
    for (const [i, [first, last]] of ranges.entries()) {
      const buf = Buffer.alloc(last - first + 1);
      fs.readSync(fd, buf, 0, buf.length, first);
      let res;
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${first}-${last}/${size}` }, body: buf });
        if (res.status < 500) break;
      }
      const want = i === ranges.length - 1 ? 201 : 206;
      if (res.status !== want) {
        const why = { 400: 'bad request headers', 403: 'the upload URL expired (one hour)', 404: 'no such upload task', 416: 'Content-Range out of step' }[res.status] ?? '';
        throw new TikTokError(`upload chunk ${i + 1}/${ranges.length}: HTTP ${res.status} ${why}`.trim(), { status: res.status });
      }
      onProgress(last + 1, size);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- the shorts on the Desktop ----------

/** Seconds of an MP4/MOV from its mvhd box (no ffprobe needed), or null when it cannot be read. */
export function mp4Duration(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const box = (pos) => {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let hdr = 8;
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      return { len, type, hdr };
    };
    let pos = 0;
    while (pos + 8 <= size) {
      const b = box(pos);
      if (b.len < 8) return null;
      if (b.type === 'moov') {
        const moov = Buffer.alloc(Math.min(b.len - b.hdr, 64 * MB));
        fs.readSync(fd, moov, 0, moov.length, pos + b.hdr);
        let p = 0;
        while (p + 8 <= moov.length) {
          const len = moov.readUInt32BE(p);
          if (moov.toString('latin1', p + 4, p + 8) === 'mvhd') {
            const v = moov[p + 8];
            const [scale, dur] = v === 1 ? [moov.readUInt32BE(p + 28), Number(moov.readBigUInt64BE(p + 32))] : [moov.readUInt32BE(p + 20), moov.readUInt32BE(p + 24)];
            return scale ? dur / scale : null;
          }
          if (len < 8) return null;
          p += len;
        }
        return null;
      }
      pos += b.len;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The captions per brand from "short - captions and tags.txt":
 *   { rn: { tiktok: '...', instagram: '...' }, icu: {...}, ... , aiVoice: true }
 * Sections start at "════ RN BASICS ════"; a block starts at "TIKTOK  (@handle)" or "INSTAGRAM REELS  (...)",
 * its text follows "Caption:" up to the next blank line or rule. A block before any section, or one whose
 * header names a version ("@thernbasics, RN version"), belongs to the brand it names.
 */
export function parseCaptions(text) {
  const out = { aiVoice: /AI-generated|voice is AI|synthetic/i.test(text) };
  const lines = text.replace(/\r/g, '').split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const sec = line.match(/^═+\s*(.+?)\s*═+$/);
    if (sec) { section = Object.keys(BRANDS).find((id) => BRANDS[id].section === sec[1].toUpperCase()) ?? ''; continue; }
    const block = line.match(/^(TIKTOK|INSTAGRAM REELS)\s*\((.*)\)\s*$/);
    if (!block) continue;
    const kind = block[1] === 'TIKTOK' ? 'tiktok' : 'instagram';
    let j = i + 1;
    while (j < lines.length && !/^Caption:\s*$/i.test(lines[j].trim())) { if (/^[═─]/.test(lines[j].trim()) || !lines[j].trim()) break; j++; }
    if (!/^Caption:\s*$/i.test(lines[j]?.trim() ?? '')) continue;
    const body = [];
    for (j++; j < lines.length && lines[j].trim() && !/^[═─]{3}/.test(lines[j].trim()); j++) body.push(lines[j].trimEnd());
    const caption = body.join('\n').trim();
    const named = Object.keys(BRANDS).filter((id) => new RegExp(`\\b${id}\\b version`, 'i').test(block[2]) || BRANDS[id].handles.some((h) => new RegExp(`@${h}\\b`, 'i').test(block[2])));
    // A multi-brand header ("@icubasics: ICU version · @rnbasicsnclex: RN version") stays with its section
    const owners = section ? [section] : named;
    for (const id of owners) { out[id] ??= {}; out[id][kind] ??= caption; }
  }
  return out;
}

/** Topic folders that have this brand's short: [{ folder, video, size, duration, caption, captionFrom, aiVoice }]. */
export function listShorts(brandId, dir = UPLOADS_DIR) {
  const b = BRANDS[brandId];
  if (!b || !fs.existsSync(dir)) return [];
  const out = [];
  for (const folder of fs.readdirSync(dir).sort((x, y) => x.localeCompare(y))) {
    const video = path.join(dir, folder, `short - ${b.file}.mp4`);
    if (!fs.existsSync(video)) continue;
    const txt = path.join(dir, folder, 'short - captions and tags.txt');
    const caps = fs.existsSync(txt) ? parseCaptions(fs.readFileSync(txt, 'utf8')) : {};
    const mine = caps[brandId] ?? {};
    const caption = mine.tiktok ?? mine.instagram ?? '';
    let duration = null;
    try { duration = mp4Duration(video); } catch { /* unreadable: the poster blocks it */ }
    out.push({ folder, video, size: fs.statSync(video).size, duration, caption, captionFrom: mine.tiktok ? 'tiktok' : mine.instagram ? 'instagram' : '', aiVoice: Boolean(caps.aiVoice) });
  }
  return out;
}

// ---------- the record of what was posted (never in the repository) ----------

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { note: 'Written by scripts/tiktok-poster.mjs: topic folder and account → TikTok publish id and status.', posts: {} }; }
}

export function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

export const postKey = (account, folder) => `${account}/${folder}`;
