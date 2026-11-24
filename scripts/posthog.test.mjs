//   node --test scripts/posthog.test.mjs
// Checks the site-source query and runs posthog.mjs against posthog-fake-api.mjs in a temp folder: no network, no keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SITE_SOURCE_INPUT, SOURCE, queries, LEFT_OUT_RULE, LEFT_OUT_IDS, NOT_LEFT_OUT, STARTED, REACHED5, LEFT_OUT_HAVING, leftOutReason, keepSaved } from './posthog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('site source prefers the utm_source property and falls back to the referrer', () => {
  assert.equal(SITE_SOURCE_INPUT, "lower(coalesce(nullIf(properties.utm_source, ''), properties.$referring_domain, ''))");
  const sites = queries(14).sites;
  assert.ok(sites.includes(`${SITE_SOURCE_INPUT} AS r`), sites);
  assert.ok(!/lower\(coalesce\(properties\.\$referring_domain/.test(sites), 'no referrer-only source left');
  // utm_source values as the bio links send them map to the existing buckets
  for (const v of ['instagram', 'tiktok', 'youtube']) assert.ok(SOURCE.includes(`'%${v}%'`), v);
});

test('a fetch with the fake API still writes site lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.kind === 'site' && l.instagram > 0));
});

test('links pages (basics-links) count: views, store buttons and other buttons, and a links-only site gets its own lines', () => {
  const sites = queries(14).sites;
  assert.match(sites, /properties\.\$lib IN \('basics-site', 'basics-links'\)/);
  assert.match(sites, /'links_click'/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rt = lines.filter((l) => l.kind === 'site' && l.site === 'respiratorybasics.com');
  assert.equal(rt.length, 3);
  for (const l of rt) assert.deepEqual([l.brand, l.pageviews, l.linksViews, l.landings, l.instagram, l.storeClicks, l.linkClicks], ['rt', 4, 4, 4, 4, 2, 1]);
  const rn = lines.filter((l) => l.kind === 'site' && l.site === 'rnbasics.com' && l.linksViews > 0);
  assert.ok(rn.length > 0 && rn.every((l) => l.linkClicks === 1 && l.pageviews > l.linksViews), 'links pages add to the old sites');
});

test('the widened queries (2026-11-23): funnel, rating and paywall columns, screens and 7-day counts, with no extra query', () => {
  const q = queries(14);
  assert.match(q.daily, /rate_link_opened/);
  assert.match(q.daily, /%paywall%/);
  assert.match(q.newUsers, /AS first_quiz/);
  assert.match(q.newUsers, /AS day2/);
  assert.match(q.events, /AS n7/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const apps = lines.filter((l) => l.kind === 'app');
  assert.ok(apps.some((l) => l.firstQuiz > 0 && l.day2 > 0 && l.rateLinks > 0));
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'posthog-state.json'), 'utf8'));
  assert.deepEqual(st.screens.slice(0, 2).map((x) => [x.tab, x.count]), [['home', 2100], ['home', 2100]], 'apps added up per tab');
  const tabs = st.events.filter((e) => e.event === 'tab_opened');
  assert.deepEqual(tabs.map((e) => [e.platform, e.count]), [['ios', 4240], ['web', 4240]], 'tabs added up in the event list');
  assert.ok(st.events.every((e) => 'n7' in e && 'n1' in e));
  // Usage rows: by app, platform and detail, with the prior week, devices and the average score
  const quick = st.usage.find((u) => u.event === 'quiz_started' && u.detail === 'quick10');
  assert.deepEqual([quick.brand, quick.platform, quick.n7, quick.p7, quick.users7], ['rn', 'ios', 105, 84, 28]);
  assert.equal(st.usage.find((u) => u.event === 'arcade_game_completed' && u.detail === 'daily_shift').avgScore, 1240);
  assert.ok(st.usage.some((u) => u.event === '$pageview' && u.platform === 'site' && u.detail === 'acls-algorithms'));
  assert.ok(!st.usage.some((u) => u.event === 'question_answered'), 'events with no detail are not usage rows');
  assert.ok(apps.some((l) => l.arcadePlays > 0 && l.referenceViews > 0 && l.sheetPdfs >= 0));
  assert.match(q.events, /AS detail/);
  assert.match(q.events, /replaceRegexpAll\(properties\.\$pathname/);
});

