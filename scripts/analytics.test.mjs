//   node --test scripts/analytics.test.mjs
// Runs analytics.mjs against scripts/analytics-fake-api.mjs in a temp ANALYTICS_DIR: no network, keychain or git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const dayBefore = (n) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const readLines = (dir, f) => read(dir, f).split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A store as the nightly job leaves it: Instagram and YouTube lines from earlier today and yesterday. */
function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'));
  const recent = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'accounts.jsonl'), lines([
    { date: dayBefore(5), platform: 'youtube', account: 'yt', followers: 90, estimated: true },
    { date: today, platform: 'youtube', account: 'yt', followers: 100, mediaCount: 3 },
    { date: today, platform: 'instagram', account: 'icu', followers: 1, mediaCount: 1 },
  ]));
  fs.writeFileSync(path.join(dir, 'media.jsonl'), lines([
    { date: today, platform: 'youtube', account: 'yt', id: 'yt-old', views: 41 },
    { date: dayBefore(1), platform: 'instagram', account: 'icu', id: 'reel-1', views: 10 },
    { date: today, platform: 'instagram', account: 'icu', id: 'reel-1', views: 20 },
    { date: today, platform: 'instagram', account: 'icu', id: 'reel-30', views: 3000 }, // older than a week, only today's line
  ]));
  fs.writeFileSync(path.join(dir, 'media-meta.json'), JSON.stringify({
    'yt-old': { platform: 'youtube', account: 'yt', title: 'Old video', topic: 'Kept topic', slot: 'YouTube' },
    'reel-30': { platform: 'instagram', account: 'icu', title: 'Old reel', topic: 'Kept reel topic', slot: 'noon', posted: '2026-01-01T00:00:00Z' },
  }));
  const igTokens = {};
  for (const a of ['icu', 'rn', 'medic', 'rt', 'er', 'ekg', 'np', 'pharm', 'lab', 'rhea', 'winery', 'franchifi', 'gripwheels']) igTokens[a] = { refreshedAt: recent, expiresAt: recent };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ igTokens, somethingElse: 'kept' }));
  return dir;
}
function run(dir, args, env = {}) {
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');
  const clean = { ...process.env }; delete clean.INSIGHTS_DAYS;
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'analytics-fake-api.mjs'), path.join(here, 'analytics.mjs'), ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...clean, ANALYTICS_DIR: dir, FAKE_LOG: logFile, YT_STATE: path.join(dir, 'none.json'), ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) };
}
const google = (calls) => calls.filter((c) => /googleapis/.test(c));
const instagram = (calls) => calls.filter((c) => /graph\.(instagram|facebook)/.test(c));
const ER_ID = '17841479868648523'; // @theerbasics: a system-user token (EAA...) in the fake keychain

