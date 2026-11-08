//   node --test scripts/comment-replies.test.mjs
// Runs comment-replies.mjs against comment-replies-fake-api.mjs with a temp state file: no network, no real keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchKeyword, messageFor } from './comment-replies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'comment-keywords.json'), 'utf8'));

function run(env = {}, args = []) {
  const dir = env.DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'comments-test-'));
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'comment-replies-fake-api.mjs'), path.join(here, 'comment-replies.mjs'), ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, ACCOUNTS: 'icu', COMMENTS_STATE: path.join(dir, 'state.json'), FAKE_LOG: logFile, DRY_RUN: '', ...env },
  });
  const statePath = path.join(dir, 'state.json');
  return { dir, status: r.status, out: r.stdout + r.stderr, calls: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean), state: fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null };
}

test('keywords: short comments match, sentences and unknown words do not', () => {
  assert.equal(matchKeyword('SEPSIS'), 'SEPSIS');
  assert.equal(matchKeyword('sepsis please 🙏'), 'SEPSIS');
  assert.equal(matchKeyword('Potassium!!'), 'POTASSIUM');
  assert.equal(matchKeyword('electrolytes'), 'POTASSIUM');
  assert.equal(matchKeyword('heart failure'), 'HF');
  assert.equal(matchKeyword('I had a sepsis patient last night and it was scary'), null);
  assert.equal(matchKeyword('great video'), null);
  assert.equal(matchKeyword(''), null);
});

test('every slug points at a keyword, and every keyword has at least one brand page', () => {
  for (const [slug, key] of Object.entries(config.slugs)) assert.ok(config.keywords[key], `${slug} → ${key}`);
  for (const [key, def] of Object.entries(config.keywords)) assert.ok(def.icu || def.rn || def.medic, key);
});

test('message names the brand and the full link; no page means no message', () => {
  assert.match(messageFor('SEPSIS', 'medic'), /Medic Basics 👇\nhttps:\/\/medicbasics\.com\/sheets\/prehospital-sepsis\.html/);
  assert.equal(messageFor('STEMI', 'rn'), null);
});

test('sends one DM per keyword comment, skips its own, sentences, old Reels; second run sends nothing', () => {
  const first = run();
  assert.equal(first.status, 0, first.out);
  const dms = first.calls.filter((c) => c.startsWith('POST') && c.includes('/messages'));
  assert.equal(dms.length, 2, first.calls.join('\n')); // c1, c2 (sepsis); c3 sentence, c4 own, c5 LABS has no ICU page
  assert.ok(dms.every((c) => c.includes('icubasics.com/sheets/sepsis-bundle.html')));
  assert.equal(first.calls.filter((c) => c.includes('/replies')).length, 2);
  assert.ok(!first.calls.some((c) => c.includes('reel-old') || c.includes('reel-quiet')), 'no comment reads for old or comment-less Reels');
  assert.equal(first.state.replied.c5.status, 'no page for this brand');
  const second = run({ DIR: first.dir });
  assert.equal(second.calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.ok(!second.calls.some((c) => c.includes('/comments')), 'unchanged comment count: comments not read again');
});

test('DRY_RUN sends nothing and saves nothing', () => {
  const r = run({ DRY_RUN: '1' });
  assert.equal(r.calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.match(r.out, /DRY RUN would DM SEPSIS/);
  assert.equal(r.state, null);
});

test('--check only reads', () => {
  const r = run({}, ['--check']);
  assert.equal(r.calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.match(r.out, /OK, 3 posts|OK, 2 posts/);
});

test('a permission error stops the account, retries later, and gives up after three tries', () => {
  const a = run({ FAKE_FAIL_MESSAGES: '10' });
  assert.equal(a.calls.filter((c) => c.includes('/messages')).length, 1, 'stops after the first permission error');
  assert.match(a.out, /permission or messaging-access problem/);
  assert.equal(a.state.counts['icu:reel-new'], undefined, 'Reel stays pending so the comment is retried');
  run({ FAKE_FAIL_MESSAGES: '10', DIR: a.dir });
  const c = run({ FAKE_FAIL_MESSAGES: '10', DIR: a.dir });
  assert.match(c.state.replied.c1.status, /^failed/);
});
