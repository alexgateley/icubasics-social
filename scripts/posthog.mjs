// PostHog numbers for the three Basics apps and the Basics websites (all nine), for the Basics Social app's "App usage" tab.
// Runs ONLY on Alex's Mac: from Basics Social's 2 AM job (helper/nightly.sh, PULL=posthog) or its App data link (usage is metered):
// this repository is public, so nothing here writes into it. Every call is a read (HogQL query API) with a
// read-only personal API key from the login keychain (service icubasics-social, items POSTHOG_PERSONAL_API_KEY
// and POSTHOG_PROJECT_ID; store them with sh scripts/setup-keychain.sh posthog). The key is sent only in the
// Authorization header and never logged.
//
//   node scripts/posthog.mjs                   # fetch: 90 days on the first run, then the last 14 days again
//   node scripts/posthog.mjs --if-stale 3      # only when the last fetch is over 3 hours old (the app's Refresh)
//   POSTHOG_DAYS=90 node scripts/posthog.mjs   # refetch a longer window
//   ANALYTICS_DIR=/tmp/p node --import ./scripts/posthog-fake-api.mjs scripts/posthog.mjs   # made-up answers, no network
//
// What the apps and sites send (QuizApp src/utils/analytics.ts, scripts/sheets/siteAnalytics.ts, checked 2026-11-04):
//   Apps: every event carries brand (icu, rn, medic) and platform (ios, android, web) as super properties. A device
//   is one random distinct_id (no accounts), so active users = distinct ids. app_opened (days_since_install, and on
//   the web from=<site page> when a site link opened the web app), question_answered, quiz_started (mode: mock,
//   qotd, quick10, ...), quiz_completed (mode), mock_completed, onboarding_completed, drill_answered, ...; the phones also send
//   posthog-react-native's lifecycle events (Application Opened, Application Installed, ...). Names starting with $
//   ($exception, $screen) do not count as activity. Application Installed has no brand (it fires before the brand
//   is registered): installs take the brand from its $app_namespace (com.alex.icubasics, .rnbasics, .medicbasics) and
//   the platform from $os. New users are devices seen for the first time (phones and web).
//   Live on 2026-11-04 (first query): web app events since 2026-10-09, phones since 2026-10-19, so the first days
//   count existing users as first seen. quiz_started, days_since_install and the site snippet are in the code
//   (2026-11-03) but not yet in any release or on the live sites: their columns stay 0 until they ship.
//   Sites: $pageview and site_outbound_click (kind app_store, play, app) with $lib basics-site, brand and site
//   (icubasics.com, rnbasics.com, medicbasics.com). The page's address is sent without its query; the source is
//   the utm_source event property when a page view has one (bio and story links carry ?utm_source=instagram...;
//   the site snippet must send it as a property, which it does not yet as of 2026-11-15), else $referring_domain
//   ($direct when there is none). The id is random per page view,
//   so a "visit" here is a page view that came from outside the site (a landing), not a unique visitor.
//   Links pages (<site>/links/, the Instagram bio link, on all nine Basics sites since 2026-11-18): $pageview and
//   links_click (link: app_store, play, website, family_<brand>, ...) with $lib basics-links, brand and site. They are
//   the only tracking on respiratorybasics.com, erbasics.com, ekgtechbasics.com, npbasics.com, pharmtechbasics.com
//   and medlabbasics.com, which have no basics-site snippet yet (checked 2026-11-20). A links page view counts as a
//   page view (linksViews says how many were); its store buttons count as storeClicks, the others as linkClicks.
//
// Store (ANALYTICS_DIR, default ~/basics-growth-work/analytics/):
//   posthog.jsonl        one line per day per app (kind "app": brand, platform; dau, wau, firstSeen = new users,
//                        installs, answers, quizzesDone, mocksDone, onboarded, ...) and per site (kind "site"); a
//                        refetched day replaces its lines
//   posthog-state.json   no secrets: when and how the last fetch went, the window, the events seen in the
//                        last 30 days with their counts (n = 30 days, n7 = 7 days, n1 = 24 hours), screens (tab_opened
//                        by tab, same counts; for the PostHog tab's top screens), and sameHour (today, yesterday and the day before, each up to
//                        the time of the fetch, for "today so far vs yesterday at this hour")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecret } from './keychain.mjs';

