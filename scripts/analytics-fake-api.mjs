// Loaded with node --import by analytics.test.mjs: answers Instagram and YouTube with made-up data and blocks everything
// real (network, keychain, git). Every call is logged to FAKE_LOG.
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const log = (s) => fs.appendFileSync(process.env.FAKE_LOG, `${s}\n`);
const failInsights = process.env.FAKE_FAIL_INSIGHTS === '1';
const failAccount = process.env.FAKE_FAIL_ACCOUNT;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
// Newest first: 60 items a day apart, so a page of 50 runs past a 7-day cutoff and a 120-day window needs the second page
const media = Array.from({ length: 60 }, (_, i) => ({ id: `reel-${i}`, caption: `Reel ${i}`, media_type: 'VIDEO', media_product_type: 'REELS', timestamp: daysAgo(i + 0.5), permalink: `https://example.com/${i}` }));

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  log(`fetch ${url.origin}${url.pathname}`);
  if (url.hostname === 'graph.instagram.com') {
    const user = url.pathname.split('/')[2];
    if (failAccount && user === failAccount) return json({ error: { message: 'Error validating access token: Session has expired' } }, 400);
    if (url.pathname.endsWith('/media')) {
      const after = Number(url.searchParams.get('after') ?? 0);
      const page = media.slice(after, after + 50);
      return json({ data: page, paging: after + 50 < media.length ? { next: `https://graph.instagram.com/v25.0/${user}/media?after=${after + 50}` } : {} });
    }
    if (url.pathname.endsWith('/insights') && url.searchParams.get('metric') === 'follower_count') {
      return json({ data: [{ values: [{ value: 2, end_time: daysAgo(1) }] }] });
    }
    if (url.pathname.endsWith('/insights')) {
      if (failInsights) return json({ error: { message: 'Application request limit reached' } }, 400);
      return json({ data: url.searchParams.get('metric').split(',').map((name) => ({ name, values: [{ value: 500 }] })) });
    }
    return json({ username: 'x', followers_count: 777, media_count: 60 });
  }
  if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
  if (url.pathname.endsWith('/channels')) return json({ items: [{ snippet: { title: 'The RN Basics', customUrl: '@thernbasics', publishedAt: '2026-01-01T00:00:00Z' }, statistics: { subscriberCount: '999', videoCount: '1' }, contentDetails: { relatedPlaylists: { uploads: 'u' } }, id: 'c' }] });
  if (url.pathname.endsWith('/playlistItems')) return json({ items: [{ contentDetails: { videoId: 'yt-1' } }] });
  if (url.pathname.endsWith('/videos')) return json({ items: [{ id: 'yt-1', snippet: { title: 'New video', publishedAt: daysAgo(3) }, contentDetails: { duration: 'PT30S' }, statistics: { viewCount: '50' }, status: { privacyStatus: 'public' } }] });
  if (url.pathname.endsWith('/reports')) return json({ columnHeaders: [{ name: 'video' }, { name: 'views' }], rows: [] });
  return json({ error: { message: `no fake for ${url}` } }, 404);
};

cp.execFileSync = function (cmd, args = [], opts) {
  log(`exec ${cmd} ${args[0] ?? ''}`);
  if (cmd === 'security' && args[0] === 'find-generic-password') return 'fake-value\n';
  if (cmd === 'security') return '';
  throw new Error('blocked by the fake');
};
syncBuiltinESMExports();
