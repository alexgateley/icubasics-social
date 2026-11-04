// One-time on Alex's Mac: signs in to the @TheRNBasics YouTube channel in the browser and stores the
// OAuth refresh token in the login keychain (service icubasics-social), without it ever appearing on
// screen. Run it through scripts/setup-youtube.sh, which first stores YT_CLIENT_ID and YT_CLIENT_SECRET
// (docs/youtube-setup.md). Everything that uses YouTube runs on the Mac, so nothing goes to GitHub.
//
//   node scripts/youtube-auth.mjs
//
// It uses Google's loopback flow for desktop apps: a one-shot server on 127.0.0.1 receives the code,
// PKCE protects the exchange, and prompt=consent makes Google return a refresh token every time.
// Scopes (the same list as SCOPES in youtube-schedule.mjs, which checks them; checked against
// Google's method pages on 2026-11-03):
//   youtube.upload         videos.insert and thumbnails.set (scripts/youtube-schedule.mjs)
//   youtube.readonly       channel, uploads and playlist lists (youtube-schedule.mjs, analytics.mjs)
//   yt-analytics.readonly  YouTube Analytics reports (scripts/analytics.mjs)
//   youtube.force-ssl      captions.insert, videos.update (reschedule) and playlistItems.insert; none of
//                          the three accepts youtube.upload
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readSecret, writeSecret } from './keychain.mjs';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

const clientId = readSecret('YT_CLIENT_ID');
const clientSecret = readSecret('YT_CLIENT_SECRET');
if (!clientId || !clientSecret) fail('YT_CLIENT_ID and YT_CLIENT_SECRET are not in the keychain; run sh scripts/setup-youtube.sh');

const b64url = (buf) => buf.toString('base64url');
const verifier = b64url(crypto.randomBytes(48));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

/** Waits for Google to redirect the browser back with ?code=...; resolves with the code and redirect URI. */
function receiveCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? '<p>Signed in. You can close this tab and go back to the terminal.</p>' : '<p>Sign-in did not complete. Go back to the terminal.</p>');
      server.close();
      if (ok) resolve({ code: url.searchParams.get('code'), redirectUri: server.redirectUri });
      else reject(new Error(url.searchParams.get('error') || 'state mismatch or no code'));
    });
    server.listen(0, '127.0.0.1', () => {
      server.redirectUri = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId, redirect_uri: server.redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      console.log('Opening the browser. Sign in with the Google account that owns @TheRNBasics and, if asked,\npick the TheRNBasics channel. "Google hasn\'t verified this app" is expected: Advanced → Go to (app).');
      execFileSync('open', [auth.toString()]);
    });
    setTimeout(() => { server.close(); reject(new Error('no answer from the browser within 5 minutes')); }, 300000).unref();
  });
}

const { code, redirectUri } = await receiveCode().catch((e) => fail(e.message));
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
});
const tokens = await res.json();
if (!res.ok || !tokens.refresh_token) fail(`token exchange failed: ${tokens.error ?? res.status} ${tokens.error_description ?? '(no refresh token returned)'}`);
const granted = (tokens.scope ?? '').split(' ');
const missing = SCOPES.filter((s) => !granted.includes(s));
if (missing.length) fail(`these permissions were not granted (tick every box on the consent screen and rerun): ${missing.join(', ')}`);

// Make sure this is the right channel before storing anything
const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json();
const channel = ch.items?.[0]?.snippet;
if (!channel) fail('signed in, but that Google account has no YouTube channel; rerun and pick TheRNBasics');
console.log(`Signed in as channel: ${channel.title} (${channel.customUrl ?? ''})`);
if (!/rn\s*basics/i.test(`${channel.title} ${channel.customUrl}`)) fail('that is not @TheRNBasics; nothing was stored. Rerun and choose the TheRNBasics channel.');

writeSecret('YT_REFRESH_TOKEN', tokens.refresh_token);
console.log('Stored YT_REFRESH_TOKEN in the keychain (service icubasics-social).');
console.log('Done. Test (read-only): node scripts/youtube-schedule.mjs check');
