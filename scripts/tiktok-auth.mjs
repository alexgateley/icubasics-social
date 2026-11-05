// One-time per TikTok account on Alex's Mac: signs in to TikTok in the browser and stores that account's
// tokens in the login keychain (service icubasics-social, item TIKTOK_SANDBOX_TOKENS_<ACCOUNT> or
// TIKTOK_TOKENS_<ACCOUNT> for production), without them ever appearing on screen. Run it through
// scripts/setup-tiktok.sh, which first stores that environment's client key and secret
// (docs/tiktok-setup.md). Everything runs on the Mac.
//
//   node scripts/tiktok-auth.mjs rn            # @thernbasics (the default account)
//   node scripts/tiktok-auth.mjs icu|medic     # when those brands get TikTok accounts
//   node scripts/tiktok-auth.mjs rn --any      # skip the "is this the RN Basics account" check
//   node scripts/tiktok-auth.mjs rn check      # read-only: refresh the token, print name and scopes
//
// Login Kit for Desktop (checked 2026-11-03, https://developers.tiktok.com/doc/login-kit-desktop): a
// one-shot server receives the code at http://localhost:8763/callback, the redirect URI registered in the
// app's Login Kit settings (desktop redirect URIs must be localhost or 127.0.0.1 with a port, and the
// redirect_uri sent must match the registered one exactly). It listens on both loopback addresses,
// because a browser may resolve localhost to ::1 or to 127.0.0.1. PKCE is required, and TikTok wants the
// code_challenge as the HEX SHA-256 of the verifier (unlike Google's base64url). Scopes are
// comma-separated; the user can untick some, so the granted list is checked before anything is stored.
// The sandbox and production apps have different client keys; the one used is the active environment
// (setup-tiktok.sh asks, sandbox first), and the tokens are stored for that environment.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUTH_URL, AUTH_PORT, BRANDS, REDIRECT_URI, REQUIRED_SCOPES, SCOPES,
  accessToken, activeEnv, clientCreds, tokenKey, creatorInfo, loadTokens, saveTokens, tokenRequest, userInfo,
} from './tiktok-api.mjs';

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

/** 64 characters from TikTok's unreserved set (43-128 allowed). */
export function makeVerifier() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return [...crypto.randomBytes(64)].map((b) => chars[b % chars.length]).join('');
}
export const challengeOf = (verifier) => crypto.createHash('sha256').update(verifier).digest('hex');

/** The authorization page URL for this sign-in. */
export function authUrl({ clientKey, state, challenge }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_key: clientKey, scope: SCOPES.join(','), response_type: 'code', redirect_uri: REDIRECT_URI,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return url.toString();
}

/** Waits for TikTok to send the browser back to /callback?code=...&scopes=...&state=... */
function receiveCode(state, openUrl) {
  return new Promise((resolve, reject) => {
    const servers = [];
    const closeAll = () => { for (const s of servers) s.close(); };
    const handler = (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback' && url.pathname !== '/callback/') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? '<p>Signed in to TikTok. You can close this tab and go back to the terminal.</p>' : '<p>Sign-in did not complete. Go back to the terminal.</p>');
      closeAll();
      // URLSearchParams already URL-decodes the code, as the token endpoint requires
      if (ok) resolve({ code: url.searchParams.get('code'), scopes: url.searchParams.get('scopes') ?? '' });
      else reject(new Error(`${url.searchParams.get('error') || 'state mismatch or no code'} ${url.searchParams.get('error_description') ?? ''}`.trim()));
    };
    const listen = (host) => new Promise((ok, no) => {
      const s = http.createServer(handler);
      s.once('error', no);
      s.listen(AUTH_PORT, host, () => { servers.push(s); ok(); });
    });
    listen('127.0.0.1')
      .then(() => listen('::1').catch(() => {})) // no IPv6 loopback: 127.0.0.1 alone is fine
      .then(openUrl)
      .catch((e) => reject(new Error(e.code === 'EADDRINUSE' ? `port ${AUTH_PORT} is busy (the redirect URI is ${REDIRECT_URI}); close what uses it and rerun` : e.message)));
    setTimeout(() => { closeAll(); reject(new Error('no answer from the browser within 5 minutes')); }, 300000).unref();
  });
}

