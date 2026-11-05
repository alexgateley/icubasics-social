// The local "Post to TikTok" page for the Basics shorts. Runs ONLY on Alex's Mac: a small web server on
// 127.0.0.1 serves scripts/tiktok-poster.html, lists the shorts in ~/Desktop/Social Media Uploads/, and
// posts the one the user picks with TikTok's Content Posting API (FILE_UPLOAD), then polls its status.
// The page follows TikTok's Direct Post UX rules line by line (docs/tiktok-setup.md, "Posting page");
// it is also the screen recorded for the audit demo (docs/tiktok-audit.md).
//
//   node scripts/tiktok-poster.mjs                 # opens http://127.0.0.1:8765/
//   node scripts/tiktok-poster.mjs --port 8800 --no-open
//
// Test without TikTok (fake accounts and API, nothing leaves the Mac):
//   TIKTOK_FAKE_DIR=/tmp/tt node --import ./scripts/tiktok-fake-api.mjs scripts/tiktok-poster.mjs
//
// Nothing is sent to TikTok until the user presses Post (rule 5c). Each press re-reads creator_info
// first (rule 1), checks every choice again on the server (privacy from privacy_level_options, interaction
// settings the creator turned off, branded content not private, video length, caption length), and only
// then calls init and uploads. The record of what was posted is TIKTOK_STATE (default
// ~/basics-growth-work/tiktok/posted.json), never the repository.
//
// No scheduled or unattended posting: TikTok requires the user's express consent to each upload and a
// privacy choice made by hand with no default (rules 2b and 5c), so every post goes through this page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BRANDS, MAX_VIDEO_BYTES, STATE_FILE, UPLOADS_DIR, TikTokError,
  accounts, activeEnv, creatorInfo, fetchStatus, initDirectPost, initInbox, listShorts, loadTokens, postKey, readState, uploadFile, writeState,
} from './tiktok-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TITLE_MAX = 2200; // UTF-16 code units, as JavaScript counts string length
const PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

// Messages for the creator_info / init errors a user can do something about
const FRIENDLY = {
  spam_risk_too_many_posts: 'This TikTok account has reached its posting limit for the last 24 hours. Try again later.',
  spam_risk_user_banned_from_posting: 'TikTok is not allowing this account to post right now.',
  reached_active_user_cap: 'This app has reached TikTok\'s daily limit of accounts that can post. Try again later.',
  unaudited_client_can_only_post_to_private_accounts: 'Until TikTok audits this app, it can post only to a private account, as "Only me". Set the TikTok account to private, or choose "Only me".',
  privacy_level_option_mismatch: 'That privacy choice is not available for this account any more. Pick it again.',
  spam_risk_too_many_pending_share: 'There are already 5 drafts waiting in this account\'s TikTok inbox from the last 24 hours. Post or delete them in the TikTok app first.',
  access_token_invalid: 'The TikTok sign-in is no longer valid. Run sh scripts/setup-tiktok.sh again.',
  scope_not_authorized: 'The TikTok sign-in is missing a permission. Run sh scripts/setup-tiktok.sh again and allow every permission.',
  rate_limit_exceeded: 'TikTok asked us to slow down. Wait a minute and try again.',
};
const explain = (e) => FRIENDLY[e.code] ?? e.message;

/**
 * Every reason this post must not be sent, checked on the server whatever the page did. Direct Post rules
 * (https://developers.tiktok.com/doc/content-sharing-guidelines) are numbered as there.
 */
export function validatePost(req, { creator, short }) {
  const problems = [];
  if (req.consent !== true) problems.push('The user has not pressed Post (5c).');
  if (!short) { problems.push('That short is not in the uploads folder.'); return problems; }
  if (short.size > MAX_VIDEO_BYTES) problems.push('The video is over 4 GB.');
  if (req.mode === 'inbox') return problems;
  if (req.mode !== 'direct') { problems.push('Unknown posting mode.'); return problems; }
  if (typeof req.title !== 'string') problems.push('The caption is missing (2a).');
  else if (req.title.length > TITLE_MAX) problems.push(`The caption is ${req.title.length} characters; TikTok allows ${TITLE_MAX}.`);
  if (!req.privacy_level) problems.push('Choose who can view this video (2b: no default).');
  else if (!(creator.privacy_level_options ?? []).includes(req.privacy_level)) problems.push('That privacy option is not offered for this account (2b).');
  if (req.allow_comment && creator.comment_disabled) problems.push('Comments are turned off in this account\'s TikTok settings (2c).');
  if (req.allow_duet && creator.duet_disabled) problems.push('Duet is turned off in this account\'s TikTok settings (2c).');
  if (req.allow_stitch && creator.stitch_disabled) problems.push('Stitch is turned off in this account\'s TikTok settings (2c).');
  if (req.commercial && !req.brand_organic && !req.brand_content) problems.push('You need to indicate if your content promotes yourself, a third party, or both. (3a)');
  if (!req.commercial && (req.brand_organic || req.brand_content)) problems.push('Turn on the content disclosure setting first (3a).');
  if (req.brand_content && req.privacy_level === 'SELF_ONLY') problems.push('Branded content visibility cannot be set to private. (3b)');
  const max = Number(creator.max_video_post_duration_sec);
  if (short.duration == null) problems.push('Could not read the video length.');
  else if (max && short.duration > max) problems.push(`The video is ${Math.round(short.duration)} s; this account can post up to ${max} s (1c).`);
  return problems;
}

/** post_info for Direct Post from the page's choices (the API's switches are "disable", the page's are "allow"). */
export function postInfo(req) {
  return {
    title: req.title,
    privacy_level: req.privacy_level,
    disable_comment: !req.allow_comment,
    disable_duet: !req.allow_duet,
    disable_stitch: !req.allow_stitch,
    brand_organic_toggle: Boolean(req.commercial && req.brand_organic),
    brand_content_toggle: Boolean(req.commercial && req.brand_content),
    is_aigc: Boolean(req.is_aigc),
  };
}

