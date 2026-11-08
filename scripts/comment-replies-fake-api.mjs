// Loaded with node --import by comment-replies.test.mjs: a made-up Instagram with a few Reels and comments, and a
// keychain that always has a token. Blocks the real network. Every call is logged to FAKE_LOG.
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const log = (s) => fs.appendFileSync(process.env.FAKE_LOG, `${s}\n`);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const ICU = '17841423460793482';
const failMessages = process.env.FAKE_FAIL_MESSAGES; // an error code, e.g. 10 (permission)

const media = {
  [ICU]: [
    { id: 'reel-new', timestamp: ago(1), comments_count: 5, media_product_type: 'REELS' },
    { id: 'reel-quiet', timestamp: ago(2), comments_count: 0, media_product_type: 'REELS' },
    { id: 'reel-old', timestamp: ago(9), comments_count: 3, media_product_type: 'REELS' },
  ],
};
const comments = {
  'reel-new': [
    { id: 'c1', text: 'SEPSIS', timestamp: ago(0.5), from: { id: 'u1', username: 'nurse1' } },
    { id: 'c2', text: 'sepsis please 🙏', timestamp: ago(0.4), from: { id: 'u2', username: 'nurse2' } },
    { id: 'c3', text: 'I had a sepsis patient last night and it was really scary honestly', timestamp: ago(0.3), from: { id: 'u3', username: 'nurse3' } },
    { id: 'c4', text: 'STEMI', timestamp: ago(0.2), from: { id: ICU, username: 'icubasics' } },
    { id: 'c5', text: 'labs', timestamp: ago(0.1), from: { id: 'u5', username: 'nurse5' } },
  ],
  'reel-old': [{ id: 'c9', text: 'ABG', timestamp: ago(8), from: { id: 'u9', username: 'old' } }],
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  log(`${method} ${url.pathname}${body?.recipient ? ` ${body.recipient.comment_id} ${JSON.stringify(body.message.text)}` : ''}${url.searchParams.get('message') ? ` ${url.searchParams.get('message')}` : ''}`);
  if (url.hostname !== 'graph.instagram.com') return json({ error: { message: 'network blocked' } }, 500);
  const parts = url.pathname.split('/').filter(Boolean); // v25.0, id, edge
  const [, id, edge] = parts;
  if (edge === 'media') return json({ data: media[id] ?? [] });
  if (edge === 'comments') return json({ data: comments[id] ?? [] });
  if (edge === 'messages') {
    if (failMessages) return json({ error: { message: 'Application does not have permission for this action', code: Number(failMessages) } }, 400);
    return json({ recipient_id: 'r', message_id: 'm' });
  }
  if (edge === 'replies') return json({ id: 'reply' });
  return json({ error: { message: `no fake for ${url.pathname}` } }, 404);
};

cp.execFileSync = function (cmd, args = []) {
  log(`exec ${cmd} ${args[0] ?? ''} ${args.includes('-a') ? args[args.indexOf('-a') + 1] : ''}`);
  if (cmd === 'security' && args[0] === 'find-generic-password') return args.includes('IG_ACCESS_TOKEN') ? 'fake-token\n' : '';
  throw new Error('blocked by the fake');
};
syncBuiltinESMExports();