async function signIn(account, { any }) {
  const brand = BRANDS[account];
  const { key, secret } = clientCreds();
  const env = activeEnv();
  if (!key || !secret) fail(`the ${env} client key and secret are not in the keychain; run sh scripts/setup-tiktok.sh`);
  const verifier = makeVerifier();
  const state = crypto.randomBytes(16).toString('hex');
  const url = authUrl({ clientKey: key, state, challenge: challengeOf(verifier) });
  const { code } = await receiveCode(state, () => {
    console.log(`Opening the browser (${env} app). Sign in to TikTok as the ${brand.name} account (@${brand.handles[0]}) and allow every permission.${env === 'sandbox' ? '\nIn the sandbox, only the target users added under Sandbox settings can sign in.' : ''}`);
    console.log(`Redirect URI in use (must be registered in Login Kit exactly): ${REDIRECT_URI}`);
    if (process.env.TIKTOK_AUTH_NO_OPEN) console.log(`AUTH_URL ${url}`); else execFileSync('open', [url]);
  }).catch((e) => fail(e.message));

  const json = await tokenRequest({ client_key: key, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code_verifier: verifier })
    .catch((e) => fail(`${e.message}${e.logId ? ` (log id ${e.logId})` : ''}`));
  const granted = (json.scope ?? '').split(',').map((s) => s.trim());
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) fail(`these permissions were not granted (allow every one and rerun): ${missing.join(', ')}; nothing was stored`);
  if (!granted.includes('video.upload')) console.log('Note: video.upload was not granted, so "send to TikTok inbox as a draft" will not work. Direct Post will.');

  // Make sure this is the right account before storing anything
  const fresh = { accessToken: json.access_token };
  const user = await userInfo(fresh).catch((e) => fail(`signed in, but reading the account failed: ${e.message}`));
  const creator = await creatorInfo(fresh).catch(() => ({}));
  console.log(`Signed in as TikTok account: ${user.display_name ?? creator.creator_nickname ?? '?'}${creator.creator_username ? ` (@${creator.creator_username})` : ''}`);
  const names = `${user.display_name ?? ''} ${creator.creator_nickname ?? ''} ${creator.creator_username ?? ''}`;
  if (!any && !brand.match.test(names) && !brand.handles.includes(creator.creator_username)) {
    fail(`that is not the ${brand.name} account; nothing was stored. Rerun and sign in as @${brand.handles[0]} (or pass --any)`);
  }
  saveTokens(account, json, { display_name: user.display_name ?? creator.creator_nickname ?? '', username: creator.creator_username ?? '', signed_in_at: new Date().toISOString() });
  console.log(`Stored ${tokenKey(account)} in the keychain (service icubasics-social). The access token lasts 2 hours and is refreshed automatically; the sign-in lasts 180 days from each refresh.`);
  console.log('Next: node scripts/tiktok-poster.mjs');
}

async function check(account) {
  const t = loadTokens(account);
  if (!t?.refresh_token) fail(`${account} is not signed in; run sh scripts/setup-tiktok.sh ${account}`);
  await accessToken(account).catch((e) => fail(e.message));
  const user = await userInfo(account).catch((e) => fail(e.message));
  const creator = await creatorInfo(account).catch((e) => ({ error: e.code || e.message }));
  const now = loadTokens(account);
  console.log(`Credentials OK (${activeEnv()} app) for ${user.display_name}${creator.creator_username ? ` (@${creator.creator_username})` : ''}; scopes ${now.scope}; sign-in valid until ${now.refresh_expires_at?.slice(0, 10) ?? '?'}`);
  if (creator.error) console.log(`creator_info: ${creator.error}`);
  else console.log(`Privacy options: ${creator.privacy_level_options?.join(', ')}; max video ${creator.max_video_post_duration_sec}s; comments ${creator.comment_disabled ? 'off' : 'on'}, duet ${creator.duet_disabled ? 'off' : 'on'}, stitch ${creator.stitch_disabled ? 'off' : 'on'}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const account = args.find((a) => BRANDS[a]) ?? 'rn';
  const unknown = args.filter((a) => !BRANDS[a] && !['--any', 'check'].includes(a));
  if (unknown.length) fail(`unknown argument(s): ${unknown.join(' ')}; accounts: ${Object.keys(BRANDS).join(', ')}`);
  (args.includes('check') ? check(account) : signIn(account, { any: args.includes('--any') })).catch((e) => fail(e.message));
}
