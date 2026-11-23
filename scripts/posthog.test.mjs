//   node --test scripts/posthog.test.mjs
// Checks the site-source query and runs posthog.mjs against posthog-fake-api.mjs in a temp folder: no network, no keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SITE_SOURCE_INPUT, SOURCE, queries } from './posthog.mjs';

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
