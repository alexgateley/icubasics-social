// Offline tests for the TikTok scripts: no TikTok app, no network, no keychain (everything goes through
// scripts/tiktok-fake-api.mjs in throwaway folders under the system temp directory).
//
//   node scripts/tiktok-test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chunkPlan, chunkRanges, parseCaptions, mp4Duration } from './tiktok-api.mjs';
import { challengeOf, makeVerifier } from './tiktok-auth.mjs';
import { validatePost, postInfo } from './tiktok-poster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'tiktok-fake-api.mjs');
const MB = 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/** A file that parses as MP4 (ftyp, moov/mvhd with the duration, then an mdat of filler). */
function fakeMp4(file, seconds, size) {
  const box = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale, after version/flags, creation and modification times
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const head = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0isomavc1', 'latin1')), box('moov', box('mvhd', mvhd))]);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, head);
  const mdat = Buffer.alloc(8);
  mdat.writeUInt32BE(size - head.length);
  mdat.write('mdat', 4, 'latin1');
  fs.writeSync(fd, mdat);
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}

const CAPTIONS = `SHORT: Is it compensated? (about 60 s, vertical 1080x1920)

On every platform: turn on the AI-generated / altered content label (the voice is AI).

════════════════ RN BASICS ════════════════

TIKTOK  (@thernbasics)
Caption:
Is this ABG compensated? Find the cause with ROME. #nclex #ABG

INSTAGRAM REELS  (@rnbasicsnclex)
Caption:
Is this ABG compensated? 3 answers
Second line.
#nclex

════════════════ ICU BASICS ════════════════

INSTAGRAM REELS  (@icubasics)
Caption:
Compensated or not? ICU version.
#icunurse
`;

/** Runs a script under the fake API; resolves { code, out } and lets the caller react to output lines. */
function run(script, args, env, onLine = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', FAKE, path.join(HERE, script), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (d) => { const s = String(d); out += s; for (const line of s.split('\n')) if (line) onLine(line, child); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('exit', (code) => resolve({ code, out, child }));
  });
}