test('--only instagram makes no YouTube call and leaves every YouTube line as it was', () => {
  const dir = seed();
  const before = { acc: readLines(dir, 'accounts.jsonl').filter((r) => r.platform === 'youtube'), media: readLines(dir, 'media.jsonl').filter((r) => r.platform === 'youtube'), meta: JSON.parse(read(dir, 'media-meta.json'))['yt-old'] };
  const r = run(dir, ['fetch', '--only', 'instagram']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(google(r.calls), []);
  assert.ok(instagram(r.calls).length > 0);
  assert.deepEqual(readLines(dir, 'accounts.jsonl').filter((x) => x.platform === 'youtube'), before.acc);
  assert.deepEqual(readLines(dir, 'media.jsonl').filter((x) => x.platform === 'youtube'), before.media);
  assert.deepEqual(JSON.parse(read(dir, 'media-meta.json'))['yt-old'], before.meta);
});

test('--only instagram replaces the same-day Instagram lines once, and keeps the state it did not touch', () => {
  const dir = seed();
  assert.equal(run(dir, ['fetch', '--only', 'instagram']).status, 0);
  const icu = readLines(dir, 'accounts.jsonl').filter((x) => x.account === 'icu' && x.date === today && !x.estimated);
  assert.deepEqual(icu.map((x) => x.followers), [777]);
  const rows = readLines(dir, 'media.jsonl').filter((x) => x.account === 'icu' && x.id === 'reel-1');
  assert.deepEqual(rows.map((x) => [x.date, x.views]), [[dayBefore(1), 10], [today, 500]]);
  const state = JSON.parse(read(dir, 'state.json'));
  assert.equal(state.somethingElse, 'kept');
  assert.equal(state.igAccounts.icu.status, 'ok');
  assert.ok(state.igAccounts.icu.okAt);
});

test('with no flag it still fetches both, and rebuilds nothing with fetch', () => {
  const dir = seed();
  const r = run(dir, ['fetch']);
  assert.ok(google(r.calls).length > 0, r.out);
  assert.ok(instagram(r.calls).length > 0);
  assert.equal(fs.existsSync(path.join(dir, 'dashboard.html')), false);
});

for (const bad of [['--only', 'youtube'], ['--only'], ['--only=instagram'], ['fetch', '--only', 'tiktok']]) {
  test(`${bad.join(' ')} stops before any call`, () => {
    const dir = seed();
    const before = read(dir, 'media.jsonl');
    const r = run(dir, bad);
    assert.equal(r.status, 2);
    assert.deepEqual(r.calls, []);
    assert.equal(read(dir, 'media.jsonl'), before);
  });
}

test('INSIGHTS_DAYS=7: paging stops at the cutoff, and older Reels keep their lines, even from today', () => {
  const dir = seed();
  const r = run(dir, ['fetch', '--only', 'instagram'], { INSIGHTS_DAYS: '7' });
  assert.equal(r.status, 0, r.out);
  const perAccount = instagram(r.calls).filter((c) => c.endsWith('/media')).length / 9; // 10 accounts since ekg, np, pharm went off (2026-11-22)
  assert.equal(perAccount, 1, 'one media page per account');
  const rows = readLines(dir, 'media.jsonl');
  assert.deepEqual(rows.filter((x) => x.id === 'reel-30' && x.account === 'icu').map((x) => x.views), [3000]);
  assert.equal(JSON.parse(read(dir, 'media-meta.json'))['reel-30'].topic, 'Kept reel topic');
  assert.equal(JSON.parse(read(dir, 'media-meta.json'))['reel-30'].title, 'Old reel');
  assert.deepEqual(rows.filter((x) => x.id === 'reel-1' && x.date === today && x.account === 'icu').map((x) => x.views), [500]);
});

test('a partial run whose insights all fail keeps the saved views instead of writing empty lines', () => {
  const dir = seed();
  const r = run(dir, ['fetch', '--only', 'instagram'], { INSIGHTS_DAYS: '7', FAKE_FAIL_INSIGHTS: '1' });
  assert.equal(r.status, 0, r.out);
  const rows = readLines(dir, 'media.jsonl');
  assert.deepEqual(rows.filter((x) => x.id === 'reel-1' && x.date === today).map((x) => x.views), [20]);
  assert.ok(rows.filter((x) => x.platform === 'instagram').every((x) => x.views != null));
});

test('one account failing keeps that account\'s lines and exits non-zero', () => {
  const dir = seed();
  const before = readLines(dir, 'media.jsonl').filter((x) => x.account === 'icu');
  const r = run(dir, ['fetch', '--only', 'instagram'], { FAKE_FAIL_ACCOUNT: 'fake-value' });
  assert.equal(r.status, 1);
  assert.deepEqual(readLines(dir, 'media.jsonl').filter((x) => x.account === 'icu'), before);
  assert.equal(JSON.parse(read(dir, 'state.json')).igAccounts.icu.status, 'error');
});

test('a system-user token (EAA...) reads through graph.facebook.com by account ID, is never refreshed, and never expires', () => {
  const dir = seed();
  // A refresh date over a week old would make an Instagram-login token refresh tonight
  const state = JSON.parse(read(dir, 'state.json'));
  state.igTokens.er = { refreshedAt: dayBefore(30) + 'T00:00:00Z', expiresAt: dayBefore(-30) + 'T00:00:00Z' };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const r = run(dir, ['fetch', '--only', 'instagram'], { INSIGHTS_DAYS: '7' });
  assert.equal(r.status, 0, r.out);
  const fb = r.calls.filter((c) => c.includes('graph.facebook.com'));
  assert.ok(fb.includes(`fetch https://graph.facebook.com/v25.0/${ER_ID}`), fb.join('\n'));
  assert.ok(fb.includes(`fetch https://graph.facebook.com/v25.0/${ER_ID}/media`));
  assert.ok(fb.some((c) => c.includes(`/${ER_ID}-reel-`) && c.endsWith('/insights')), 'Reel insights');
  assert.ok(fb.includes(`fetch https://graph.facebook.com/v25.0/${ER_ID}/insights`), 'follower history');
  assert.ok(fb.every((c) => !/\/me\b|refresh_access_token/.test(c)));
  assert.ok(r.calls.filter((c) => c.includes('graph.instagram.com')).every((c) => !c.includes(ER_ID)));
  assert.ok(!r.calls.some((c) => c.startsWith('exec security -i')), 'no token written to the keychain');
  assert.ok(!r.out.includes('EAAfake'), 'the token is never printed');
  const after = JSON.parse(read(dir, 'state.json'));
  assert.deepEqual([after.igTokens.er.kind, after.igTokens.er.neverExpires, after.igTokens.er.expiresAt], ['system-user', true, undefined]);
  assert.equal(after.igAccounts.er.status, 'ok');
  assert.equal(after.igTokens.icu.refreshedAt, state.igTokens.icu.refreshedAt, 'Instagram-login tokens keep their dates');
  assert.deepEqual(readLines(dir, 'accounts.jsonl').filter((x) => x.account === 'er' && x.date === today && !x.estimated).map((x) => x.followers), [777]);
  assert.ok(readLines(dir, 'media.jsonl').some((x) => x.account === 'er' && x.views === 500));
});

test('a token without the insights permission costs one insights call per Reel, not one per metric', () => {
  const dir = seed();
  const r = run(dir, ['fetch', '--only', 'instagram'], { INSIGHTS_DAYS: '7', FAKE_NO_INSIGHTS_PERMISSION: '1' });
  assert.equal(r.status, 0, r.out);
  const reels = r.calls.filter((c) => /\/(\d+-)?reel-\d+\/insights$/.test(c)).length;
  assert.equal(reels, 9 * 7, 'seven Reels in the last 7 days per account, one call each');
  assert.match(r.out, /does not have permission/);
});
