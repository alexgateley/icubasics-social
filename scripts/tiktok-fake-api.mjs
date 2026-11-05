// A stand-in for TikTok's OAuth and Content Posting endpoints, for testing tiktok-auth.mjs and
// tiktok-poster.mjs with no TikTok app, no network and no keychain. Load it before the script:
//
//   TIKTOK_FAKE_DIR=/tmp/tt node --import ./scripts/tiktok-fake-api.mjs scripts/tiktok-poster.mjs
//
// It keeps everything in TIKTOK_FAKE_DIR: store.json (stands in for the keychain: a fake sandbox client
// key and secret, and a signed-in "rn" account unless TIKTOK_FAKE_SIGNED_OUT=1; TIKTOK_ENV is sandbox), db.json (calls, posts, refresh
// tokens) and posted.json (the poster's record, unless TIKTOK_STATE is set). It enforces what the real
// API documents: hex-SHA-256 PKCE, exact redirect_uri, refresh-token rotation, privacy from
// privacy_level_options, the chunk rules and Content-Range order, 2,200-character titles, and the
// unaudited-client rules. Requests to 127.0.0.1/localhost go to the real fetch (the poster's own page).
//
// Optional:
//   TIKTOK_FAKE_CREATOR   JSON merged into creator_info, e.g. {"comment_disabled":true,"max_video_post_duration_sec":30}
//   TIKTOK_FAKE_FAIL      "creator:spam_risk_too_many_posts", "init:reached_active_user_cap", "upload:500" (first
//                         chunk fails once), "status:duration_check_failed" (processing ends FAILED with that reason)
//   TIKTOK_FAKE_UNAUDITED 1: only SELF_ONLY posts to a private account (FOLLOWER_OF_CREATOR in the options), else
//                         403 unaudited_client_can_only_post_to_private_accounts
//   TIKTOK_FAKE_USER      JSON for the signed-in user, default {"display_name":"RN Basics","creator_username":"thernbasics"}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.env.TIKTOK_FAKE_DIR;
if (!DIR) throw new Error('tiktok-fake-api.mjs needs TIKTOK_FAKE_DIR');
fs.mkdirSync(DIR, { recursive: true });
const STORE = path.join(DIR, 'store.json');
const DB = path.join(DIR, 'db.json');
process.env.TIKTOK_FAKE_STORE = STORE;
process.env.TIKTOK_ENV ||= 'sandbox';
process.env.TIKTOK_STATE ||= path.join(DIR, 'posted.json');

