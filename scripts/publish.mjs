// Publishes today's Question of the Day carousel to Instagram through the Instagram API.
//
//   node scripts/publish.mjs            # post today's carousel (only at 7 AM America/Chicago)
//   node scripts/publish.mjs refresh    # refresh the long-lived token, write it to new-token.txt
//   node scripts/publish.mjs check      # verify the token, the account and the publishing quota
//
// Environment:
//   IG_ACCESS_TOKEN   long-lived token from the Meta app dashboard (Instagram API with Instagram Login)
//   IG_USER_ID        the Instagram professional account id shown next to the token
//   PAGES_BASE_URL    where posts/ is served, e.g. https://alexgateley.github.io/icubasics-social
//   POST_DATE         optional YYYY-MM-DD to post a specific day and skip the time-of-day check
//   DRY_RUN           "true" to log what would be posted without calling the API
import fs from 'node:fs';
import path from 'node:path';

const TZ = 'America/Chicago';
const POST_HOUR = 7;
const GRAPH = 'https://graph.instagram.com';

const token = process.env.IG_ACCESS_TOKEN;
const userId = process.env.IG_USER_ID;
const base = (process.env.PAGES_BASE_URL || '').replace(/\/$/, '');
const forcedDate = process.env.POST_DATE || '';
const dryRun = process.env.DRY_RUN === 'true';

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

async function api(endpoint, params = {}, method = 'POST') {
  const url = new URL(`${GRAPH}/${endpoint}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${endpoint}: ${JSON.stringify(json.error ?? json)}`);
  return json;
}

const localParts = (date = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false })
      .formatToParts(date).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
};

async function refreshToken() {
  if (!token) fail('IG_ACCESS_TOKEN is not set');
  const res = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
  const json = await res.json();
  if (!res.ok || json.error) {
    // Tokens under 24 hours old can't be refreshed yet; that's fine
    console.log(`Token not refreshed: ${JSON.stringify(json.error ?? json)}`);
    return;
  }
  fs.writeFileSync('new-token.txt', json.access_token);
  console.log(`Token refreshed; valid for ${Math.round(json.expires_in / 86400)} more days`);
}

// Read-only: proves the token, the user id and the content-publishing permission all work
async function checkAccess() {
  if (!token || !userId) fail('IG_ACCESS_TOKEN and IG_USER_ID must be set');
  const me = await api('me', { fields: 'user_id,username' }, 'GET');
  const limit = await api(`${userId}/content_publishing_limit`, { fields: 'quota_usage,config' }, 'GET');
  const q = limit.data?.[0] ?? {};
  console.log(`Token OK for @${me.username} (${me.user_id}); posts used in the last 24 h: ${q.quota_usage ?? '?'} of ${q.config?.quota_total ?? '?'}`);
}

async function publishToday() {
  const now = localParts();
  const date = forcedDate || now.date;
  // GitHub schedules often fire hours late, so post any time from POST_HOUR onward; the marker in
  // published/ keeps a day from posting twice.
  if (!forcedDate && !dryRun && now.hour < POST_HOUR) {
    console.log(`It is ${now.hour}:00 in ${TZ}; posting happens from ${POST_HOUR}:00. Nothing to do.`);
    return;
  }
  const marker = path.join('published', `${date}.json`);
  if (fs.existsSync(marker)) {
    console.log(`${date} was already posted (${marker}). Nothing to do.`);
    return;
  }
  const index = JSON.parse(fs.readFileSync(path.join('posts', 'index.json'), 'utf8'));
  const folder = index[date];
  if (!folder) {
    console.log(`No post prepared for ${date}. Run push-month.sh in the app repo to add more days.`);
    return;
  }
  const caption = fs.readFileSync(path.join('posts', folder, 'caption.txt'), 'utf8').trim();
  const slides = ['1-question.jpg', '2-answer.jpg'].map((f) => `${base}/posts/${folder}/${f}`);
  console.log(`Posting ${date} from ${folder}`);
  slides.forEach((s) => console.log(`  ${s}`));

  if (dryRun) { console.log('DRY RUN: not calling the API.'); return; }
  if (!token || !userId || !base) fail('IG_ACCESS_TOKEN, IG_USER_ID and PAGES_BASE_URL must all be set');

  // Make sure the images are actually reachable before creating containers
  for (const s of slides) {
    const head = await fetch(s, { method: 'HEAD' });
    if (!head.ok) fail(`Image not reachable (${head.status}): ${s}. Has GitHub Pages finished deploying?`);
  }

  const children = [];
  for (const image_url of slides) {
    const { id } = await api(`${userId}/media`, { image_url, is_carousel_item: 'true' });
    children.push(id);
  }
  const { id: creationId } = await api(`${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });

  // The container is processed asynchronously; wait until it is ready
  for (let i = 0; i < 20; i++) {
    const { status_code: status } = await api(creationId, { fields: 'status_code' }, 'GET');
    if (status === 'FINISHED') break;
    if (status === 'ERROR') fail('Instagram reported an error processing the carousel');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { id: mediaId } = await api(`${userId}/media_publish`, { creation_id: creationId });

  fs.mkdirSync('published', { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ date, folder, mediaId, postedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Published: media id ${mediaId}`);
}

const mode = process.argv[2] ?? 'post';
(mode === 'refresh' ? refreshToken() : mode === 'check' ? checkAccess() : publishToday()).catch((e) => fail(e.message));