const HOST = 'https://us.posthog.com';
const TZ = 'America/Chicago';
const DIR = process.env.ANALYTICS_DIR || path.join(os.homedir(), 'basics-growth-work/analytics');
const FIRST_DAYS = 90;
const RECENT_DAYS = Number(process.env.POSTHOG_DAYS || 14);
const SETUP = 'sh ~/.gemini/antigravity-ide/scratch/icubasics-social-ext/scripts/setup-keychain.sh posthog';
const file = (n) => path.join(DIR, n);
const log = (m) => console.log(`${new Date().toISOString()} posthog: ${m}`);
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// Personal API keys start phx_; never let one reach a log line
const scrub = (s) => String(s).replace(/ph[xc]_[A-Za-z0-9]{10,}/g, '…');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Seconds since midnight in Chicago, now */
const secondsNow = () => { const [h, m, sec] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number); return h * 3600 + m * 60 + sec; };
const DAY = `toDate(toTimeZone(timestamp, '${TZ}'))`;
// Google Play's pre-launch test devices install every upload (about 5 per app); they are not people
const NOT_ROBOT = `coalesce(properties.$device_name, '') NOT IN ('OnePlus8Pro', 'sdk_gphone_arm64')`;
const APP = `properties.brand IN ('icu', 'rn', 'medic', 'er', 'rt', 'ekg', 'np', 'pharm', 'lab') AND properties.platform IN ('ios', 'android', 'web') AND event NOT LIKE '$%' AND ${NOT_ROBOT}`;
// Referrer → source. Android apps arrive as android-app://<package> (TikTok's is com.zhiliaoapp.musically).
// A tagged link's utm_source ("instagram", "tiktok", "youtube") wins over the referrer, which in-app browsers often leave out.
export const SITE_SOURCE_INPUT = `lower(coalesce(nullIf(properties.utm_source, ''), properties.$referring_domain, ''))`;
export const SOURCE = `multiIf(
  r = '' OR r = '$direct', 'direct',
  r = site OR r = concat('www.', site), 'internal',
  r LIKE '%instagram%', 'instagram',
  r LIKE '%tiktok%' OR r LIKE '%musically%', 'tiktok',
  r LIKE '%youtube%' OR r LIKE '%youtu.be%', 'youtube',
  r LIKE '%google%' OR r LIKE '%bing.%' OR r LIKE '%duckduckgo%' OR r LIKE '%yahoo%' OR r LIKE '%ecosia%' OR r LIKE '%search.brave%' OR r LIKE '%yandex%' OR r LIKE '%baidu%', 'search',
  'other')`;

