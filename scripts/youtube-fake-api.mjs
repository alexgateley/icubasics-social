// A stand-in for the YouTube and Google OAuth endpoints that youtube-schedule.mjs calls, for testing
// without credentials or network. Load it before the script; nothing reaches Google:
//
//   YT_FAKE_DB=/tmp/yt/db.json YT_STATE=/tmp/yt/uploaded.json \
//     node --import ./scripts/youtube-fake-api.mjs scripts/youtube-schedule.mjs --all
//
// It sets made-up YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN (so the keychain is not read)
// and replaces fetch. The fake channel lives in YT_FAKE_DB (JSON: videos, playlists, calls), so a second
// run sees the first run's uploads. Optional:
//   YT_FAKE_SEED     JSON file with { videos: [{ id, title, privacyStatus, publishAt }], playlists: [titles] }
//                    used when YT_FAKE_DB does not exist yet
//   YT_FAKE_FAIL     "captions:2" fails the 2nd captions.insert of this run (also thumbnail, playlistItem,
//                    insert, update)
//   YT_FAKE_SCOPES   the scopes the token refresh reports (default: all four)
//   YT_FAKE_CHANNEL  the channel the sign-in belongs to: rn (default), rheafi, or other (a third
//                    channel, to test that the scheduler refuses it); with --channel rheafi use rheafi
import fs from 'node:fs';
import path from 'node:path';

const DB = process.env.YT_FAKE_DB;
if (!DB) throw new Error('youtube-fake-api.mjs needs YT_FAKE_DB');
fs.mkdirSync(path.dirname(DB), { recursive: true });
Object.assign(process.env, { YT_CLIENT_ID: 'fake.apps.googleusercontent.com', YT_CLIENT_SECRET: 'fake', YT_REFRESH_TOKEN: 'fake', YT_REFRESH_TOKEN_RHEAFI: 'fake' });
const CHANNEL = {
  rn: { id: 'UCfakeRNBasics', snippet: { title: 'The RN Basics', customUrl: '@thernbasics' }, playlists: ['NCLEX Pharm Explained', 'NCLEX Labs and ECGs Explained', 'Critical Care for Nursing Students', 'NCLEX in 60 Seconds'] },
  rheafi: { id: 'UCy8LlkL5MwWqEeh7Jj3CYow', snippet: { title: 'Rheafi', customUrl: '@rheafi' }, playlists: ['Money stories', 'Shorts', 'Winery Books'] },
  other: { id: 'UCfakeSomeoneElse', snippet: { title: 'Rheafi Fan Page', customUrl: '@rheafifan' }, playlists: [] },
}[process.env.YT_FAKE_CHANNEL ?? 'rn'];
if (!CHANNEL) throw new Error('YT_FAKE_CHANNEL must be rn, rheafi or other');

