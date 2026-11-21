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