export const queries = (days) => {
  const from = addDays(today, -days + 1);
  const since = `timestamp >= toDateTime('${addDays(from, -1)} 00:00:00')`;
  return {
    daily: `SELECT ${DAY} AS day, properties.brand AS brand, properties.platform AS platform,
        count(DISTINCT distinct_id) AS dau,
        countIf(event = 'app_opened') AS opens,
        countIf(event = 'question_answered') AS answers,
        countIf(event = 'quiz_started') AS quizzes,
        countIf(event = 'quiz_completed') AS quizzes_done,
        countIf(event = 'quiz_started' AND properties.mode = 'mock') AS mocks,
        countIf(event = 'mock_completed') AS mocks_done,
        countIf(event = 'onboarding_completed') AS onboarded,
        countIf(event = 'drill_answered') AS drills,
        countIf(event = 'app_opened' AND coalesce(properties.from, '') != '') AS from_site,
        countIf(event = 'rate_link_opened') AS rate_links,
        countIf(event LIKE '%review_prompt%') AS review_prompts,
        countIf(event LIKE '%paywall%') AS paywall
      FROM events WHERE ${since} AND ${APP}
      GROUP BY day, brand, platform HAVING day >= toDate('${from}') ORDER BY day LIMIT 50000`,
    // Each event counts toward its own day and the six after it: distinct devices over the 7 days ending on `day`
    weekly: `SELECT addDays(${DAY}, n) AS day, properties.brand AS brand, properties.platform AS platform, count(DISTINCT distinct_id) AS wau
      FROM events ARRAY JOIN [0, 1, 2, 3, 4, 5, 6] AS n
      WHERE timestamp >= toDateTime('${addDays(from, -7)} 00:00:00') AND ${APP}
      GROUP BY day, brand, platform HAVING day >= toDate('${from}') AND day <= toDate('${today}') ORDER BY day LIMIT 50000`,
    // A device's first event ever; "new" when its app_opened that day says days_since_install 0 (devices from before
    // analytics was switched on have older installs, so they are first_seen but not new). The same pass gives the
    // first-run funnel (2026-11-23, PostHog tab): first_quiz = of those devices, how many ever answered a question or
    // started a quiz; day2 = how many came back the next calendar day (Chicago)
    newUsers: `SELECT toDate(toTimeZone(first, '${TZ}')) AS day, brand, platform, count() AS first_seen, countIf(fresh > 0) AS new_users,
        countIf(quizzed > 0) AS first_quiz, countIf(has(days, addDays(toDate(toTimeZone(first, '${TZ}')), 1))) AS day2
      FROM (SELECT distinct_id, min(timestamp) AS first, argMin(properties.brand, timestamp) AS brand, argMin(properties.platform, timestamp) AS platform,
          countIf(event = 'app_opened' AND toFloat(properties.days_since_install) = 0) AS fresh,
          countIf(event IN ('question_answered', 'quiz_started')) AS quizzed,
          groupUniqArray(${DAY}) AS days
        FROM events WHERE timestamp >= toDateTime('2026-06-01 00:00:00') AND ${APP} GROUP BY distinct_id)
      WHERE day >= toDate('${from}') GROUP BY day, brand, platform ORDER BY day LIMIT 50000`,
    // The query above without the funnel, asked only if that one fails, so new users never go missing for a night
    newUsersPlain: `SELECT toDate(toTimeZone(first, '${TZ}')) AS day, brand, platform, count() AS first_seen, countIf(fresh > 0) AS new_users
      FROM (SELECT distinct_id, min(timestamp) AS first, argMin(properties.brand, timestamp) AS brand, argMin(properties.platform, timestamp) AS platform,
          countIf(event = 'app_opened' AND toFloat(properties.days_since_install) = 0) AS fresh
        FROM events WHERE timestamp >= toDateTime('2026-06-01 00:00:00') AND ${APP} GROUP BY distinct_id)
      WHERE day >= toDate('${from}') GROUP BY day, brand, platform ORDER BY day LIMIT 50000`,
    // posthog-react-native's first launch after an install. It fires before the brand is registered, so the brand
    // comes from the app's bundle id ($app_namespace) and the platform from $os (iOS and iPadOS are ios)
    installs: `SELECT ${DAY} AS day,
        multiIf(properties.$app_namespace LIKE '%icubasics%', 'icu', properties.$app_namespace LIKE '%rnbasics%', 'rn', properties.$app_namespace LIKE '%medicbasics%', 'medic', properties.$app_namespace LIKE '%erbasics%', 'er', properties.$app_namespace LIKE '%respiratorybasics%', 'rt', properties.$app_namespace LIKE '%ekgtechbasics%', 'ekg', properties.$app_namespace LIKE '%npbasics%', 'np', properties.$app_namespace LIKE '%pharmtechbasics%', 'pharm', properties.$app_namespace LIKE '%medlabbasics%', 'lab', '') AS brand,
        if(properties.$os = 'Android', 'android', 'ios') AS platform, count() AS installs
      FROM events WHERE ${since} AND event = 'Application Installed' AND ${NOT_ROBOT}
      GROUP BY day, brand, platform HAVING day >= toDate('${from}') AND brand != '' ORDER BY day LIMIT 50000`,
    // kind: site_outbound_click's kind; links_click's link (app_store, play, website, family_<brand>, ...); 'links' for a
    // page view of a /links page (basics-links), so those can be told apart from the rest of the site
    sites: `SELECT day, site, brand, event, kind, source, count() AS n FROM (
        SELECT ${DAY} AS day, properties.site AS site, properties.brand AS brand, event,
          if(event = '$pageview', if(properties.$lib = 'basics-links', 'links', ''), coalesce(nullIf(properties.kind, ''), properties.link, '')) AS kind,
          ${SITE_SOURCE_INPUT} AS r, ${SOURCE} AS source
        FROM events WHERE ${since} AND properties.$lib IN ('basics-site', 'basics-links') AND event IN ('$pageview', 'site_outbound_click', 'links_click'))
      WHERE day >= toDate('${from}') GROUP BY day, site, brand, event, kind, source ORDER BY day LIMIT 50000`,
    // Today, yesterday and the day before, each counted only up to the current time of day (Chicago), so today so far
    // can be compared with yesterday at the same hour
    sameHour: `SELECT ${DAY} AS day, properties.brand AS brand, properties.platform AS platform,
        count(DISTINCT distinct_id) AS dau,
        countIf(event = 'question_answered') AS answers,
        countIf(event = 'quiz_completed') AS quizzes_done,
        countIf(event = 'mock_completed') AS mocks_done,
        countIf(event = 'onboarding_completed') AS onboarded
      FROM events WHERE timestamp >= toDateTime('${addDays(today, -3)} 00:00:00') AND ${APP}
        AND toHour(toTimeZone(timestamp, '${TZ}')) * 3600 + toMinute(toTimeZone(timestamp, '${TZ}')) * 60 + toSecond(toTimeZone(timestamp, '${TZ}')) <= ${secondsNow()}
      GROUP BY day, brand, platform HAVING day >= toDate('${addDays(today, -2)}') ORDER BY day LIMIT 1000`,
    // Every event in the last 30 days with its 7-day and 24-hour counts; tab_opened split by tab (top screens)
    events: `SELECT event, coalesce(properties.platform, if(properties.$lib = 'basics-site', 'site', '')) AS platform,
        if(event = 'tab_opened', coalesce(properties.tab, ''), '') AS tab,
        count() AS n, countIf(timestamp >= now() - INTERVAL 7 DAY) AS n7, countIf(timestamp >= now() - INTERVAL 1 DAY) AS n1
      FROM events WHERE timestamp >= now() - INTERVAL 30 DAY GROUP BY event, platform, tab ORDER BY n DESC LIMIT 600`,
  };
};

