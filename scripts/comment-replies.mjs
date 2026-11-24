// Comment-to-get for @icubasics, @rnbasicsnclex, @themedicbasics, @respiratorytherapybasics, @theerbasics, @ekgtechbasics, @npbasics, @pharmtechbasics and @medlabbasics. When someone comments a keyword from
// comment-keywords.json on a recent Reel ("SEPSIS"), this sends them one private reply (an Instagram DM tied to
// that comment) with the matching free page on the brand's site, and answers the comment publicly ("Sent you a
// DM 📩"). Runs ONLY on Alex's Mac (launchd/com.icubasics.comments.plist, every 10 minutes): tokens come from the
// login keychain (the analytics tokens, scripts/setup-keychain.sh), and what was answered is kept outside this
// public repository, because it holds commenters' comment ids.
//
//   node scripts/comment-replies.mjs            # answer new keyword comments
//   DRY_RUN=1 node scripts/comment-replies.mjs  # read comments and print what it would send; sends nothing
//   node scripts/comment-replies.mjs --check    # read-only: can each account's token list Reels and read comments?
//   ACCOUNTS=icu node scripts/comment-replies.mjs   # one account only
//
// Needs, per account (Alex, once):
//   1. Instagram app → Settings → Messages and story replies → Message controls → Connected tools →
//      "Allow access to messages" ON.
//   2. A token with instagram_business_basic, instagram_business_manage_comments and
//      instagram_business_manage_messages (tick them when generating it in the Meta dashboard), stored with
//      sh scripts/setup-keychain.sh <account>. A system-user token (EAA...) needs instagram_basic,
//      instagram_manage_comments and instagram_manage_messages instead (the Basics Posting tokens have them).
// Instagram allows one private reply per comment, within 7 days of the comment.
//
// Two kinds of token, as in publish.mjs and analytics.mjs: Instagram-login tokens (IGAA...: icu, rn, medic) use
// graph.instagram.com; Unified-login system-user tokens (EAA..., the Basics Posting app: rt, er, ekg, np, pharm, lab)
// work only on graph.facebook.com. Meta's Unified Login (a Business Integration System User token, no Facebook Page
// needed) sends private replies with the same call, POST /{ig-user-id}/messages {recipient:{comment_id}}, and
// public replies with POST /{comment-id}/replies, on graph.facebook.com (instagram_manage_messages and
// instagram_manage_comments). So the code path is the same for both kinds; only the host differs. A system-user
// account sends only when its entry below has dms: true (ekg, np, pharm, lab since 2026-11-18); rt and er still only
// read (--check) until they are turned on the same way.
//
// Calls: one media list per account per run, and a comment read only for Reels from the last 7 days whose
// comment count changed since the last run. Every write is a reply to a keyword comment; at most MAX_SENDS a run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from './keychain.mjs';