/** Starts the poster on a free port; returns { base, token, stop, call }. */
async function poster(env) {
  let resolveUrl;
  const ready = new Promise((r) => { resolveUrl = r; });
  const done = run('tiktok-poster.mjs', ['--port', '0', '--no-open'], env, (line, child) => {
    const m = line.match(/TikTok poster at (http:\S+)/);
    if (m) resolveUrl({ base: m[1], child });
  });
  const { base, child } = await Promise.race([ready, done.then((r) => { throw new Error(r.out); })]);
  const html = await (await fetch(base)).text();
  const token = html.match(/const TOKEN = '([0-9a-f]+)'/)[1];
  const call = async (p, opts = {}) => {
    const res = await fetch(new URL(p, base), { ...opts, headers: { 'X-Poster-Token': token, 'Content-Type': 'application/json', ...opts.headers } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  return { base, token, call, stop: () => child.kill() };
}

function uploadsFixture(name) {
  const dir = path.join(tmp, name, 'uploads');
  for (const [folder, secs, size] of [['ABG - Compensation', 59.4, 6 * MB], ['Big One', 61, 70 * MB], ['Too Long', 700, 5 * MB + 3]]) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fakeMp4(path.join(dir, folder, 'short - RN Basics.mp4'), secs, size);
    fs.writeFileSync(path.join(dir, folder, 'short - captions and tags.txt'), CAPTIONS);
  }
  fs.mkdirSync(path.join(dir, 'Long video only'), { recursive: true });
  return dir;
}

async function pollUntil(call, account, id, want) {
  for (let i = 0; i < 10; i++) {
    const s = await call(`/api/status?account=${account}&publish_id=${encodeURIComponent(id)}`);
    if (s.json.status === want || s.json.status === 'FAILED') return s.json;
  }
  throw new Error(`never reached ${want}`);
}

// ---------- pure functions ----------

test('chunk plans follow the Media Transfer Guide', () => {
  for (const size of [1, 4 * MB, 5 * MB, 11_256_562, 64 * MB, 64 * MB + 1, 50_000_123 + 64 * MB, 700 * MB, 4096 * MB]) {
    const p = chunkPlan(size);
    const r = chunkRanges(p);
    assert.equal(p.total_chunk_count, Math.floor(size / p.chunk_size));
    assert.equal(r.length, p.total_chunk_count);
    assert.equal(r[0][0], 0);
    assert.equal(r.at(-1)[1], size - 1);
    for (let i = 1; i < r.length; i++) assert.equal(r[i][0], r[i - 1][1] + 1);
    if (size < 5 * MB) assert.deepEqual(p, { video_size: size, chunk_size: size, total_chunk_count: 1 });
    if (size > 64 * MB) assert.ok(p.total_chunk_count > 1 && p.chunk_size >= 5 * MB && p.chunk_size <= 64 * MB);
    assert.ok(r.at(-1)[1] - r.at(-1)[0] + 1 <= 128 * MB);
    assert.ok(p.total_chunk_count <= 1000);
  }
  assert.throws(() => chunkPlan(4096 * MB + 1), /4 GB/);
  assert.throws(() => chunkPlan(0), /empty/);
});

test('PKCE: verifier from the unreserved set, challenge is hex SHA-256', () => {
  const v = makeVerifier();
  assert.match(v, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(challengeOf('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('captions: the TikTok block per brand, Instagram as the fallback', () => {
  const c = parseCaptions(CAPTIONS);
  assert.equal(c.rn.tiktok, 'Is this ABG compensated? Find the cause with ROME. #nclex #ABG');
  assert.equal(c.rn.instagram, 'Is this ABG compensated? 3 answers\nSecond line.\n#nclex');
  assert.equal(c.icu.tiktok, undefined);
  assert.equal(c.icu.instagram, 'Compensated or not? ICU version.\n#icunurse');
  assert.equal(c.aiVoice, true);
  const top = parseCaptions('TIKTOK  (@thernbasics, RN version)\nCaption:\nVasopressors in 60 seconds.\n\n────\nINSTAGRAM REELS  (@icubasics: ICU version · @rnbasicsnclex: RN version)\nCaption:\nShared caption.\n');
  assert.equal(top.rn.tiktok, 'Vasopressors in 60 seconds.');
  assert.equal(top.icu.instagram, 'Shared caption.');
});

test('mp4 duration from mvhd', () => {
  const f = path.join(tmp, 'd.mp4');
  fakeMp4(f, 59.436, 2 * MB);
  assert.equal(mp4Duration(f), 59.436);
});

test('the server refuses everything the Direct Post rules forbid', () => {
  const creator = { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: true, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 60 };
  const short = { size: 6 * MB, duration: 59 };
  const good = { consent: true, mode: 'direct', title: 'x', privacy_level: 'PUBLIC_TO_EVERYONE' };
  assert.deepEqual(validatePost(good, { creator, short }), []);
  const bad = (change, re) => assert.match(validatePost({ ...good, ...change }, { creator, short }).join(' '), re);
  bad({ consent: false }, /pressed Post/);
  bad({ privacy_level: '' }, /no default/);
  bad({ privacy_level: 'MUTUAL_FOLLOW_FRIENDS' }, /not offered/);
  bad({ allow_comment: true }, /Comments are turned off/);
  bad({ commercial: true }, /promotes yourself, a third party, or both/);
  bad({ brand_content: true }, /disclosure setting first/);
  bad({ commercial: true, brand_content: true, privacy_level: 'SELF_ONLY' }, /cannot be set to private/);
  bad({ title: 'a'.repeat(2201) }, /2200/);
  assert.match(validatePost(good, { creator, short: { ...short, duration: 61 } }).join(' '), /up to 60 s/);
  assert.deepEqual(validatePost({ consent: true, mode: 'inbox' }, { creator, short }), []);
  assert.deepEqual(postInfo({ ...good, allow_duet: true, commercial: true, brand_organic: true, is_aigc: true }), {
    title: 'x', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: true, disable_duet: false, disable_stitch: true, brand_organic_toggle: true, brand_content_toggle: false, is_aigc: true,
  });
});

// ---------- sign-in ----------

async function signIn(name, env, { scopes = 'user.info.basic,video.publish,video.upload', args = ['rn'] } = {}) {
  const dir = path.join(tmp, name);
  const port = String(20000 + Math.floor(Math.random() * 20000));
  return run('tiktok-auth.mjs', args, { TIKTOK_FAKE_DIR: dir, TIKTOK_FAKE_SIGNED_OUT: '1', TIKTOK_AUTH_NO_OPEN: '1', TIKTOK_AUTH_PORT: port, ...env }, async (line) => {
    const m = line.match(/^AUTH_URL (\S+)/);
    if (!m) return;
    const u = new URL(m[1]);
    const p = u.searchParams;
    assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.match(p.get('code_challenge'), /^[0-9a-f]{64}$/);
    assert.equal(p.get('scope'), 'user.info.basic,video.publish,video.upload');
    assert.equal(p.get('redirect_uri'), `http://localhost:${port}/callback`);
    const code = `fakecode~${p.get('code_challenge')}~${p.get('redirect_uri')}~${scopes}`;
    await fetch(`${p.get('redirect_uri')}?${new URLSearchParams({ code, scopes, state: p.get('state') })}`);
  }).then((r) => ({ ...r, store: JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')) }));
}

const tokensOf = (store, k = 'TIKTOK_SANDBOX_TOKENS_RN') => (store[k] ? JSON.parse(Buffer.from(store[k].slice(4), 'base64url').toString('utf8')) : null);

test('sign-in stores the right account and never prints a token', async () => {
  const r = await signIn('auth-ok', {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Signed in as TikTok account: RN Basics \(@thernbasics\)/);
  const t = tokensOf(r.store);
  assert.equal(t.username, 'thernbasics');
  assert.match(t.refresh_token, /^rft\.fake\./);
  assert.ok(!r.out.includes(t.refresh_token) && !r.out.includes(t.access_token));
  assert.ok(Date.parse(t.refresh_expires_at) > Date.now() + 179 * 864e5);
});

test('sign-in stores nothing for the wrong account or a missing permission', async () => {
  const wrong = await signIn('auth-wrong', { TIKTOK_FAKE_USER: '{"display_name":"Someone Else","creator_username":"someone"}' });
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /not the RN Basics account; nothing was stored/);
  assert.equal(tokensOf(wrong.store), null);
  const any = await signIn('auth-any', { TIKTOK_FAKE_USER: '{"display_name":"Rhea","creator_username":"rhea"}' }, { args: ['rn', '--any'] });
  assert.equal(any.code, 0, any.out);
  const scope = await signIn('auth-scope', {}, { scopes: 'user.info.basic' });
  assert.equal(scope.code, 1);
  assert.match(scope.out, /not granted.*video\.publish/);
  assert.equal(tokensOf(scope.store), null);
});

// ---------- the posting page ----------

test('poster: Direct Post end to end, refresh rotation, record, guards', async () => {
  const name = 'poster';
  const dir = path.join(tmp, name);
  const p = await poster({ TIKTOK_FAKE_DIR: dir, TIKTOK_UPLOADS_DIR: uploadsFixture(name) });
  try {
    // Guards: no token, wrong Host
    assert.equal((await fetch(new URL('/api/accounts', p.base))).status, 403);
    const { status: hostStatus } = await new Promise((resolve) => {
      import('node:http').then(({ default: http }) => http.get(new URL('/', p.base), { headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve({ status: res.statusCode }); }));
    });
    assert.equal(hostStatus, 403);

    const acc = await p.call('/api/accounts');
    assert.equal(acc.json.accounts.find((a) => a.id === 'rn').signedIn, true);
    const list = await p.call('/api/shorts?account=rn');
    assert.deepEqual(list.json.shorts.map((s) => s.folder), ['ABG - Compensation', 'Big One', 'Too Long']);
    assert.equal(list.json.shorts[0].captionFrom, 'tiktok');
    assert.ok(!('video' in list.json.shorts[0]), 'the file path stays on the server');

    const c = await p.call('/api/creator?account=rn');
    assert.equal(c.json.creator.creator_nickname, 'RN Basics');
    // The expired access token was refreshed with rft.fake.seed, which TikTok then retired
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    assert.notEqual(tokensOf(store).refresh_token, 'rft.fake.seed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).refresh['rft.fake.seed'], undefined);

    const preview = await fetch(new URL(`/video?account=rn&folder=${encodeURIComponent('ABG - Compensation')}`, p.base), { headers: { Range: 'bytes=0-99' } });
    assert.equal(preview.status, 206);
    assert.equal((await preview.arrayBuffer()).byteLength, 100);

    const base = { consent: true, account: 'rn', folder: 'ABG - Compensation', mode: 'direct', title: 'Is this ABG compensated? #nclex', allow_comment: true, is_aigc: true };
    const noPrivacy = await p.call('/api/post', { method: 'POST', body: JSON.stringify(base) });
    assert.equal(noPrivacy.status, 400);
    assert.match(noPrivacy.json.error, /Choose who can view/);
    const tooLong = await p.call('/api/post', { method: 'POST', body: JSON.stringify({ ...base, folder: 'Too Long', privacy_level: 'SELF_ONLY' }) });
    assert.match(tooLong.json.error, /up to 600 s/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).calls.filter((x) => x.includes('/init/')).length, 0, 'nothing reached init');

    const ok = await p.call('/api/post', { method: 'POST', body: JSON.stringify({ ...base, privacy_level: 'PUBLIC_TO_EVERYONE' }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const s = await pollUntil(p.call, 'rn', ok.json.publish_id, 'PUBLISH_COMPLETE');
    assert.equal(s.status, 'PUBLISH_COMPLETE');
    assert.match(s.link, /^https:\/\/www\.tiktok\.com\/@thernbasics\/video\/73\d{17}$/, 'the 19-digit id is exact');
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    const sent = db.posts[ok.json.publish_id];
    assert.equal(sent.received, 6 * MB);
    assert.deepEqual(sent.post_info, { title: base.title, privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true, brand_organic_toggle: false, brand_content_toggle: false, is_aigc: true });
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'posted.json'), 'utf8')).posts['rn/ABG - Compensation'];
    assert.equal(rec.status, 'PUBLISH_COMPLETE');
    assert.equal(rec.link, s.link);

    // A 70 MB file goes up in 7 chunks (206 ×6, then 201) to the inbox
    const inbox = await p.call('/api/post', { method: 'POST', body: JSON.stringify({ consent: true, account: 'rn', folder: 'Big One', mode: 'inbox' }) });
    assert.equal(inbox.status, 200, JSON.stringify(inbox.json));
    const db2 = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(db2.posts[inbox.json.publish_id].chunks_received, 7);
    assert.equal((await pollUntil(p.call, 'rn', inbox.json.publish_id, 'SEND_TO_USER_INBOX')).status, 'SEND_TO_USER_INBOX');
    assert.equal((await p.call('/api/shorts?account=rn')).json.shorts[1].posted.status, 'SEND_TO_USER_INBOX');
  } finally {
    p.stop();
  }
});

test('poster: unaudited app, posting cap, failed processing, retried chunk', async () => {
  const una = await poster({ TIKTOK_FAKE_DIR: path.join(tmp, 'una'), TIKTOK_UPLOADS_DIR: uploadsFixture('una'), TIKTOK_FAKE_UNAUDITED: '1', TIKTOK_FAKE_FAIL: 'upload:500' });
  try {
    const c = await una.call('/api/creator?account=rn');
    assert.ok(!c.json.creator.privacy_level_options.includes('PUBLIC_TO_EVERYONE'));
    assert.equal(c.json.creator.duet_disabled, true);
    const pub = await una.call('/api/post', { method: 'POST', body: JSON.stringify({ consent: true, account: 'rn', folder: 'ABG - Compensation', mode: 'direct', title: 't', privacy_level: 'PUBLIC_TO_EVERYONE' }) });
    assert.equal(pub.status, 400);
    const friends = await una.call('/api/post', { method: 'POST', body: JSON.stringify({ consent: true, account: 'rn', folder: 'ABG - Compensation', mode: 'direct', title: 't', privacy_level: 'MUTUAL_FOLLOW_FRIENDS' }) });
    assert.equal(friends.status, 502);
    assert.match(friends.json.error, /only to a private account, as "Only me"/);
    const self = await una.call('/api/post', { method: 'POST', body: JSON.stringify({ consent: true, account: 'rn', folder: 'ABG - Compensation', mode: 'direct', title: 't', privacy_level: 'SELF_ONLY' }) });
    assert.equal(self.status, 200, JSON.stringify(self.json)); // the first chunk got a 500 and was sent again
    const s = await pollUntil(una.call, 'rn', self.json.publish_id, 'PUBLISH_COMPLETE');
    assert.equal(s.link, '', 'no public post id for Only me');
  } finally { una.stop(); }

  const cap = await poster({ TIKTOK_FAKE_DIR: path.join(tmp, 'cap'), TIKTOK_UPLOADS_DIR: uploadsFixture('cap'), TIKTOK_FAKE_FAIL: 'creator:spam_risk_too_many_posts' });
  try {
    const c = await cap.call('/api/creator?account=rn');
    assert.equal(c.json.cannotPost, true);
    assert.match(c.json.error, /posting limit/);
    const r = await cap.call('/api/post', { method: 'POST', body: JSON.stringify({ consent: true, account: 'rn', folder: 'ABG - Compensation', mode: 'direct', title: 't', privacy_level: 'SELF_ONLY' }) });
    assert.equal(r.status, 409);
  } finally { cap.stop(); }

  const failed = await poster({ TIKTOK_FAKE_DIR: path.join(tmp, 'failed'), TIKTOK_UPLOADS_DIR: uploadsFixture('failed'), TIKTOK_FAKE_FAIL: 'status:frame_rate_check_failed' });
  try {
    const r = await failed.call('/api/post', { method: 'POST', body: JSON.stringify({ consent: true, account: 'rn', folder: 'ABG - Compensation', mode: 'direct', title: 't', privacy_level: 'SELF_ONLY' }) });
    const s = await pollUntil(failed.call, 'rn', r.json.publish_id, 'PUBLISH_COMPLETE');
    assert.equal(s.status, 'FAILED');
    assert.equal(s.fail_reason, 'frame_rate_check_failed');
  } finally { failed.stop(); }

  const out = await poster({ TIKTOK_FAKE_DIR: path.join(tmp, 'out'), TIKTOK_UPLOADS_DIR: uploadsFixture('out'), TIKTOK_FAKE_SIGNED_OUT: '1' });
  try {
    assert.equal((await out.call('/api/creator?account=rn')).json.signedIn, false);
  } finally { out.stop(); }
});