test('if the funnel query fails, the plain new-users query is asked once and the rest is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir, POSTHOG_FAKE_FAIL_QUERY: 'newUsers' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /asking new users without the funnel/);
  const apps = fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === 'app');
  assert.ok(apps.some((l) => l.firstSeen > 0) && apps.every((l) => l.day2 === 0));
});

test('if the usage events query fails, the plain event list is asked once and old usage rows are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  fs.writeFileSync(path.join(dir, 'posthog-state.json'), JSON.stringify({ usage: [{ event: 'quiz_started', detail: 'mock', brand: 'rn', platform: 'ios', n: 1, n7: 1, p7: 0, n1: 0, users: 1, users7: 1 }] }));
  fs.writeFileSync(path.join(dir, 'posthog.jsonl'), '');
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir, POSTHOG_FAKE_FAIL_QUERY: 'events' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /asking the plain list/);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'posthog-state.json'), 'utf8'));
  assert.equal(st.usage.length, 1);
  assert.ok(st.screens.some((x) => x.tab === 'home'));
});

// ---------- Left out: our own visits and obvious bots (2026-11-24) ----------
const web = (event, extra = {}) => ({ event, $lib: 'web', $browser: 'Chrome', $os: 'Mac OS X', ...extra });
const phone = (event, extra = {}) => ({ event, $lib: 'posthog-react-native', $os: 'iOS', ...extra });

