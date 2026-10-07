// Publishes today's Question of the Day to Instagram through the Instagram API: the Reel
// (reel.mp4), and on Sundays the weekly recap carousel (recaps/<date>/: a cover plus the week's
// answer slides). Since 2026-10-07 the daily two-slide carousel is no longer posted (Reels get the
// reach; the recap keeps a saveable picture post once a week). Each post has its own marker file,
// so a run posts whichever is still missing.
//
//   node scripts/publish.mjs            # post today's carousel and Reel (from 7 AM America/Chicago)
//   node scripts/publish.mjs refresh    # refresh the long-lived token, write it to new-token.txt
//   node scripts/publish.mjs check      # verify the token, the account and the publishing quota
//   KIND=feature node scripts/publish.mjs   # post today's feature Reel (from 6 PM America/Chicago)
//
// Environment:
//   IG_ACCESS_TOKEN   long-lived token from the Meta app dashboard (Instagram API with Instagram Login)
//   IG_USER_ID        the Instagram professional account id shown next to the token
//   BRAND             icu (default, posts/ and published/) or rn (posts-rn/ and published-rn/)
//   PAGES_BASE_URL    where posts/ is served, e.g. https://alexgateley.github.io/icubasics-social
//   POST_DATE         optional YYYY-MM-DD to post a specific day and skip the time-of-day check
//   DRY_RUN           "true" to log what would be posted without calling the API
//   POST_REELS        "false" to post the carousel only
//   KIND              "feature" posts the evening feature Reel from features/<brand>/ (schedule.json maps
//                     each date to a folder with reel.mp4 and caption.txt) instead of the Question of the Day
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
const brand = process.env.BRAND || 'icu';
const postsDir = brand === 'icu' ? 'posts' : `posts-${brand}`;
const publishedDir = brand === 'icu' ? 'published' : `published-${brand}`;

const postReels = process.env.POST_REELS !== 'false';
const kind = process.env.KIND || 'qotd';
const FEATURE_HOUR = 18;
const featuresDir = `features/${brand}`;

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const index = JSON.parse(fs.readFileSync(path.join(postsDir, 'index.json'), 'utf8'));
  const folder = index[date];
  if (!folder) {
    console.log(`No ${brand} post prepared for ${date}. Run push-month.sh in the app repo to add more days.`);
    return;
  }
  if (!dryRun && (!token || !userId || !base)) fail('IG_ACCESS_TOKEN, IG_USER_ID and PAGES_BASE_URL must all be set');
  const caption = fs.readFileSync(path.join(postsDir, folder, 'caption.txt'), 'utf8').trim();

  // The carousel and the Reel are independent: one failing must not stop the other, and whatever
  // was posted keeps its marker so the next run only retries what is missing
  const errors = [];
  for (const [name, post] of [['carousel', postCarousel], ['reel', postReel]]) {
    try {
      await post({ date, folder, caption });
    } catch (e) {
      console.error(`ERROR (${name}): ${e.message}`);
      errors.push(name);
    }
  }
  if (errors.length) process.exit(1);
}

function writeMarker(marker, data) {
  fs.mkdirSync(publishedDir, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ ...data, postedAt: new Date().toISOString() }, null, 2) + '\n');
}

async function assertReachable(url) {
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`Not reachable (${head.status}): ${url}. Has GitHub Pages finished deploying?`);
}

