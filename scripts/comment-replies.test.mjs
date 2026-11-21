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
  for (const [key, def] of Object.entries(config.keywords)) assert.ok(Object.keys(config.brandNames).some((b) => def[b]), key);
});

test('message names the brand and the full link; no page means no message', () => {
  assert.match(messageFor('SEPSIS', 'medic'), /Medic Basics 👇\nhttps:\/\/medicbasics\.com\/sheets\/prehospital-sepsis\.html/);
  assert.equal(messageFor('STEMI', 'rn'), null);
});

test('APP / LINK / FREE send the site home (the store buttons) with a natural line; topic keywords still win', () => {
  assert.equal(matchKeyword('APP'), 'APP');
  assert.equal(matchKeyword('link please'), 'APP');
  assert.equal(matchKeyword('free'), 'APP');
  assert.equal(matchKeyword('sepsis link'), 'SEPSIS');
  assert.equal(messageFor('APP', 'rn'), "Here's your free app link for RN Basics 👇\nhttps://rnbasics.com/");
  assert.equal(messageFor('APP', 'icu'), "Here's your free app link for ICU Basics 👇\nhttps://icubasics.com/");
  assert.match(messageFor('APP', 'medic'), /^Here's your free app link for Medic Basics 👇\nhttps:\/\/medicbasics\.com\/$/);
  assert.doesNotMatch(messageFor('APP', 'rn'), /free free/);
  assert.match(messageFor('SEPSIS', 'rn'), /^Here's your free sepsis/);
});

test('rt: respiratorybasics.com has no pages yet, so DMs name ICU Basics as the sister site (APP too)', () => {
  assert.equal(config.sites.rt, 'https://respiratorybasics.com');
  assert.equal(config.brandNames.rt, 'RT Basics');
  // APP on rt: the RT Basics app itself (Alex 2026-11-20), not the sister site
  const app = messageFor('APP', 'rt');
  assert.match(app, /https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.alex\.respiratorybasics/);
  assert.match(app, /https:\/\/respiratorybasics\.com/);
  assert.match(app, /coming soon to the App Store/);
  assert.match(app, /inside the ICU Basics app: https:\/\/apps\.apple\.com\/app\/id6809866200$/);
  assert.equal(messageFor('LINK', 'rt'), null, 'aliases map to APP before messageFor; LINK itself is no keyword');
  assert.equal(messageFor(matchKeyword('link please'), 'rt'), app);
  assert.match(messageFor('POTASSIUM', 'rt'), /on ICU Basics' site.*\nhttps:\/\/icubasics\.com\/sheets\/electrolytes\.html/s);
  for (const key of Object.keys(config.keywords)) {
    const m = messageFor(key, 'rt');
    if (m && key !== 'APP') assert.ok(!m.includes('respiratorybasics.com'), key);
  }
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

test('a system-user account (EAA...) reads through graph.facebook.com; er sends DMs since 2026-11-18', () => {
  const r = run({ ACCOUNTS: 'er' });
  assert.equal(r.status, 0, r.out);
  const calls = r.calls.filter((c) => !c.startsWith('exec'));
  assert.equal(calls[0], 'GET /v25.0/17841479868648523/media [graph.facebook.com]');
  assert.ok(calls.every((c) => c.endsWith('[graph.facebook.com]')), calls.join('\n'));
  assert.ok(!r.out.includes('EAAfake'), 'the token is never printed');
  const check = run({ ACCOUNTS: 'er' }, ['--check']);
  assert.equal(check.status, 0, check.out);
  assert.ok(check.calls.includes('GET /v25.0/er-reel/comments [graph.facebook.com]'), check.calls.join('\n'));
  assert.equal(check.calls.filter((c) => c.startsWith('POST')).length, 0);
});

test('ekg, np, pharm, lab: pages are full URLs on a sister site, and the DM names that site', () => {
  assert.equal(messageFor('EKG', 'ekg'), "Here's your free rhythm cheat sheet on ICU Basics' site, our sister app 👇\nhttps://icubasics.com/sheets/rhythm-gallery.html\n\nEducation only; follow your institution's protocols.");
  assert.match(messageFor('PHARM', 'pharm'), /^Here's your free drug classes cheat sheet on RN Basics' site, our sister app 👇\nhttps:\/\/rnbasics\.com\/sheets\/pharm-classes-suffixes\.html\n/);
  assert.match(messageFor('LABS', 'lab'), /on RN Basics' site.*\nhttps:\/\/rnbasics\.com\/sheets\/lab-values\.html/s);
  assert.match(messageFor('DKA', 'np'), /on ICU Basics' site.*\nhttps:\/\/icubasics\.com\/sheets\/dka-hhs\.html/s);
  assert.equal(messageFor('SEPSIS', 'ekg'), null);
  assert.equal(messageFor('APP', 'lab'), null, 'no app link until the app is live');
  assert.equal(matchKeyword('12 lead qtc'), 'QTC');
  assert.equal(matchKeyword('high alert'), 'ALERT');
  for (const b of ['ekg', 'np', 'pharm', 'lab']) {
    const pages = Object.values(config.keywords).map((d) => d[b]).filter(Boolean);
    assert.ok(pages.length >= 4, b);
    for (const p of pages) assert.match(p, /^https:\/\/(icubasics|rnbasics|medicbasics)\.com\/\S+\.html$/, `${b} ${p}`);
  }
  // icu, rn and medic still use paths on their own sites
  for (const def of Object.values(config.keywords)) for (const b of ['icu', 'rn', 'medic']) if (def[b]) assert.match(def[b], /^\//);
});

test('a system-user account with dms: true (ekg) sends the private and public reply on graph.facebook.com', () => {
  const r = run({ ACCOUNTS: 'ekg' });
  assert.equal(r.status, 0, r.out);
  const dms = r.calls.filter((c) => c.startsWith('POST') && c.includes('/messages'));
  assert.deepEqual(dms.map((c) => c.split(' ').slice(0, 3).join(' ')), ['POST /v25.0/17841458933751960/messages k1', 'POST /v25.0/17841458933751960/messages k2']);
  assert.ok(dms.every((c) => c.endsWith('[graph.facebook.com]') && c.includes('https://icubasics.com/sheets/rhythm-gallery.html') && c.includes("ICU Basics' site")), dms.join('\n'));
  const replies = r.calls.filter((c) => c.includes('/replies'));
  assert.deepEqual(replies, ['POST /v25.0/k1/replies Sent you a DM 📩 [graph.facebook.com]', 'POST /v25.0/k2/replies Sent you a DM 📩 [graph.facebook.com]']);
  assert.equal(r.state.replied.k3.status, 'no page for this brand');
  assert.equal(r.state.replied.k4, undefined, 'its own comment is skipped');
  assert.ok(!r.out.includes('EAAfake'), 'the token is never printed');
  const again = run({ ACCOUNTS: 'ekg', DIR: r.dir });
  assert.equal(again.calls.filter((c) => c.startsWith('POST')).length, 0);
  const dry = run({ ACCOUNTS: 'ekg', DRY_RUN: '1' });
  assert.equal(dry.calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.match(dry.out, /DRY RUN would DM EKG for comment k1/);
  const check = run({ ACCOUNTS: 'ekg' }, ['--check']);
  assert.equal(check.calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.match(check.out, /@ekgtechbasics: OK, 1 posts/);
});

test('a system-user account refused with "invalid for a private reply" counts no try and keeps the comment waiting', () => {
  const a = run({ ACCOUNTS: 'ekg', FAKE_FAIL_MESSAGES: 'private' }); // ekg's fake Reel has keyword comments (er's APP has no ER page)
  assert.equal(a.status, 0, a.out);
  assert.equal(a.calls.filter((c) => c.includes('/messages')).length, 1, 'stops the account after the first refusal');
  assert.match(a.out, /will not take private replies from this token/);
  let state = a.state;
  for (let i = 0; i < 3; i++) state = run({ ACCOUNTS: 'ekg', FAKE_FAIL_MESSAGES: 'private', DIR: a.dir }).state;
  assert.deepEqual(state.replied, {}, 'never given up');
  assert.deepEqual(state.tries ?? {}, {}, 'no tries counted');
  assert.ok(!a.calls.some((c) => c.includes('/replies')), 'no public "Sent you a DM" without a DM');
});