test('left-out rule: our own Claude previews and obvious bots are left out', () => {
  assert.equal(leftOutReason([web('app_opened', { $browser: 'Claude' }), web('question_answered', { $browser: 'Claude' })]), 'own');
  assert.equal(leftOutReason([web('app_opened', { $browser: '' })]), 'bot', 'web with no browser');
  assert.equal(leftOutReason([web('app_opened', { $browser: undefined })]), 'bot', 'web with no browser property');
  assert.equal(leftOutReason([web('app_opened', { $raw_user_agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })]), 'bot');
  assert.equal(leftOutReason([web('app_opened', { $raw_user_agent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0 Safari/537.36' })]), 'bot');
  assert.equal(leftOutReason([web('app_opened', { $os: 'Windows', $browser: 'Microsoft Edge' }), web('onboarding_viewed', { $os: 'Windows', $browser: 'Microsoft Edge' })]), 'bot', 'Edge on Windows, load only');
  assert.equal(leftOutReason([web('app_boot', { $os: 'Linux' }), web('app_opened', { $os: 'Linux' }), web('onboarding_step_viewed', { $os: 'Linux' }), web('first_question_viewed', { $os: 'Linux' })]), 'bot', 'Chrome on Linux, load only');
});

test('left-out rule: real people are kept, including a phone that bounced', () => {
  // a phone browser that opened the web app and left
  assert.equal(leftOutReason([web('app_opened', { $os: 'iOS', $browser: 'Mobile Safari' }), web('onboarding_viewed', { $os: 'iOS', $browser: 'Mobile Safari' })]), '');
  assert.equal(leftOutReason([web('app_opened', { $os: 'Android', $browser: 'Chrome' })]), '');
  // the phone apps send no $browser at all
  assert.equal(leftOutReason([phone('app_opened'), phone('onboarding_viewed')]), '');
  // a Mac or a Windows Chrome visit that bounced stays (only Linux and Edge on Windows count as quiet desktops)
  assert.equal(leftOutReason([web('app_opened'), web('onboarding_viewed')]), '');
  assert.equal(leftOutReason([web('app_opened', { $os: 'Windows', $browser: 'Chrome' })]), '');
  // Edge on Windows or Linux that answered a question, at any time, is a person
  assert.equal(leftOutReason([web('app_opened', { $os: 'Windows', $browser: 'Microsoft Edge' }), web('onboarding_check_answered', { $os: 'Windows', $browser: 'Microsoft Edge' })]), '');
  assert.equal(leftOutReason([web('app_opened', { $os: 'Linux' }), web('quiz_started', { $os: 'Linux' })]), '');
  // a phone called "Cubot" is not a crawler
  assert.equal(leftOutReason([web('app_opened', { $os: 'Android', $raw_user_agent: 'Mozilla/5.0 (Linux; Android 12; CUBOT X50) Chrome/120 Mobile' })]), '');
});

test('left-out rule: the SQL is built from the same rule and every app number uses it, with no extra query', () => {
  for (const b of LEFT_OUT_RULE.ownBrowsers) assert.ok(LEFT_OUT_IDS.includes(`'${b}'`));
  assert.ok(LEFT_OUT_IDS.includes(`properties.${LEFT_OUT_RULE.ownFlag}`));
  for (const w of LEFT_OUT_RULE.crawlerWords) assert.ok(LEFT_OUT_IDS.includes(`LIKE '%${w}%'`), w);
  for (const e of LEFT_OUT_RULE.passiveEvents) assert.ok(LEFT_OUT_IDS.includes(`'${e}'`), e);
  assert.match(LEFT_OUT_IDS, /properties\.\$os = 'Linux'/);
  assert.match(LEFT_OUT_IDS, /properties\.\$os = 'Windows' AND properties\.\$browser = 'Microsoft Edge'/);
  assert.match(LEFT_OUT_IDS, /GROUP BY distinct_id HAVING/);
  const q = queries(14);
  for (const name of ['daily', 'installs', 'sameHour', 'events', 'eventsPlain']) assert.ok(q[name].includes(NOT_LEFT_OUT), `${name} leaves them out`);
  // new users flag them in their own per-device pass: PostHog refused NOT IN inside that grouped subquery (2026-11-24)
  for (const name of ['newUsers', 'newUsersPlain']) {
    assert.ok(q[name].includes(`if(${LEFT_OUT_HAVING}, 1, 0) AS lo`), name);
    assert.match(q[name], /AND lo = 0 GROUP BY day/);
    assert.ok(!q[name].includes('NOT IN (SELECT'), `${name}: no nested NOT IN`);
  }
  assert.match(q.weekly, /AS lo/);
  assert.match(q.weekly, /AS left_out,/);
  assert.match(q.weekly, /AS left_out_own/);
  assert.ok(!q.sites.includes(NOT_LEFT_OUT), 'website page views have no browser fields and a new id per page');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /posthog-fake-api: 7 queries asked/);
  const apps = fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === 'app');
  const rnWeb = apps.find((l) => l.brand === 'rn' && l.platform === 'web');
  assert.deepEqual([rnWeb.leftOut, rnWeb.leftOutOwn], [2, 1]);
  assert.ok(apps.filter((l) => l.platform !== 'web').every((l) => l.leftOut === 0));
});

test('the first run: started, reached five and activated, with stopped at 6-9 as a detail; new events read when present', () => {
  assert.match(STARTED, /event = 'onboarding_check_answered' OR \(event = 'onboarding_skipped' AND toFloat\(properties\.index\) >= 1\)/);
  assert.match(REACHED5, /event = 'onboarding_check_answered' AND toFloat\(properties\.index\) >= 5/);
  assert.match(REACHED5, /event = 'onboarding_first5_done'/);
  const q = queries(14);
  assert.ok(q.daily.includes(`count(DISTINCT if(${STARTED}, distinct_id, NULL)) AS started`));
  assert.ok(q.daily.includes(`count(DISTINCT if(${REACHED5}, distinct_id, NULL)) AS reached_five`));
  for (const e of ['onboarding_more_started', 'onboarding_engaged', 'onboarding_left', 'onboarding_resumed']) assert.ok(q.daily.includes(`'${e}'`), e);
  assert.match(q.daily, /toFloat\(properties\.index\) >= 10, distinct_id, NULL\)\) AS first10/);
  assert.ok(!/onboarding_completed' AND/.test(q.daily), 'onboarding_completed is not part of these');
  // activated: 10 or more answers on the device's first day, in the per-device pass
  assert.match(q.newUsers, /groupArrayIf\(toDate\(toTimeZone\(timestamp, 'America\/Chicago'\)\), event = 'question_answered'\) AS answer_days/);
  assert.match(q.newUsers, /countIf\(arrayCount\(x -> x = toDate\(toTimeZone\(first, 'America\/Chicago'\)\), answer_days\) >= 10\) AS activated/);
  assert.ok(!q.newUsersPlain.includes('activated'), 'the plain fallback stays plain');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const apps = fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === 'app');
  assert.ok(apps.some((l) => l.started > 0 && l.reachedFive > 0 && l.activated > 0 && l.started >= l.reachedFive && l.moreStarted >= l.first10));
  assert.ok(apps.every((l) => l.engaged === 0 && l.leftRun === 0 && l.resumed === 0), 'not sent yet: 0');
});

test('internal: true counts as our own, like the Claude browser; websites drop flagged page views', () => {
  assert.equal(leftOutReason([web('app_opened', { internal: true }), web('question_answered', { internal: true })]), 'own');
  assert.equal(leftOutReason([phone('app_opened', { internal: 'true' })]), 'own');
  assert.equal(leftOutReason([web('app_opened', { internal: false })]), '');
  assert.match(LEFT_OUT_HAVING, /coalesce\(toString\(properties\.internal\), ''\) IN \('true', '1'\)/);
  assert.match(queries(14).sites, /coalesce\(toString\(properties\.internal\), ''\) NOT IN \('true', '1'\)/);
});

test('a query that fails keeps its saved numbers instead of writing zeros', () => {
  const saved = [{ date: '2026-11-20', kind: 'app', brand: 'rn', platform: 'web', dau: 9, firstSeen: 5, newUsers: 1, firstQuiz: 3, day2: 2, wau: 30 }];
  const fresh = [{ date: '2026-11-20', kind: 'app', brand: 'rn', platform: 'web', dau: 8, firstSeen: 0, newUsers: 0, firstQuiz: 0, day2: 0, wau: 28 }];
  const [l] = keepSaved(fresh, saved, ['newUsers']);
  assert.deepEqual([l.dau, l.firstSeen, l.firstQuiz, l.day2, l.wau], [8, 5, 3, 2, 28]);
  assert.equal(keepSaved(fresh, saved, [])[0].firstSeen, 0);
  // the fake API's run with newUsers and its fallback both failing keeps the saved new users
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  const env = { ...process.env, ANALYTICS_DIR: dir };
  assert.equal(spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env }).status, 0);
  const read = () => fs.readFileSync(path.join(dir, 'posthog.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.kind === 'app');
  const key = (x) => `${x.date}|${x.brand}|${x.platform}`;
  const before = new Map(read().map((x) => [key(x), x.firstSeen]));
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...env, POSTHOG_FAKE_FAIL_QUERY: 'newUsers,newUsersPlain' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const from = JSON.parse(fs.readFileSync(path.join(dir, 'posthog-state.json'), 'utf8')).from;
  const after = read().filter((x) => x.date >= from);
  assert.ok(after.length > 0 && after.some((x) => x.firstSeen > 0));
  for (const x of after) assert.equal(x.firstSeen, before.get(key(x)) ?? 0, key(x));
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'posthog-state.json'), 'utf8')).message, /newUsers not answered tonight/);
});

test('the one-time backfill widens the window once, with the same 7 queries, and only marks itself done when every query worked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-test-'));
  fs.writeFileSync(path.join(dir, 'posthog.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'posthog-state.json'), '{}');
  const run = (extra = {}) => spawnSync(process.execPath, ['--import', path.join(here, 'posthog-fake-api.mjs'), path.join(here, 'posthog.mjs')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANALYTICS_DIR: dir, ...extra } });
  const st = () => JSON.parse(fs.readFileSync(path.join(dir, 'posthog-state.json'), 'utf8'));
  let r = run({ POSTHOG_FAKE_FAIL_QUERY: 'weekly' });
  assert.match(r.stdout, /7 queries asked/);
  assert.equal(st().backfill, undefined);
  assert.equal(st().from, new Date(Date.parse(`${st().to}T12:00:00Z`) - 62 * 86400000).toISOString().slice(0, 10));
  r = run();
  assert.match(r.stdout, /7 queries asked/);
  assert.equal(st().backfill, 'left-out-2026-11-24');
  r = run();
  assert.equal(st().from, new Date(Date.parse(`${st().to}T12:00:00Z`) - 13 * 86400000).toISOString().slice(0, 10), 'back to 14 days');
});
