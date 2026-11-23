// A stand-in for PostHog's query API, for testing posthog.mjs without a key or network:
//
//   ANALYTICS_DIR=/tmp/p node --import ./scripts/posthog-fake-api.mjs scripts/posthog.mjs
//
// Sets POSTHOG_FAKE=1 (posthog.mjs then skips the keychain) and replaces fetch. Each query is answered from its
// `name` (basics-social daily / weekly / newUsers / sites / events) with made-up rows in the shape HogQL returns
// ({ columns, results }), including site visits from Instagram, TikTok and YouTube, which the live sites do not send yet.
// POSTHOG_FAKE_FAIL=401 answers every query with that HTTP status; POSTHOG_FAKE_FAIL_QUERY=newUsers fails only that query (400).
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
  if (name === 'events' || name === 'eventsPlain') {
    const r = (e, p, b, d, c, score = null) => rows.push([e, p, b, d, c, Math.round(c / 4), Math.round(c / 5), Math.round(c / 30), Math.round(c / 6), Math.round(c / 15), score]);
    for (const [e, c] of [['question_answered', 13872], ['answer_rated', 3744], ['app_opened', 1241], ['onboarding_completed', 147], ['rate_link_opened', 12]]) r(e, 'ios', 'rn', '', c);
    r('$pageview', 'site', 'rn', '', 900);
    if (name === 'eventsPlain') {
      const plain = rows.map((x) => [x[0], x[1], x[3], x[4], x[5], x[7]]);
      for (const [tab, c] of [['home', 2100], ['study', 1500], ['reference', 640]]) for (const p of ['ios', 'web']) plain.push(['tab_opened', p, tab, c, Math.round(c / 4), Math.round(c / 30)]);
      return { columns: ['event', 'platform', 'detail', 'n', 'n7', 'n1'], results: plain };
    }
    for (const [tab, c] of [['home', 2100], ['study', 1500], ['reference', 640]]) for (const p of ['ios', 'web']) { r('tab_opened', p, 'rn', tab, c * 0.7); r('tab_opened', p, 'icu', tab, c * 0.3); }
    for (const [mode, c] of [['quick10', 420], ['mock', 120], ['custom', 90], ['case', 60], ['sata', 30]]) { r('quiz_started', 'ios', 'rn', mode, c); r('quiz_completed', 'ios', 'rn', mode, Math.round(c * 0.6), 7.5); }
    for (const [game, c] of [['daily_shift', 300], ['rapid_response', 120], ['clock_out', 80]]) { r('arcade_game_started', 'ios', 'rn', game, c); r('arcade_game_completed', 'ios', 'rn', game, Math.round(c * 0.8), 1240); }
    for (const [d, c] of [['drug/amiodarone', 90], ['drip/norepinephrine', 70], ['calculator/map', 50], ['sheet/acls-algorithms', 45], ['labs/labs', 30]]) r('reference_opened', 'web', 'icu', d, c);
    r('sheet_pdf_opened', 'web', 'icu', 'acls-algorithms', 14);
    r('sheet_shared', 'ios', 'rn', 'acls-algorithms', 3);
    r('$pageview', 'site', 'icu', 'acls-algorithms', 210);
    r('drill_started', 'ios', 'medic', 'med_math', 40);
    return { columns: ['event', 'platform', 'brand', 'detail', 'n', 'n7', 'p7', 'n1', 'users', 'users7', 'avg_score'], results: rows };
  }
  // A newer site with only a links page (no basics-site snippet), as respiratorybasics.com on 2026-11-20
  if (name === 'sites') for (let n = 2; n >= 0; n--) {
    rows.push([day(n), 'respiratorybasics.com', 'rt', '$pageview', 'links', 'instagram', 4]);
    rows.push([day(n), 'respiratorybasics.com', 'rt', 'links_click', 'play', 'instagram', 2]);
    rows.push([day(n), 'respiratorybasics.com', 'rt', 'links_click', 'website', 'instagram', 1]);
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
        // a links page (basics-links) on the old sites too
        if (n < 3) { rows.push([d, SITES[b], b, '$pageview', 'links', 'instagram', 2]); rows.push([d, SITES[b], b, 'links_click', 'family_rt', 'instagram', 1]); }
        continue;
      }
      for (const [p, pw] of Object.entries(PLATFORMS)) {
        const dau = Math.round(6 * bw * pw * grow * (0.8 + rand() * 0.4) * (1 + (lift(n) - 1) * 0.3));
        if (name === 'daily') rows.push([d, b, p, dau, dau + 2, dau * 14, 0, Math.round(dau * 0.8), 0, Math.round(dau / 20), Math.round(dau / 15), Math.round(dau * 0.4), p === 'web' ? Math.round(dau / 6) : 0, Math.round(dau / 25), 0, 0, Math.round(dau / 3), Math.round(dau / 4), Math.round(dau / 2), Math.round(dau / 6), Math.round(dau / 20), Math.round(dau / 40)]);
        if (name === 'weekly') rows.push([d, b, p, Math.round(dau * 3.2)]);
        if (name === 'installs' && p !== 'web') rows.push([d, b, p, Math.round(dau * 0.25 * lift(n))]);
        if (name === 'newUsers') { const f = Math.round(dau * 0.3 * lift(n)); rows.push([d, b, p, f, 0, Math.round(f * 0.7), n > 0 ? Math.round(f * 0.3) : 0]); }
        if (name === 'newUsersPlain') { const f = Math.round(dau * 0.3 * lift(n)); rows.push([d, b, p, f, 0]); }
      }
    }
  }
  const columns = {
    daily: ['day', 'brand', 'platform', 'dau', 'opens', 'answers', 'quizzes', 'quizzes_done', 'mocks', 'mocks_done', 'onboarded', 'drills', 'from_site', 'rate_links', 'review_prompts', 'paywall', 'arcade_plays', 'arcade_done', 'reference_views', 'sheet_views', 'sheet_pdfs', 'sheet_shares'],
    weekly: ['day', 'brand', 'platform', 'wau'],
    newUsers: ['day', 'brand', 'platform', 'first_seen', 'new_users', 'first_quiz', 'day2'],
    newUsersPlain: ['day', 'brand', 'platform', 'first_seen', 'new_users'],
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
  const one = process.env.POSTHOG_FAKE_FAIL_QUERY === name ? 400 : 0;
  const json = fail ? { detail: 'Invalid personal API key.' } : one ? { detail: 'Unknown function' } : answer(name);
  return new Response(JSON.stringify(json), { status: fail || one || 200, headers: { 'Content-Type': 'application/json' } });
};
