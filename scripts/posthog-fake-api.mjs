// A stand-in for PostHog's query API, for testing posthog.mjs without a key or network:
//
//   ANALYTICS_DIR=/tmp/p node --import ./scripts/posthog-fake-api.mjs scripts/posthog.mjs
//
// Sets POSTHOG_FAKE=1 (posthog.mjs then skips the keychain) and replaces fetch. Each query is answered from its
// `name` (basics-social daily / weekly / newUsers / sites / events) with made-up rows in the shape HogQL returns
// ({ columns, results }), including site visits from Instagram, TikTok and YouTube, which the live sites do not send yet.
// POSTHOG_FAKE_FAIL=401 answers every query with that HTTP status.
process.env.POSTHOG_FAKE = '1';
const TZ = 'America/Chicago';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const day = (n) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
let seed = 11;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const BRANDS = { icu: 1, rn: 1.6, medic: 0.6 };
const PLATFORMS = { ios: 1, android: 0.5, web: 1.3 };
const SITES = { icu: 'icubasics.com', rn: 'rnbasics.com', medic: 'medicbasics.com' };
// a post day lifts traffic: every Mon/Wed/Fri plus a spike five days ago
const lift = (n) => 1 + ([1, 3, 5].includes(new Date(`${day(n)}T12:00:00Z`).getUTCDay()) ? 0.5 : 0) + (n === 5 ? 1.5 : 0);

function answer(name) {
  const rows = [];
  if (name === 'sameHour') {
    for (let n = 2; n >= 0; n--) for (const b of Object.keys(BRANDS)) for (const p of Object.keys(PLATFORMS)) rows.push([day(n), b, p, 3 + n, 40 + 5 * n, 3, 0, 1]);
    return { columns: ['day', 'brand', 'platform', 'dau', 'answers', 'quizzes_done', 'mocks_done', 'onboarded'], results: rows };
  }
  if (name === 'events') {
    for (const [e, c] of [['question_answered', 13872], ['answer_rated', 3744], ['app_opened', 1241], ['quiz_completed', 678], ['onboarding_completed', 147], ['$pageview', 900]]) rows.push([e, e === '$pageview' ? 'site' : 'ios', c]);
    return { columns: ['event', 'platform', 'n'], results: rows };
  }
  for (let n = 89; n >= 0; n--) {
    const d = day(n);
    const grow = 0.3 + (89 - n) / 89;
    for (const [b, bw] of Object.entries(BRANDS)) {
      if (name === 'sites') {
        const base = Math.round(20 * bw * grow * lift(n));
        for (const [src, w] of [['instagram', 0.35], ['tiktok', 0.1], ['youtube', 0.08], ['search', 0.3], ['direct', 0.12], ['other', 0.05], ['internal', 0.8]]) {
          const c = Math.round(base * w * (0.7 + rand() * 0.6));
          if (c) rows.push([d, SITES[b], b, '$pageview', '', src, c]);
        }
        rows.push([d, SITES[b], b, 'site_outbound_click', 'app_store', 'internal', Math.round(base * 0.08)]);
        rows.push([d, SITES[b], b, 'site_outbound_click', 'app', 'internal', Math.round(base * 0.05)]);
        continue;
      }
      for (const [p, pw] of Object.entries(PLATFORMS)) {
        const dau = Math.round(6 * bw * pw * grow * (0.8 + rand() * 0.4) * (1 + (lift(n) - 1) * 0.3));
        if (name === 'daily') rows.push([d, b, p, dau, dau + 2, dau * 14, 0, Math.round(dau * 0.8), 0, Math.round(dau / 20), Math.round(dau / 15), Math.round(dau * 0.4), p === 'web' ? Math.round(dau / 6) : 0]);
        if (name === 'weekly') rows.push([d, b, p, Math.round(dau * 3.2)]);
        if (name === 'installs' && p !== 'web') rows.push([d, b, p, Math.round(dau * 0.25 * lift(n))]);
        if (name === 'newUsers') { const f = Math.round(dau * 0.3 * lift(n)); rows.push([d, b, p, f, 0]); }
      }
    }
  }
  const columns = {
    daily: ['day', 'brand', 'platform', 'dau', 'opens', 'answers', 'quizzes', 'quizzes_done', 'mocks', 'mocks_done', 'onboarded', 'drills', 'from_site'],
    weekly: ['day', 'brand', 'platform', 'wau'],
    newUsers: ['day', 'brand', 'platform', 'first_seen', 'new_users'],
    installs: ['day', 'brand', 'platform', 'installs'],
    sites: ['day', 'site', 'brand', 'event', 'kind', 'source', 'n'],
  }[name];
  return { columns, results: rows };
}

globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://us.posthog.com/api/projects/')) throw new Error(`posthog-fake-api: unexpected ${url}`);
  const fail = Number(process.env.POSTHOG_FAKE_FAIL || 0);
  const body = JSON.parse(opts.body);
  const name = String(body.name ?? '').replace('basics-social ', '');
  const json = fail ? { detail: 'Invalid personal API key.' } : answer(name);
  return new Response(JSON.stringify(json), { status: fail || 200, headers: { 'Content-Type': 'application/json' } });
};