const IG_GRAPH = 'https://graph.instagram.com/v25.0';
const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const isSystemUser = (token) => String(token || '').startsWith('EAA');
const graphFor = (token) => (isSystemUser(token) ? FB_GRAPH : IG_GRAPH);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(process.env.KEYWORDS_FILE || path.join(REPO, 'comment-keywords.json'), 'utf8'));
const STATE_FILE = process.env.COMMENTS_STATE || path.join(os.homedir(), 'basics-growth-work/analytics/comment-replies.json');
const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const CHECK = process.argv.includes('--check');
const WINDOW_DAYS = 7;
const MAX_SENDS = Number(process.env.MAX_SENDS || 40);
const MAX_WORDS = 5; // "SEPSIS please 🙏" counts; a sentence that only mentions sepsis does not
const PUBLIC_REPLY = process.env.PUBLIC_REPLY !== '0';
// Keep in step with IG_ACCOUNTS in analytics.mjs
const ACCOUNTS = [
  { account: 'icu', suffix: '', userId: '17841423460793482', handle: 'icubasics' },
  { account: 'rn', suffix: '_RN', userId: '17841429422921068', handle: 'rnbasicsnclex' },
  { account: 'medic', suffix: '_MEDIC', userId: '17841420840594491', handle: 'themedicbasics' },
  // rt, er, ekg, np, pharm, lab: system-user tokens (graph.facebook.com); only the ones with dms: true send (see the top)
  { account: 'rt', suffix: '_RT', userId: '17841480403371899', handle: 'respiratorytherapybasics', dms: true },
  { account: 'er', suffix: '_ER', userId: '17841479868648523', handle: 'theerbasics', dms: true },
  { account: 'ekg', suffix: '_EKG', userId: '17841458933751960', handle: 'ekgtechbasics', dms: true, paused: true },
  { account: 'np', suffix: '_NP', userId: '17841445521547936', handle: 'npbasics', dms: true, paused: true },
  { account: 'pharm', suffix: '_PHARM', userId: '17841455056336896', handle: 'pharmtechbasics', dms: true, paused: true },
  { account: 'lab', suffix: '_LAB', userId: '17841453290927626', handle: 'medlabbasics', dms: true },
].filter((a) => !process.env.ACCOUNTS || process.env.ACCOUNTS.split(',').includes(a.account))
  // paused: Instagram shows the profile as unavailable (2026-11-18); skip until it is back
  .filter((a) => !a.paused || process.env.ACCOUNTS);

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const scrub = (s) => String(s).replace(/access_token=[^&\s"]+/g, 'access_token=…').replace(/\b(IG|EA)[A-Za-z0-9_-]{40,}/g, '…');

async function ig(token, endpoint, params = {}, body = null) {
  const GRAPH = graphFor(token);
  const url = endpoint.startsWith('https://') ? new URL(endpoint) : new URL(`${GRAPH}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(`${endpoint.split('?')[0].replace(GRAPH, '')}: ${json.error?.message ?? res.status}`);
    e.code = json.error?.code;
    throw e;
  }
  return json;
}

// ---------- keywords ----------
/** Normalized words of a comment: upper case, letters/digits only, so "sepsis!!" and "Sepsis 🙏" both match. */
const words = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Words that answer a post without asking for anything, so a one-word "Thanks" or "Wow" never gets a DM. */
const NOT_A_REQUEST = new Set(['THANKS', 'THANK', 'THX', 'TY', 'WOW', 'NICE', 'LOVE', 'COOL', 'YES', 'YEP', 'YEAH', 'NO', 'NOPE', 'OK', 'OKAY',
  'AMAZING', 'GREAT', 'AWESOME', 'TRUE', 'SAME', 'FACTS', 'LOL', 'LMAO', 'HELPFUL', 'BRILLIANT', 'PERFECT', 'AGREED', 'AGREE', 'CORRECT',
  'WRONG', 'HI', 'HELLO', 'HEY', 'GOOD', 'BEST', 'FIRE', 'GOAT', 'BRAVO', 'EXACTLY', 'REAL', 'MOOD', 'YAY', 'A', 'B', 'C', 'D']);

/** Edit distance between two short words (for misspellings like PRESSER for PRESSORS). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The keyword a comment asks for, if any.
 * 1. One of the configured keywords or aliases, in a comment of at most MAX_WORDS words ("SEPSIS please 🙏").
 * 2. A one-word comment on a post whose caption asks for a keyword (`hint`, from ctaFromCaption): that keyword.
 *    Alex 2026-11-24: "when people have one word replies its likely asking for that" ("Presser" on the PRESSORS Reel).
 * 3. A one-word comment with no hint that is a close misspelling of a keyword or alias (one letter off, two for 7+ letters). */
export function matchKeyword(text, config = CONFIG, hint = null) {
  const w = words(text);
  if (!w.length || w.length > MAX_WORDS) return null;
  const joined = ` ${w.join(' ')} `;
  for (const [key, def] of Object.entries(config.keywords)) {
    for (const k of [key, ...(def.aliases ?? [])]) if (joined.includes(` ${k} `)) return key;
  }
  if (w.length !== 1 || NOT_A_REQUEST.has(w[0]) || /^\d+$/.test(w[0])) return null;
  if (hint && config.keywords[hint]) return hint;
  let best = null;
  for (const [key, def] of Object.entries(config.keywords)) {
    for (const k of [key, ...(def.aliases ?? [])]) {
      if (k.length < 4) continue;
      const dist = distance(w[0], k);
      if (dist <= (k.length >= 7 ? 2 : 1) && (!best || dist < best.dist)) best = { key, dist };
    }
  }
  return best?.key ?? null;
}

/** What a post's caption asks for: "Comment PRESSORS and I'll DM you the free vasopressor cheat sheet." gives
 * { keyword: 'PRESSORS', word: 'PRESSORS', promise: 'the free vasopressor cheat sheet' }. keyword is null when the word
 * is not a configured keyword or alias (a caption promising something no DM can send). */
export function ctaFromCaption(caption, config = CONFIG) {
  const m = String(caption ?? '').match(/\bComment\s+["“']?([A-Za-z0-9]{2,})["”']?([^\n]*)/);
  if (!m) return null;
  const word = m[1].toUpperCase();
  let keyword = null;
  for (const [key, def] of Object.entries(config.keywords)) if ([key, ...(def.aliases ?? [])].includes(word)) { keyword = key; break; }
  const p = m[2].match(/(?:DM|send|message|text)\s+(?:you\s+)?(.+?)(?:[.!]\s|[.!]?$)/i);
  return { keyword, word, promise: p ? p[1].trim() : null };
}

/** The brand whose site serves an absolute page URL (a brand without its own pages yet borrows a sister site's page). */
const siteBrand = (url, config) => Object.keys(config.sites).find((b) => new URL(config.sites[b]).origin === new URL(url).origin);

/** The DM text for a keyword on one brand, or null when that brand has no page for it. A page is a path on the brand's
 * own site ("/sheets/x.html") or a full URL on a sister brand's site ("https://icubasics.com/sheets/x.html"), which the
 * DM names honestly ("on ICU Basics' site, our sister app"). */
export function messageFor(key, brand, config = CONFIG) {
  // A whole message set for this brand and keyword (comment-keywords.json messages), e.g. rt APP
  const custom = config.messages?.[brand]?.[key];
  if (custom) return custom;
  const def = config.keywords[key];
  const page = def?.[brand];
  if (!page) return null;
  const absolute = /^https?:\/\//.test(page);
  const url = absolute ? page : config.sites[brand] + page;
  const owner = absolute ? siteBrand(page, config) : brand;
  // The site home ("/": the free app's store buttons) is not clinical content, so no protocols note; a label that
  // already says "free" ("free app link") is not doubled
  const what = /^free\b/i.test(def.label) ? def.label : `free ${def.label}`;
  if (page === '/') return `Here's your ${what} for ${config.brandNames[brand]} 👇\n${url}`;
  const where = owner && owner !== brand && config.sites[owner] !== config.sites[brand]
    ? `on ${config.brandNames[owner]}' site, our sister app`
    : `from ${config.brandNames[brand]}`;
  return `Here's your ${what} ${where} 👇\n${url}\n\nEducation only; follow your institution's protocols.`;
}

// ---------- state ----------
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { replied: {}, counts: {} }; } };
function saveState(state) {
  const cutoff = Date.now() - 30 * 86400000;
  for (const [id, r] of Object.entries(state.replied)) if (Date.parse(r.at) < cutoff) delete state.replied[id];
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- one account ----------
async function recentReels(token, acct) {
  const json = await ig(token, `${acct.userId}/media`, { fields: 'id,timestamp,comments_count,media_product_type,caption', limit: '25' });
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  return (json.data ?? []).filter((m) => Date.parse(m.timestamp) >= cutoff);
}

async function comments(token, mediaId) {
  const out = [];
  let next = null;
  for (let page = 0; page < 5; page++) {
    const json = next ? await ig(token, next) : await ig(token, `${mediaId}/comments`, { fields: 'id,text,timestamp,from', limit: '50' });
    out.push(...(json.data ?? []));
    next = json.paging?.next;
    if (!next) break;
  }
  return out;
}

async function runAccount(acct, state, budget) {
  const token = readSecret(`IG_ACCESS_TOKEN${acct.suffix}`);
  if (!token) { log(`@${acct.handle}: no token in the keychain (sh scripts/setup-keychain.sh ${acct.account}); skipped`); return 0; }
  if (!acct.userId) acct.userId = readSecret(`IG_USER_ID${acct.suffix}`);
  if (!acct.userId) { log(`@${acct.handle}: no Instagram user ID in the keychain (sh scripts/setup-keychain.sh ${acct.account}); skipped`); return 0; }
  const reels = await recentReels(token, acct);
  if (CHECK) {
    const withComments = reels.find((m) => m.comments_count > 0);
    if (withComments) await comments(token, withComments.id);
    log(`@${acct.handle}: OK, ${reels.length} posts in the last ${WINDOW_DAYS} days${withComments ? ', comments readable' : ', none with comments to test'}. Sending is tested only by a real keyword comment.`);
    return 0;
  }
  if (isSystemUser(token) && !acct.dms) {
    log(`@${acct.handle}: system-user token without dms: true in ACCOUNTS; read-only, nothing sent`);
    return 0;
  }
  let sent = 0;
  for (const m of reels) {
    const key = `${acct.account}:${m.id}`;
    if (!m.comments_count || state.counts[key] === m.comments_count) continue;
    const list = await comments(token, m.id);
    let pending = false;
    for (const c of list) {
      if (state.replied[c.id] || c.from?.id === acct.userId || c.from?.username === acct.handle) continue;
      if (Date.now() - Date.parse(c.timestamp) > WINDOW_DAYS * 86400000) continue;
      const keyword = matchKeyword(c.text, CONFIG, ctaFromCaption(m.caption)?.keyword);
      if (!keyword) continue;
      const text = messageFor(keyword, acct.account);
      if (!text) { state.replied[c.id] = { at: new Date().toISOString(), account: acct.account, keyword, status: 'no page for this brand' }; continue; }
      if (sent >= budget) { pending = true; break; }
      if (DRY) { log(`@${acct.handle}: DRY RUN would DM ${keyword} for comment ${c.id}:\n${text}`); sent++; continue; }
      try {
        await ig(token, `${acct.userId}/messages`, {}, { recipient: { comment_id: c.id }, message: { text } });
        state.replied[c.id] = { at: new Date().toISOString(), account: acct.account, keyword, status: 'sent' };
        sent++;
        log(`@${acct.handle}: sent ${keyword} for comment ${c.id}`);
      } catch (e) {
        // A system-user (EAA) token refused this way every time (rt, 2026-11-19, every comment): on graph.facebook.com a
        // private reply goes out from the Instagram account's linked Facebook Page with a Page access token, and the
        // Basics Posting system user has no Page assigned. That is setup, not the comment, so no try is counted: the
        // comment waits (up to Instagram's 7 days) until the account can send, instead of being given up after three runs.
        if (isSystemUser(token) && /invalid for a private reply/i.test(e.message)) {
          log(`@${acct.handle}: Instagram will not take private replies from this token (${scrub(e.message)}); nothing counted as a try. Keyword comments wait until the account is set up for DMs (linked Facebook Page assigned to the system user, or an Instagram-login token)`);
          return sent;
        }
        state.tries ??= {};
        const tries = (state.tries[c.id] ?? 0) + 1;
        state.tries[c.id] = tries;
        log(`@${acct.handle}: DM failed for comment ${c.id} (${scrub(e.message)}), try ${tries}`);
        // After three failures stop retrying that comment
        if (tries >= 3) { state.replied[c.id] = { at: new Date().toISOString(), account: acct.account, keyword, status: `failed: ${scrub(e.message)}` }; delete state.tries[c.id]; }
        pending = true;
        // A permission error will fail for every comment: stop this account until the setup is fixed
        if ([3, 10, 200, 230, 551].includes(e.code)) { log(`@${acct.handle}: looks like a permission or messaging-access problem; see the setup steps at the top of this script`); return sent; }
        continue;
      }
      if (PUBLIC_REPLY) {
        try { await ig(token, `${c.id}/replies`, { message: 'Sent you a DM 📩' }, {}); }
        catch (e) { log(`@${acct.handle}: public reply failed for comment ${c.id} (${scrub(e.message)}); the DM went out`); }
      }
    }
    if (!pending && !DRY) state.counts[key] = m.comments_count;
  }
  return sent;
}

async function main() {
  const state = readState();
  let budget = MAX_SENDS;
  let failed = false;
  for (const acct of ACCOUNTS) {
    try { budget -= await runAccount(acct, state, budget); }
    catch (e) { failed = true; log(`@${acct.handle}: ${scrub(e.message)}`); }
  }
  if (!CHECK && !DRY) saveState(state);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