const seed = process.env.YT_FAKE_SEED ? JSON.parse(fs.readFileSync(process.env.YT_FAKE_SEED, 'utf8')) : {};
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {
  videos: (seed.videos ?? []).map((v) => ({ id: v.id, snippet: { title: v.title }, status: { privacyStatus: v.privacyStatus ?? 'private', publishAt: v.publishAt, embeddable: true, license: 'youtube', publicStatsViewable: true, selfDeclaredMadeForKids: false, containsSyntheticMedia: true } })),
  playlists: (seed.playlists ?? CHANNEL.playlists).map((t, i) => ({ id: `PLfake${i}`, snippet: { title: t }, items: [] })),
  captions: [], calls: [], next: 1,
};
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const [failWhat, failNth] = (process.env.YT_FAKE_FAIL ?? '').split(':');
const counts = {};
const pending = {};

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const err = (status, reason, message) => reply(status, { error: { code: status, message, errors: [{ reason, message }] } });
const page = (items, url) => {
  const start = Number(url.searchParams.get('pageToken') || 0);
  const n = Number(url.searchParams.get('maxResults') || 5);
  return { items: items.slice(start, start + n), ...(start + n < items.length && { nextPageToken: String(start + n) }) };
};
const newId = () => `fake${String(db.next++).padStart(7, '0')}`;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method ?? 'GET').toUpperCase();
  const name = `${method} ${url.hostname}${url.pathname}`;
  const kind = { 'POST /upload/youtube/v3/videos': 'insert', 'POST /upload/youtube/v3/thumbnails/set': 'thumbnail', 'POST /upload/youtube/v3/captions': 'captions', 'POST /youtube/v3/playlistItems': 'playlistItem', 'PUT /youtube/v3/videos': 'update' }[`${method} ${url.pathname}`];
  db.calls.push(`${name}${url.search ? `?${[...url.searchParams.keys()].join(',')}` : ''}`);
  if (kind) {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === failWhat && counts[kind] === Number(failNth)) { save(); return err(500, 'backendError', `fake failure of ${kind} #${failNth}`); }
  }
  const auth = init.headers?.Authorization;
  const json = () => JSON.parse(init.body);

  try {
    if (url.hostname === 'oauth2.googleapis.com') {
      return reply(200, { access_token: 'fake-access', expires_in: 3599, token_type: 'Bearer', scope: process.env.YT_FAKE_SCOPES ?? ['youtube.upload', 'youtube.readonly', 'yt-analytics.readonly', 'youtube.force-ssl'].map((s) => `https://www.googleapis.com/auth/${s}`).join(' ') });
    }
    if (auth !== 'Bearer fake-access') return err(401, 'authError', 'no or wrong bearer token');
    if (url.hostname === 'fake-upload.local' && method === 'PUT') {
      const meta = pending[url.pathname];
      if (!meta) return err(404, 'notFound', 'no such upload session');
      const len = init.body?.length ?? 0;
      if (String(len) !== init.headers['Content-Length']) return err(400, 'badRequest', 'length mismatch');
      const v = { id: newId(), snippet: meta.snippet, status: { ...meta.status, uploadStatus: 'uploaded' }, bytes: len };
      if (v.status.publishAt && v.status.privacyStatus !== 'private') return err(400, 'invalidPublishAt', 'publishAt needs private');
      db.videos.push(v);
      save();
      return reply(200, v);
    }
    switch (`${method} ${url.pathname}`) {
      case 'GET /youtube/v3/channels':
        return reply(200, { items: [{ id: CHANNEL.id, snippet: CHANNEL.snippet, contentDetails: { relatedPlaylists: { uploads: 'UUfake' } }, statistics: { videoCount: String(db.videos.length), subscriberCount: '123' } }] });
      case 'GET /youtube/v3/playlistItems':
        if (url.searchParams.get('playlistId') !== 'UUfake') return err(404, 'playlistNotFound', 'fake: only the uploads playlist is listable');
        return reply(200, page([...db.videos].reverse().map((v) => ({ snippet: { title: v.snippet.title, resourceId: { videoId: v.id } } })), url));
      case 'GET /youtube/v3/playlists':
        return reply(200, page(db.playlists.map(({ id, snippet }) => ({ id, snippet })), url));
      case 'GET /youtube/v3/videos': {
        const ids = url.searchParams.get('id').split(',');
        return reply(200, { items: db.videos.filter((v) => ids.includes(v.id)).map(({ id, snippet, status }) => ({ id, snippet, status })) });
      }
      case 'POST /upload/youtube/v3/videos': {
        const meta = json();
        if (url.searchParams.get('uploadType') !== 'resumable') return err(400, 'badRequest', 'expected resumable');
        if (!meta.snippet?.title || meta.snippet.categoryId !== '27') return err(400, 'invalidCategoryId', 'fake: title and category 27 expected');
        if (meta.status.publishAt && Date.parse(meta.status.publishAt) < Date.parse(process.env.YT_NOW ?? new Date().toISOString())) return err(400, 'invalidPublishAt', 'in the past');
        const session = `/session/${Object.keys(pending).length + 1}`;
        pending[session] = meta;
        return reply(200, {}, { Location: `https://fake-upload.local${session}` });
      }
      case 'POST /upload/youtube/v3/thumbnails/set': {
        const v = db.videos.find((x) => x.id === url.searchParams.get('videoId'));
        if (!v) return err(404, 'videoNotFound', 'no video');
        v.thumbnailBytes = init.body.length;
        save();
        return reply(200, { items: [{ default: { url: 'https://i.ytimg.com/fake.jpg' } }] });
      }
      case 'POST /upload/youtube/v3/captions': {
        const body = Buffer.from(init.body).toString('utf8');
        const boundary = init.headers['Content-Type'].match(/boundary=(.+)$/)[1];
        const parts = body.split(`--${boundary}`);
        const snippet = JSON.parse(parts[1].split('\r\n\r\n')[1]).snippet;
        if (!snippet.videoId || snippet.language !== 'en' || snippet.isDraft !== false) return err(400, 'invalidMetadata', 'bad snippet');
        if (!/-->/.test(parts[2])) return err(400, 'invalidFile', 'not an srt');
        const id = `cap${db.next++}`;
        db.captions.push({ id, snippet, bytes: parts[2].length });
        save();
        return reply(200, { id, snippet });
      }
      case 'POST /youtube/v3/playlistItems': {
        const { snippet } = json();
        const p = db.playlists.find((x) => x.id === snippet.playlistId);
        if (!p) return err(404, 'playlistNotFound', 'no playlist');
        p.items.push(snippet.resourceId.videoId);
        save();
        return reply(200, { id: `PI${db.next++}`, snippet });
      }
      case 'PUT /youtube/v3/videos': {
        const body = json();
        const v = db.videos.find((x) => x.id === body.id);
        if (!v) return err(404, 'videoNotFound', 'no video');
        if (url.searchParams.get('part') !== 'status') return err(400, 'badRequest', 'fake expects part=status');
        if (v.status.privacyStatus !== 'private') return err(400, 'invalidPublishAt', 'already published');
        if (body.status.privacyStatus !== 'private') return err(400, 'invalidPublishAt', 'publishAt needs private');
        // Like YouTube: writable status fields left out are cleared
        v.status = { uploadStatus: v.status.uploadStatus, ...body.status };
        save();
        return reply(200, { id: v.id, status: v.status });
      }
    }
    return err(404, 'notFound', `fake has no ${name}`);
  } finally {
    save();
  }
};