// ---------- server ----------

export function startPoster({ port = 8765, open = true } = {}) {
  const secret = crypto.randomBytes(24).toString('hex');
  const html = fs.readFileSync(path.join(HERE, 'tiktok-poster.html'), 'utf8').replace('__POSTER_TOKEN__', secret);
  const findShort = (account, folder) => (BRANDS[account] ? listShorts(account).find((s) => s.folder === folder) : null);

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad JSON')); } });
  });

  const server = http.createServer(async (req, res) => {
    const actual = server.address().port;
    const url = new URL(req.url, `http://127.0.0.1:${actual}`);
    // Only this Mac's own page: the Host must be ours (no DNS rebinding), and every API call carries the
    // per-run token from the page (no other website can post through it)
    if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'" });
      res.end(html);
      return;
    }
    const account = url.searchParams.get('account') ?? '';
    const folder = url.searchParams.get('folder') ?? '';
    if (url.pathname === '/video') {
      // The preview (5a). <video> cannot send headers, so this read-only route is open to the page's origin only
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') { res.writeHead(403).end(); return; }
      const s = findShort(account, folder);
      if (!s) { res.writeHead(404).end(); return; }
      const range = (req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, s.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), s.size - 1) : s.size - 1;
        if (start > end || start >= s.size) { res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }).end(); return; }
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(s.video, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': s.size });
        fs.createReadStream(s.video).pipe(res);
      }
      return;
    }
    if (req.headers['x-poster-token'] !== secret) { send(res, 403, { error: 'Reload the page.' }); return; }
    try {
      if (url.pathname === '/api/accounts' && req.method === 'GET') {
        send(res, 200, { accounts: accounts(), env: activeEnv(), uploadsDir: UPLOADS_DIR, stateFile: STATE_FILE });
      } else if (url.pathname === '/api/shorts' && req.method === 'GET') {
        if (!BRANDS[account]) { send(res, 400, { error: 'unknown account' }); return; }
        const posts = readState().posts;
        send(res, 200, { shorts: listShorts(account).map(({ video, ...s }) => ({ ...s, posted: posts[postKey(account, s.folder)] ?? null })) });
      } else if (url.pathname === '/api/creator' && req.method === 'GET') {
        // Rule 1: the latest creator info every time the posting form is shown
        if (!loadTokens(account)?.refresh_token) { send(res, 200, { signedIn: false }); return; }
        try {
          send(res, 200, { signedIn: true, creator: await creatorInfo(account) });
        } catch (e) {
          send(res, 200, { signedIn: true, cannotPost: true, code: e.code, error: explain(e) });
        }
      } else if (url.pathname === '/api/post' && req.method === 'POST') {
        const body = await readBody(req);
        const s = findShort(body.account, body.folder);
        if (!BRANDS[body.account]) { send(res, 400, { error: 'unknown account' }); return; }
        let creator = {};
        try { creator = await creatorInfo(body.account); } catch (e) { send(res, 409, { error: explain(e), code: e.code }); return; } // 1b
        const problems = validatePost(body, { creator, short: s });
        if (problems.length) { send(res, 400, { error: problems.join(' '), problems }); return; }
        const init = body.mode === 'inbox' ? await initInbox(body.account, s.size) : await initDirectPost(body.account, postInfo(body), s.size);
        const state = readState();
        const key = postKey(body.account, body.folder);
        state.posts[key] = {
          publish_id: init.publish_id, mode: body.mode, status: 'UPLOADING', at: new Date().toISOString(), username: creator.creator_username ?? '',
          ...(body.mode === 'direct' && { privacy_level: body.privacy_level, title: body.title }), previous: state.posts[key] ?? undefined,
        };
        writeState(state);
        try {
          await uploadFile(init.upload_url, s.video);
        } catch (e) {
          state.posts[key].status = 'UPLOAD_FAILED';
          state.posts[key].fail_reason = e.message;
          writeState(state);
          throw e;
        }
        state.posts[key].status = 'UPLOADED';
        writeState(state);
        send(res, 200, { publish_id: init.publish_id });
      } else if (url.pathname === '/api/status' && req.method === 'GET') {
        const id = url.searchParams.get('publish_id') ?? '';
        const d = await fetchStatus(account, id);
        const state = readState();
        const entry = Object.values(state.posts).find((p) => p.publish_id === id);
        const ids = d.publicaly_available_post_id ?? [];
        const link = ids.length && entry?.username ? `https://www.tiktok.com/@${entry.username}/video/${ids[0]}` : '';
        if (entry) { Object.assign(entry, { status: d.status, fail_reason: d.fail_reason ?? '', post_ids: ids.map(String), link, checked: new Date().toISOString() }); writeState(state); }
        send(res, 200, { ...d, link });
      } else {
        send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      send(res, e instanceof TikTokError && e.status ? (e.status === 429 ? 429 : 502) : 500, { error: explain(e), code: e.code ?? '', logId: e.logId ?? '' });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const where = `http://127.0.0.1:${server.address().port}/`;
      console.log(`TikTok poster at ${where} (${activeEnv()} app; Ctrl-C to stop)\nShorts: ${UPLOADS_DIR}\nRecord: ${STATE_FILE}`);
      if (open) execFileSync('open', [where]);
      resolve({ server, url: where, secret });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--port');
  const port = at >= 0 ? Number(args[at + 1]) : Number(process.env.TIKTOK_POSTER_PORT || 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('ERROR: --port needs a number'); process.exit(1); }
  startPoster({ port, open: !args.includes('--no-open') }).catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}

export { PRIVACY };