/** Waits until Instagram has processed a media container. */
async function waitForContainer(creationId, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    const { status_code: status } = await api(creationId, { fields: 'status_code' }, 'GET');
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram reported ${status} while processing the upload`);
    await sleep(delayMs);
  }
  throw new Error('Instagram did not finish processing the upload in time');
}

async function postCarousel({ date }) {
  const recapDir = path.join(postsDir, 'recaps', date);
  if (!fs.existsSync(path.join(recapDir, 'slides.json'))) {
    console.log(`No weekly recap for ${date} (recaps post on Sundays).`);
    return;
  }
  const marker = path.join(publishedDir, `${date}.json`);
  if (fs.existsSync(marker)) {
    console.log(`${date} weekly recap was already posted (${marker}).`);
    return;
  }
  const caption = fs.readFileSync(path.join(recapDir, 'caption.txt'), 'utf8').trim();
  const slides = JSON.parse(fs.readFileSync(path.join(recapDir, 'slides.json'), 'utf8'))
    .map((f) => `${base}/${postsDir}/recaps/${date}/${f}`);
  console.log(`Posting ${brand} ${date} weekly recap (${slides.length} slides)`);
  slides.forEach((s) => console.log(`  ${s}`));
  if (dryRun) { console.log('DRY RUN: not calling the API.'); return; }

  // Make sure the images are actually reachable before creating containers
  for (const s of slides) await assertReachable(s);
  const children = [];
  for (const image_url of slides) {
    const { id } = await api(`${userId}/media`, { image_url, is_carousel_item: 'true' });
    children.push(id);
  }
  const { id: creationId } = await api(`${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
  await waitForContainer(creationId, 20, 3000);
  const { id: mediaId } = await api(`${userId}/media_publish`, { creation_id: creationId });
  writeMarker(marker, { date, mediaId, kind: 'recap' });
  console.log(`Published weekly recap: media id ${mediaId}`);
}

async function postReel({ date, folder, caption }) {
  if (!postReels) return;
  if (!fs.existsSync(path.join(postsDir, folder, 'reel.mp4'))) {
    console.log(`No Reel prepared for ${date} (${folder}/reel.mp4).`);
    return;
  }
  const marker = path.join(publishedDir, `${date}-reel.json`);
  if (fs.existsSync(marker)) {
    console.log(`${date} Reel was already posted (${marker}).`);
    return;
  }
  const video_url = `${base}/${postsDir}/${folder}/reel.mp4`;
  // The carousel's caption tells people to swipe; the video shows the answer itself
  const reelCaption = caption.replace(/^Swipe for the answer and the rationale.*$/m, 'You get 15 seconds, then the answer and the rationale ⏱️');
  console.log(`Posting ${brand} ${date} Reel\n  ${video_url}`);
  if (dryRun) { console.log('DRY RUN: not calling the API.'); return; }

  await assertReachable(video_url);
  const { id: creationId } = await api(`${userId}/media`, { media_type: 'REELS', video_url, caption: reelCaption, share_to_feed: 'true' });
  // Video is transcoded before it can be published, which takes longer than images
  await waitForContainer(creationId, 60, 5000);
  const { id: mediaId } = await api(`${userId}/media_publish`, { creation_id: creationId });
  writeMarker(marker, { date, folder, mediaId, kind: 'reel' });
  console.log(`Published Reel: media id ${mediaId}`);
}

// The evening feature Reel: a short screen recording of one app feature, rotated by date
async function publishFeature() {
  const now = localParts();
  const date = forcedDate || now.date;
  if (!forcedDate && !dryRun && now.hour < FEATURE_HOUR) {
    console.log(`It is ${now.hour}:00 in ${TZ}; feature Reels post from ${FEATURE_HOUR}:00. Nothing to do.`);
    return;
  }
  const schedulePath = path.join(featuresDir, 'schedule.json');
  if (!fs.existsSync(schedulePath)) { console.log(`No feature Reels prepared for ${brand}.`); return; }
  const folder = JSON.parse(fs.readFileSync(schedulePath, 'utf8'))[date];
  if (!folder) { console.log(`No ${brand} feature Reel scheduled for ${date}.`); return; }
  const marker = path.join(publishedDir, `${date}-feature.json`);
  if (fs.existsSync(marker)) { console.log(`${date} feature Reel was already posted (${marker}).`); return; }
  if (!dryRun && (!token || !userId || !base)) fail('IG_ACCESS_TOKEN, IG_USER_ID and PAGES_BASE_URL must all be set');
  const caption = fs.readFileSync(path.join(featuresDir, folder, 'caption.txt'), 'utf8').trim();
  const video_url = `${base}/${featuresDir}/${folder}/reel.mp4`;
  console.log(`Posting ${brand} ${date} feature Reel (${folder})\n  ${video_url}`);
  if (dryRun) { console.log('DRY RUN: not calling the API.'); return; }

  await assertReachable(video_url);
  const { id: creationId } = await api(`${userId}/media`, { media_type: 'REELS', video_url, caption, share_to_feed: 'true' });
  await waitForContainer(creationId, 60, 5000);
  const { id: mediaId } = await api(`${userId}/media_publish`, { creation_id: creationId });
  writeMarker(marker, { date, folder, mediaId, kind: 'feature' });
  console.log(`Published feature Reel: media id ${mediaId}`);
}

const mode = process.argv[2] ?? 'post';
(mode === 'refresh' ? refreshToken() : mode === 'check' ? checkAccess() : kind === 'feature' ? publishFeature() : publishToday()).catch((e) => fail(e.message));
