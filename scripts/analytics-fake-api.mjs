// Loaded with node --import by analytics.test.mjs: answers Instagram (both Graph hosts) and YouTube with made-up data and blocks everything
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
  // As Meta does: a system-user token (EAA...) works only on graph.facebook.com, an Instagram-login token only on
  // graph.instagram.com, and a system-user token has no refresh call
  if (url.hostname === 'graph.instagram.com' || url.hostname === 'graph.facebook.com') {
    const systemUser = (url.searchParams.get('access_token') ?? '').startsWith('EAA');
    if (systemUser !== (url.hostname === 'graph.facebook.com')) return json({ error: { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 } }, 400);
    if (url.pathname.endsWith('/refresh_access_token') && systemUser) return json({ error: { message: 'Unsupported get request', code: 100 } }, 400);
    const user = url.pathname.split('/')[2];
    if (failAccount && user === failAccount) return json({ error: { message: 'Error validating access token: Session has expired' } }, 400);
    if (url.pathname.endsWith('/media')) {
      const after = Number(url.searchParams.get('after') ?? 0);
      // Media IDs are unique across accounts, as on Instagram: the keychain's fake user keeps reel-N, others get <user>-reel-N
      const page = media.slice(after, after + 50).map((m) => (user === 'fake-value' ? m : { ...m, id: `${user}-${m.id}` }));
      return json({ data: page, paging: after + 50 < media.length ? { next: `${url.origin}/v25.0/${user}/media?access_token=${url.searchParams.get('access_token')}&after=${after + 50}` } : {} });
    }
    if (url.pathname.endsWith('/insights') && url.searchParams.get('metric') === 'follower_count') {
      return json({ data: [{ values: [{ value: 2, end_time: daysAgo(1) }] }] });
    }
    if (url.pathname.endsWith('/insights')) {
      if (failInsights) return json({ error: { message: 'Application request limit reached' } }, 400);
      if (process.env.FAKE_NO_INSIGHTS_PERMISSION === '1') return json({ error: { message: '(#10) Application does not have permission for this action', code: 10 } }, 400);
      return json({ data: url.searchParams.get('metric').split(',').map((name) => ({ name, values: [{ value: 500 }] })) });
    }
    return json({ id: user, username: 'x', followers_count: 777, media_count: 60 });
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
  // @theerbasics (suffix _ER) has a system-user token and no user ID in the keychain, so its ID comes from IG_ACCOUNTS
  if (cmd === 'security' && args[0] === 'find-generic-password' && args.includes('IG_ACCESS_TOKEN_ER')) return 'EAAfakeSystemUserToken\n';
  if (cmd === 'security' && args[0] === 'find-generic-password' && args.includes('IG_USER_ID_ER')) throw new Error('not in the fake keychain');
  if (cmd === 'security' && args[0] === 'find-generic-password') return 'fake-value\n';
  if (cmd === 'security') return '';
  throw new Error('blocked by the fake');
};
syncBuiltinESMExports();