const user = { display_name: 'RN Basics', creator_username: 'thernbasics', ...JSON.parse(process.env.TIKTOK_FAKE_USER || '{}') };
const b64 = (o) => `b64:${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
if (!fs.existsSync(STORE)) {
  const s = { TIKTOK_SANDBOX_CLIENT_KEY: 'sbawfakeclientkey', TIKTOK_SANDBOX_CLIENT_SECRET: 'fakeclientsecret' };
  if (!process.env.TIKTOK_FAKE_SIGNED_OUT) {
    s.TIKTOK_SANDBOX_TOKENS_RN = b64({ open_id: 'fake-open-id-rn', scope: 'user.info.basic,video.publish,video.upload', access_token: 'act.fake.expired', access_expires_at: new Date(0).toISOString(), refresh_token: 'rft.fake.seed', refresh_expires_at: new Date(Date.now() + 180 * 864e5).toISOString(), display_name: user.display_name, username: user.creator_username });
  }
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2));
}
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { calls: [], posts: {}, refresh: { 'rft.fake.seed': true }, access: {}, next: 1 };
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const [failWhat, failValue] = (process.env.TIKTOK_FAKE_FAIL ?? '').split(':');
const unaudited = Boolean(process.env.TIKTOK_FAKE_UNAUDITED);
let uploadFailed = false;

const realFetch = globalThis.fetch;
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const ok = (data) => reply(200, { data, error: { code: 'ok', message: '', log_id: 'fakelog' } });
const err = (status, code, message = code) => reply(status, { error: { code, message, log_id: 'fakelog' } });
const bytes = (body) => (body == null ? 0 : body.byteLength ?? body.length ?? Buffer.byteLength(String(body)));

function creatorInfo() {
  const base = unaudited
    ? { privacy_level_options: ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], duet_disabled: true, stitch_disabled: true }
    : { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], duet_disabled: false, stitch_disabled: false };
  return {
    creator_avatar_url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="%230f9d8e"/></svg>',
    creator_username: user.creator_username, creator_nickname: user.display_name, comment_disabled: false, max_video_post_duration_sec: 600,
    ...base, ...JSON.parse(process.env.TIKTOK_FAKE_CREATOR || '{}'),
  };
}

/** The documented FILE_UPLOAD rules; returns a problem or ''. */
function checkChunks(si) {
  const MB = 1024 * 1024;
  const { video_size: size, chunk_size: chunk, total_chunk_count: count } = si;
  if (si.source !== 'FILE_UPLOAD') return 'fake supports FILE_UPLOAD only';
  if (!(size > 0 && chunk > 0 && count > 0)) return 'video_size, chunk_size and total_chunk_count are required';
  if (size > 4096 * MB) return 'over 4 GB';
  if (count !== Math.floor(size / chunk)) return 'total_chunk_count must be floor(video_size / chunk_size)';
  if (count > 1000) return 'over 1000 chunks';
  if (size < 5 * MB && (count !== 1 || chunk !== size)) return 'under 5 MB must be one chunk of the whole size';
  if (size > 64 * MB && count < 2) return 'over 64 MB must be several chunks';
  if (count > 1 && (chunk < 5 * MB || chunk > 64 * MB)) return 'chunks must be 5-64 MB';
  const last = size - (count - 1) * chunk;
  if (last > 128 * MB) return 'the last chunk is over 128 MB';
  return '';
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  db.calls.push(`${method} ${url.hostname}${url.pathname}`);
  try {
    // ---------- OAuth ----------
    if (url.href === 'https://open.tiktokapis.com/v2/oauth/token/') {
      if (headers['content-type'] !== 'application/x-www-form-urlencoded') return reply(400, { error: 'invalid_request', error_description: 'form encoding expected', log_id: 'fakelog' });
      const p = new URLSearchParams(String(init.body));
      if (p.get('client_key') !== 'sbawfakeclientkey' || p.get('client_secret') !== 'fakeclientsecret') return reply(401, { error: 'invalid_client', error_description: 'bad client', log_id: 'fakelog' });
      let scope = 'user.info.basic,video.publish,video.upload';
      if (p.get('grant_type') === 'authorization_code') {
        // The test sends code "fakecode~<hex challenge>~<redirect>~<scopes>"
        const [tag, challenge, redirect, granted] = (p.get('code') ?? '').split('~');
        if (tag !== 'fakecode') return reply(400, { error: 'invalid_grant', error_description: 'bad code', log_id: 'fakelog' });
        if (crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('hex') !== challenge) return reply(400, { error: 'invalid_grant', error_description: 'code_verifier does not match the hex SHA-256 challenge', log_id: 'fakelog' });
        if (p.get('redirect_uri') !== redirect) return reply(400, { error: 'invalid_request', error_description: 'Redirect_uri is not matched with the uri when requesting code.', log_id: 'fakelog' });
        scope = granted || scope;
      } else if (p.get('grant_type') === 'refresh_token') {
        if (!db.refresh[p.get('refresh_token')]) return reply(400, { error: 'invalid_grant', error_description: 'refresh token invalid or already rotated', log_id: 'fakelog' });
        delete db.refresh[p.get('refresh_token')]; // rotation: the old one stops working
      } else return reply(400, { error: 'unsupported_grant_type', log_id: 'fakelog' });
      const n = db.next++;
      db.refresh[`rft.fake.${n}`] = true;
      db.access[`act.fake.${n}`] = scope;
      return reply(200, { access_token: `act.fake.${n}`, expires_in: 7200, open_id: 'fake-open-id-rn', refresh_expires_in: 15552000, refresh_token: `rft.fake.${n}`, scope, token_type: 'Bearer' });
    }

    // ---------- upload URL ----------
    if (url.hostname === 'fake-upload.tiktokapis.local' && method === 'PUT') {
      const post = Object.values(db.posts).find((x) => x.upload_id === url.searchParams.get('upload_id'));
      if (!post) return new Response('', { status: 404 });
      if (failWhat === 'upload' && !uploadFailed) { uploadFailed = true; return new Response('', { status: Number(failValue) || 500 }); }
      const m = (headers['content-range'] ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const len = bytes(init.body);
      if (!m || String(len) !== headers['content-length'] || Number(m[2]) - Number(m[1]) + 1 !== len) return new Response('', { status: 400 });
      if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(headers['content-type'])) return new Response('', { status: 400 });
      if (Number(m[3]) !== post.video_size || Number(m[1]) !== post.received) return new Response('', { status: 416 });
      const i = post.chunks_received;
      const expectLen = i === post.total_chunk_count - 1 ? post.video_size - i * post.chunk_size : post.chunk_size;
      if (len !== expectLen) return new Response('', { status: 400 });
      post.received += len;
      post.chunks_received++;
      const done = post.received === post.video_size;
      if (done) post.status = 'PROCESSING_UPLOAD';
      save();
      return new Response('', { status: done ? 201 : 206, headers: { 'Content-Range': `bytes 0-${post.received - 1}/${post.video_size}` } });
    }

    if (url.hostname !== 'open.tiktokapis.com') return err(404, 'not_found', `fake has no ${url.hostname}`);
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const scopes = db.access[token];
    if (!scopes) return err(401, 'access_token_invalid', 'The access token is invalid or not found in the request.');
    const has = (s) => scopes.split(',').includes(s);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = () => headers['content-type'] === 'application/json; charset=UTF-8';

    switch (`${method} ${url.pathname}`) {
      case 'GET /v2/user/info/':
        if (!has('user.info.basic')) return err(401, 'scope_not_authorized');
        return ok({ user: { open_id: 'fake-open-id-rn', display_name: user.display_name, avatar_url: 'https://example.invalid/a.jpg' } });
      case 'POST /v2/post/publish/creator_info/query/':
        if (!has('video.publish')) return err(401, 'scope_not_authorized');
        if (!json()) return err(400, 'invalid_param', 'Content-Type');
        if (failWhat === 'creator') return err(200, failValue);
        return ok(creatorInfo());
      case 'POST /v2/post/publish/video/init/':
      case 'POST /v2/post/publish/inbox/video/init/': {
        const inbox = url.pathname.includes('/inbox/');
        if (!has(inbox ? 'video.upload' : 'video.publish')) return err(401, 'scope_not_authorized');
        if (!json()) return err(400, 'invalid_param', 'Content-Type');
        if (failWhat === 'init') return err(403, failValue);
        const problem = checkChunks(body.source_info ?? {});
        if (problem) return err(400, 'invalid_param', problem);
        const pi = body.post_info ?? {};
        if (inbox) {
          if (body.post_info) return err(400, 'invalid_param', 'fake: the inbox endpoint takes no post_info');
        } else {
          const c = creatorInfo();
          if (!c.privacy_level_options.includes(pi.privacy_level)) return err(403, 'privacy_level_option_mismatch');
          if (unaudited && pi.privacy_level !== 'SELF_ONLY') return err(403, 'unaudited_client_can_only_post_to_private_accounts');
          if ((pi.title ?? '').length > 2200) return err(400, 'invalid_param', 'title too long');
          if (pi.brand_content_toggle && pi.privacy_level === 'SELF_ONLY') return err(400, 'invalid_param', 'branded content cannot be private');
          for (const k of ['disable_comment', 'disable_duet', 'disable_stitch', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc']) if (typeof pi[k] !== 'boolean') return err(400, 'invalid_param', `${k} must be a boolean`);
        }
        const n = db.next++;
        const id = inbox ? `v_inbox_file~v2.fake${n}` : `v_pub_file~v2.fake${n}`;
        db.posts[id] = { inbox, post_info: inbox ? null : pi, ...body.source_info, upload_id: String(n), received: 0, chunks_received: 0, status: 'PROCESSING_UPLOAD', polls: 0, at: Date.now() };
        save();
        return ok({ publish_id: id, upload_url: `https://fake-upload.tiktokapis.local/video/?upload_id=${n}&upload_token=fake` });
      }
      case 'POST /v2/post/publish/status/fetch/': {
        const post = db.posts[body.publish_id];
        if (!post) return err(400, 'invalid_publish_id');
        post.polls++;
        if (post.received === post.video_size && post.polls >= 2) {
          if (failWhat === 'status') { post.status = 'FAILED'; post.fail_reason = failValue; }
          else if (post.inbox) post.status = 'SEND_TO_USER_INBOX';
          else post.status = 'PUBLISH_COMPLETE';
        }
        save();
        const isPublic = post.status === 'PUBLISH_COMPLETE' && post.post_info?.privacy_level === 'PUBLIC_TO_EVERYONE';
        // Like TikTok: a bare 19-digit int64 in the JSON (JSON.parse alone would round it)
        const res = ok({ status: post.status, ...(post.fail_reason && { fail_reason: post.fail_reason }), publicaly_available_post_id: isPublic ? ['__ID__'] : [], uploaded_bytes: post.received });
        return new Response((await res.text()).replace('"__ID__"', `73${String(post.upload_id).padStart(17, '0')}`), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return err(404, 'not_found', `fake has no ${method} ${url.pathname}`);
  } finally {
    save();
  }
};