async function query(project, key, name, sql) {
  const res = await fetch(`${HOST}/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, name: `basics-social ${name}` }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || json.error) throw new Error(`${name}: HTTP ${res.status} ${json.detail ?? json.error ?? ''}`.trim());
  const cols = json.columns ?? [];
  return (json.results ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

const num = (v) => Number(v) || 0;

/** Query rows → store lines for the days fetched. */
export function toLines({ daily, weekly, newUsers, installs, sites }) {
  const apps = new Map();
  const app = (r) => {
    const k = `${String(r.day).slice(0, 10)}|${r.brand}|${r.platform}`;
    if (!apps.has(k)) apps.set(k, { date: String(r.day).slice(0, 10), kind: 'app', brand: r.brand, platform: r.platform, dau: 0, wau: 0, newUsers: 0, firstSeen: 0, firstQuiz: 0, day2: 0, installs: 0, opens: 0, answers: 0, quizzes: 0, quizzesDone: 0, mocks: 0, mocksDone: 0, onboarded: 0, drills: 0, fromSite: 0, rateLinks: 0, reviewPrompts: 0, paywall: 0 });
    return apps.get(k);
  };
  for (const r of daily) Object.assign(app(r), { dau: num(r.dau), opens: num(r.opens), answers: num(r.answers), quizzes: num(r.quizzes), quizzesDone: num(r.quizzes_done), mocks: num(r.mocks), mocksDone: num(r.mocks_done), onboarded: num(r.onboarded), drills: num(r.drills), fromSite: num(r.from_site), rateLinks: num(r.rate_links), reviewPrompts: num(r.review_prompts), paywall: num(r.paywall) });
  for (const r of weekly ?? []) app(r).wau = num(r.wau);
  for (const r of newUsers ?? []) Object.assign(app(r), { newUsers: num(r.new_users), firstSeen: num(r.first_seen), firstQuiz: num(r.first_quiz), day2: num(r.day2) });
  for (const r of installs ?? []) app(r).installs = num(r.installs);
  const siteMap = new Map();
  for (const r of sites) {
    const date = String(r.day).slice(0, 10);
    const k = `${date}|${r.site}`;
    if (!siteMap.has(k)) siteMap.set(k, { date, kind: 'site', site: r.site, brand: r.brand, pageviews: 0, landings: 0, instagram: 0, tiktok: 0, youtube: 0, search: 0, direct: 0, other: 0, storeClicks: 0, appClicks: 0, linksViews: 0, linkClicks: 0 });
    const s = siteMap.get(k);
    const n = num(r.n);
    if (r.event === '$pageview') {
      s.pageviews += n;
      if (r.kind === 'links') s.linksViews += n;
      if (r.source !== 'internal') { s.landings += n; s[r.source] = (s[r.source] ?? 0) + n; }
    } else if (r.kind === 'app') s.appClicks += n;
    else if (r.kind === 'app_store' || r.kind === 'play') s.storeClicks += n;
    // the rest of a /links page's buttons: the brand's site (website), a sister app's links (family_<brand>), ...
    else if (r.event === 'links_click') s.linkClicks += n;
  }
  return [...apps.values(), ...siteMap.values()];
}

/** The events query's rows → the event list (tabs added up) and the screens (tab_opened by tab). */
export function eventLists(rows) {
  const ev = new Map();
  const screens = [];
  for (const r of rows) {
    const platform = r.platform || '';
    const k = `${r.event}|${platform}`;
    if (!ev.has(k)) ev.set(k, { event: r.event, platform, count: 0, n7: 0, n1: 0 });
    const e = ev.get(k);
    e.count += num(r.n); e.n7 += num(r.n7); e.n1 += num(r.n1);
    if (r.event === 'tab_opened' && r.tab) screens.push({ tab: r.tab, platform, count: num(r.n), n7: num(r.n7), n1: num(r.n1) });
  }
  return { events: [...ev.values()].sort((a, b) => b.count - a.count), screens: screens.sort((a, b) => b.count - a.count) };
}

function save(lines, from, state) {
  fs.mkdirSync(DIR, { recursive: true });
  const kept = readLines(file('posthog.jsonl')).filter((r) => r.date < from);
  const all = [...kept, ...lines].sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || String(a.brand ?? a.site).localeCompare(String(b.brand ?? b.site)) || String(a.platform ?? '').localeCompare(String(b.platform ?? '')));
  fs.writeFileSync(file('posthog.jsonl'), all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(file('posthog-state.json'), JSON.stringify(state, null, 2) + '\n');
}

export async function fetchPostHog() {
  const state = readJson(file('posthog-state.json'), {});
  const fake = process.env.POSTHOG_FAKE === '1';
  const key = fake ? 'fake' : readSecret('POSTHOG_PERSONAL_API_KEY');
  const project = (fake ? '636811' : readSecret('POSTHOG_PROJECT_ID')) || '636811';
  const done = (status, message, extra = {}) => {
    Object.assign(state, { status, message, checkedAt: new Date().toISOString(), project, ...extra });
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file('posthog-state.json'), JSON.stringify(state, null, 2) + '\n');
  };
  if (!key) { log(`no key in the keychain (${SETUP}); skipped`); done('missing', `no PostHog key in the keychain: ${SETUP}`); return 0; }
  const first = !fs.existsSync(file('posthog.jsonl'));
  const days = first ? FIRST_DAYS : RECENT_DAYS;
  const from = addDays(today, -days + 1);
  const q = queries(days);
  try {
    const rows = {};
    for (const name of ['daily', 'weekly', 'newUsers', 'installs', 'sites']) {
      try { rows[name] = await query(project, key, name, q[name]); } catch (e) {
        // The funnel columns are new (2026-11-23): if that query fails, ask the plain one once so new users stay
        if (name === 'newUsers') {
          log(`${scrub(e.message)}; asking new users without the funnel`);
          try { rows[name] = await query(project, key, 'newUsersPlain', q.newUsersPlain); continue; } catch (e2) { e = e2; }
        }
        // WAU and new users are extras: keep the daily numbers when one of them fails
        if (name === 'weekly' || name === 'newUsers' || name === 'installs') { log(`${scrub(e.message)}; ${name} left out`); rows[name] = []; } else throw e;
      }
    }
    let events = state.events ?? [];
    let screens = state.screens ?? [];
    try { ({ events, screens } = eventLists(await query(project, key, 'events', q.events))); } catch (e) { log(`events list: ${scrub(e.message)}`); }
    let sameHour = null;
    try {
      const asOf = new Date().toISOString();
      sameHour = { asOf, rows: (await query(project, key, 'sameHour', q.sameHour)).map((r) => ({ date: String(r.day).slice(0, 10), brand: r.brand, platform: r.platform, dau: num(r.dau), answers: num(r.answers), quizzesDone: num(r.quizzes_done), mocksDone: num(r.mocks_done), onboarded: num(r.onboarded) })) };
    } catch (e) { log(`same-hour comparison: ${scrub(e.message)}`); }
    const lines = toLines(rows);
    Object.assign(state, { status: 'ok', message: `${lines.length} lines for ${from} to ${today}`, checkedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), from, to: today, project, events, screens, sameHour, fake: fake || undefined });
    save(lines, from, state);
    log(`${lines.filter((l) => l.kind === 'app').length} app lines, ${lines.filter((l) => l.kind === 'site').length} site lines, ${from} to ${today}${first ? ' (first run)' : ''}`);
    return 0;
  } catch (e) {
    const msg = scrub(e.message);
    log(`ERROR ${msg}`);
    done('error', /HTTP (401|403)/.test(msg) ? `PostHog refused the key (${msg}); store a new read-only key: ${SETUP}` : msg);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--if-stale');
  if (i > 0) {
    const hours = Number(process.argv[i + 1] || 3);
    const st = readJson(file('posthog-state.json'), {});
    const last = Date.parse(st.checkedAt ?? '');
    if (last && Date.now() - last < hours * 3600000) { log(`last fetch ${st.checkedAt}, under ${hours} h ago; skipped`); process.exit(0); }
  }
  process.exit(await fetchPostHog());
}
