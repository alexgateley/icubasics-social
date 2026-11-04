# TikTok posting: requirements and one-time setup

The Basics shorts go to TikTok through TikTok's own **Content Posting API**, from a local posting page
on Alex's Mac (`scripts/tiktok-poster.mjs`). The page lists the shorts in
`~/Desktop/Social Media Uploads/<topic>/short - <Brand> Basics.mp4`, fills in the TikTok caption from
`short - captions and tags.txt`, and posts the one Alex picks. No video, token or post record goes into
this public repository: the app's credentials and each account's tokens are in the macOS login
keychain (service `icubasics-social`), and the record of what was posted is
`~/basics-growth-work/tiktok/posted.json`.

The TikTok app already exists (set up 2026-11-03): **Basics Social**, Desktop platform, website
`https://rnbasics.com/`, URL prefix `https://rnbasics.com/` verified, privacy policy
`https://rnbasics.com/privacy.html`, terms `https://rnbasics.com/terms.html` (**not live yet**; the
draft is `QuizApp/website-drafts/terms.html`), Login Kit + Content Posting API with Direct Post on,
scopes `user.info.basic`, `video.publish`, `video.upload`, Login Kit Desktop redirect URI
`http://localhost:8763/callback`, and a sandbox **Basics Sandbox** with the same configuration.

Section 1 lists what TikTok requires, each with the page it comes from (all read on 2026-11-03 from
developers.tiktok.com, HTML pages only). Section 2 is Alex's remaining steps. Section 3 is how the
posting page meets the Direct Post UX rules. The audit and app review texts and the demo-video script
are in [tiktok-audit.md](tiktok-audit.md).

## 0. Read this first: the intended-use rule

TikTok's Direct Post guidelines list, under **Intended Use**, as *not acceptable*: "A utility tool to
help upload contents to the account(s) you or your team manages", and require that clients "must not
be limited to test applications and should be intended for a wide audience, not limited to internal
groups/private use" (https://developers.tiktok.com/doc/content-sharing-guidelines). The App Review
Guidelines say "Apps must not be for private or personal use"
(https://developers.tiktok.com/doc/app-review-guidelines).

Basics Social is exactly a tool for posting to accounts Alex manages. So, honestly:

- **The sandbox and an unaudited app work today**, within the limits in 1.6: posts are "Only me"
  (`SELF_ONLY`) to an account that is **private** at the time of posting, up to 5 posting accounts
  a day. That is enough to build, test and record the demo; it is not enough to publish public
  TikToks from @thernbasics.
- **Production approval and the Direct Post audit are likely to be refused** for this use case as
  described. The audit texts in tiktok-audit.md describe the tool truthfully; they do not dress it up
  as a public product, because a misleading application risks the developer account.
- **What would change the answer:** offering the poster to other creators (for example, letting
  nursing educators post their own content), which is a real product decision for Alex, or using a
  scheduling tool that already passed TikTok's audit (the Postiz route Alex set aside), or posting by
  hand in the TikTok app (the caption file is already written for it).
- **Upload to inbox (`video.upload`) is the fallback the page already supports:** the video lands in
  the account's TikTok inbox as a draft and Alex finishes it in the app (caption pasted, music, who can
  view). TikTok's Upload pages state no private-only or audit restriction for it (unlike Direct Post),
  but the app itself still needs to be approved for production; in the sandbox it should work for
  target users. **Unverified until the first sandbox run.**

## 1. What TikTok requires (with sources)

### 1.1 App registration and review
Source: https://developers.tiktok.com/doc/getting-started-create-an-app,
https://developers.tiktok.com/doc/app-review-guidelines, https://developers.tiktok.com/doc/getting-started-faq

- App icon **1024 × 1024 px**, JPEG/JPG/PNG, up to **5 MB**; clear, consistent with the app name, not
  confusable with another brand.
- App name: custom, no reference to TikTok or other social media, should match the app or website name
  and not describe the app.
- Description is shown to users on the authorization page. "Apps must not be for private or personal
  use"; apps in development or testing are not approved.
- Web and Desktop platforms need the **official website URL**: an externally facing, fully developed
  site, not a landing or login page. **Privacy Policy and Terms of Service links must be visible on the
  website URL without opening a menu**, and active.
- For apps created after 2024-09-09, the Terms of Service URL, Privacy Policy URL and Web/Desktop URL
  must be **verified** (URL properties: DNS for a domain, or a signature file for a URL prefix). In the
  sandbox, verification is needed only for the Content Posting API.
- App review needs a detailed explanation of each product and scope, and **at least one demo video**
  (up to 5, 50 MB each) of the complete end-to-end flow; a never-approved app must record it **in the
  sandbox**; every selected product and scope must be shown; for a web app the domain in the video must
  match the website URL. Review takes "several days to two weeks".
- Products: Login Kit and Content Posting API (Direct Post turned on in its settings for posting to
  profiles). Remove products and scopes you do not use before review.

### 1.2 Sandbox
Source: https://developers.tiktok.com/doc/add-a-sandbox

- Up to 5 sandboxes; changes take effect with **Apply changes**. Sandbox credentials differ from
  production ones.
- **Target users**: up to **10 TikTok accounts you own**, added under Sandbox settings by logging in
  to each and accepting the TikTok Developer Terms; they can take up to an hour to appear. Only target
  users can authorize the sandbox app.
- "Sandbox mode does not offer access to Content Posting API for public videos."

### 1.3 Login Kit for Desktop (OAuth 2.0 v2 with PKCE)
Source: https://developers.tiktok.com/doc/login-kit-desktop

- Authorization page `https://www.tiktok.com/v2/auth/authorize/` with `client_key`, `scope`
  (**comma-separated**), `redirect_uri`, `state`, `response_type=code`, `code_challenge`,
  `code_challenge_method=S256`.
- **PKCE is required for desktop apps.** Verifier: 43-128 characters from `[A-Z] [a-z] [0-9] - . _ ~`,
  new for each request. Challenge: "You must use **hex encoding of SHA256**" (not base64url).
- Redirect URIs: up to 10, under 512 characters, absolute, http or https, static (no query or
  fragment), **"Only localhost or loopback IP 127.0.0.1 are allowed host names"**, a **port is
  required**, a wildcard port `*` is supported. Examples: `http://localhost:3455/callback/`,
  `http://127.0.0.1:*/callback/`. Ours: `http://localhost:8763/callback`.
- The callback carries `code`, `scopes` (granted, comma-separated), `state`, or `error` and
  `error_description`. The user can deny some scopes, so the granted list must be checked.

### 1.4 Tokens
Sources: https://developers.tiktok.com/doc/oauth-user-access-token-management,
https://developers.tiktok.com/docs/en/oauth-get-a-user-access-token,
https://developers.tiktok.com/docs/en/oauth-refresh-a-user-access-token

- `POST https://open.tiktokapis.com/v2/oauth/token/`, `application/x-www-form-urlencoded`:
  `client_key`, `client_secret`, `code` (URL-decoded), `grant_type=authorization_code`,
  `redirect_uri` (exactly the one sent to the authorization page), and `code_verifier` (required for
  desktop and mobile).
- **Access token: 2 hours** (`expires_in`). **Refresh token: 180 days** (`refresh_expires_in`).
- **Refresh tokens rotate**: every refresh returns a new `refresh_token` and the old one stops working
  at once; keep using a replaced one and the user must sign in again. The scripts save the new one
  before doing anything else and never refresh the same account twice at once.
- Keep the client secret on the server; never embed it in open-source code (also in
  https://developers.tiktok.com/doc/content-sharing-guidelines, Technical Considerations 1).

### 1.5 Scopes
Source: https://developers.tiktok.com/doc/tiktok-api-scopes, https://developers.tiktok.com/doc/scopes-overview

- `user.info.basic`: open id, avatar, display name (added by default with Login Kit).
- `video.publish`: "Directly post content to a user's TikTok profile" (Direct Post, creator_info,
  post status).
- `video.upload`: "Share content to creator's account as a draft to further edit and post in TikTok"
  (Upload, post status).

### 1.6 Content Posting API: Direct Post
Sources: https://developers.tiktok.com/doc/content-posting-api-get-started,
https://developers.tiktok.com/doc/content-posting-api-reference-direct-post,
https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info,
https://developers.tiktok.com/doc/content-sharing-guidelines

- Flow: `POST /v2/post/publish/creator_info/query/` → `POST /v2/post/publish/video/init/` →
  `PUT upload_url` (FILE_UPLOAD) → `POST /v2/post/publish/status/fetch/`. Host
  `https://open.tiktokapis.com`, `Authorization: Bearer`, `Content-Type: application/json; charset=UTF-8`.
- creator_info returns `creator_avatar_url` (valid 2 hours), `creator_username`, `creator_nickname`,
  `privacy_level_options` (public account: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`;
  private account: `FOLLOWER_OF_CREATOR`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`), `comment_disabled`,
  `duet_disabled`, `stitch_disabled` (true for private accounts too), `max_video_post_duration_sec`.
  Errors: `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`.
- init `post_info`: `privacy_level` (required, must be one of `privacy_level_options`), `title`
  (**up to 2,200 UTF-16 units**, hashtags and mentions recognised), `disable_comment`, `disable_duet`,
  `disable_stitch`, `video_cover_timestamp_ms`, `brand_content_toggle` (paid partnership),
  `brand_organic_toggle` (own business), `is_aigc` (AI-generated label). Response `publish_id` and,
  for FILE_UPLOAD, `upload_url` (**valid one hour**). Errors include
  `unaudited_client_can_only_post_to_private_accounts`, `privacy_level_option_mismatch`,
  `url_ownership_unverified`, `reached_active_user_cap`.
- **Unaudited clients**: "All content posted by unaudited clients will be restricted to private
  viewing mode." Up to **5 users posting per 24 hours**; every posting account **must be private** at
  the time of posting; only **`SELF_ONLY`**. To make such a post public later, the owner must make the
  account public and then change each post to "Everyone".
- **Every client**: a 24-hour active-creator cap (set from the usage estimate in the audit application)
  and a posting cap per creator account, "typically around **15 posts per day**", shared across all
  apps that use Direct Post.
- Watermarks: no brand name, logo, watermark, link or promotional text may be added to shared content.

### 1.7 Upload as a draft (inbox)
Sources: https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content,
https://developers.tiktok.com/doc/content-posting-api-reference-upload-video

- `POST /v2/post/publish/inbox/video/init/` (`video.upload`), `source_info` only: **no caption or
  privacy** is sent; the creator finishes in TikTok after tapping the inbox notification, and the app
  must tell users so.
- At most **5 pending shares per 24 hours** (`spam_risk_too_many_pending_share`).

### 1.8 Media transfer (FILE_UPLOAD vs PULL_FROM_URL)
Source: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide

- FILE_UPLOAD chunks: `total_chunk_count = floor(video_size / chunk_size)`; each chunk **5-64 MB**,
  except the last, which takes the trailing bytes (up to **128 MB**); a file **under 5 MB goes in one
  piece** (`chunk_size = video_size`); **over 64 MB must be chunked**; 1-1000 chunks; uploaded
  **sequentially**. Each PUT: `Content-Type` (`video/mp4`, `video/quicktime`, `video/webm`),
  `Content-Length`, `Content-Range: bytes first-last/total`. Answers: **206** per chunk, **201** when
  complete; 400 bad headers, 403 URL expired, 404 no task, 416 range out of step, 5xx retry the chunk.
  Our shorts (6-12 MB) go in one chunk.
- PULL_FROM_URL: the URL must be under a **verified domain or URL prefix** (`https://` + host + path +
  `/`, no IP host), **https, no redirects**, reachable for the whole download (one-hour timeout).
  TikTok's guidelines say to use FILE_UPLOAD for videos on the user's own computer and PULL_FROM_URL
  for videos already on a server (Technical Considerations 2). The shorts are on the Mac, so the poster
  uses **FILE_UPLOAD**; the verified `https://rnbasics.com/` prefix is not used for media.
- Videos: MP4 (recommended), WebM, MOV; H.264 (recommended), H.265, VP8, VP9; **23-60 fps**;
  **360-4096 px** each side; **up to 4 GB**; every creator can post 3 minutes, some 5 or 10; the API
  takes up to 10 minutes. The shorts are H.264 1080 × 1920, 30 fps, about 60 s.

### 1.9 Post status
Source: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status

- Statuses: `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`,
  `FAILED` (+ `fail_reason`: `file_format_check_failed`, `duration_check_failed`,
  `frame_rate_check_failed`, `picture_size_check_failed`, `internal` (retryable), `spam_risk_text`,
  `spam_risk`, `auth_removed`, ...). `publicaly_available_post_id` (int64, so 19 digits: parsed as text
  to stay exact) arrives only for public posts after moderation, "usually within one minute", sometimes
  hours.
- Webhooks exist (`post.publish.complete`, `post.publish.failed`, ...) but need a public URL; the
  local page polls instead.

### 1.10 Rate limits
Sources: the endpoint pages above and https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit

- creator_info **20/min**, video init and inbox init **6/min**, status fetch **30/min**, per user
  access token; `/v2/user/info/` 600/min. Over the limit: HTTP 429 `rate_limit_exceeded`. The page
  polls the status every 5 seconds (12/min).

### 1.11 Direct Post UX rules (what the posting screen must show)
Source: https://developers.tiktok.com/doc/content-sharing-guidelines, "Required UX Implementation in Your App".
How the page meets each one is in section 3.

1. Fetch the latest creator info when rendering the page. (a) Show the creator's **nickname**.
   (b) If creator_info says the creator cannot post now, stop and tell the user to try later.
   (c) Check the video length against `max_video_post_duration_sec`.
2. Let the user enter or select: (a) **title**; (b) **privacy** from `privacy_level_options`, chosen
   manually from a **dropdown with no default**; (c) **Allow Comment, Duet, Stitch**: greyed out and
   disabled when the creator turned them off, **none checked by default**. Before the publish button:
   "By posting, you agree to TikTok's Music Usage Confirmation" (linked to
   https://www.tiktok.com/legal/page/global/music-usage-confirmation/en).
3. Commercial content: (a) a disclosure toggle, **off by default**; when on, checkboxes **"Your brand"**
   ("Your photo/video will be labeled as 'Promotional content'") and **"Branded content"** ("... labeled
   as 'Paid partnership'"; both checked: 'Paid partnership'); with the toggle on and nothing checked,
   the publish button is disabled and hovering it says "You need to indicate if your content promotes
   yourself, a third party, or both." (b) Branded content can only be public or friends: with "only me"
   selected, disable Branded content (or switch to public and say so); with Branded content checked,
   disable "only me", hover text "Branded content visibility cannot be set to private."
4. Declarations: only Your brand, the Music Usage one; Branded content (alone or with Your brand): "By
   posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation" (Branded Content
   Policy: https://www.tiktok.com/legal/page/global/bc-policy/en).
5. (a) Show a **preview**. (b) Add no watermark or logo; preset text, title and hashtags included, must
   be **editable**. (c) Send nothing to TikTok until the user **expressly consents** to the upload.
   (d) Tell users it **may take a few minutes** to process and appear on the profile. (e) Poll
   status/fetch (or use webhooks) so users see the post's **status**.

The avatar is not required (only the nickname); the page shows both.

### 1.12 Automated or scheduled posting
None of these pages describes scheduled or unattended posting. Rules 2b (privacy chosen by hand, no
default) and 5c (content sent only after the user expressly consents to that upload) mean every Direct
Post needs a person on the posting screen. So there is **no scheduled CLI**: every post goes through
the page. (A later "queue now, post at 9 AM" would need TikTok's written confirmation first; TikTok's
API has no scheduled publish time either.)

## 2. Alex's steps

Steps 1-3 are done (the app, products, scopes, redirect URI, URL prefix, sandbox). For reference, the
values are at the top of this file. Nothing from these steps ever goes into a chat, a commit or a
command line: the script asks for the secret with the input hidden.

### 1. Developer account and app (done)
developers.tiktok.com → sign up with email → **Manage apps** → **Connect an app** → app **Basics
Social**, icon 1024 × 1024 PNG, category Education, description (tiktok-audit.md §1), platform
**Desktop** with website `https://rnbasics.com/`, Terms and Privacy URLs.

### 2. Products, scopes, redirect URI, URL properties (done)
**Add products** → Login Kit (Desktop redirect URI `http://localhost:8763/callback`) and Content
Posting API (**Direct Post** on). Scopes `user.info.basic`, `video.publish`, `video.upload` only.
**URL properties** → `https://rnbasics.com/` verified by URL prefix (keep the signature file on the
site).

### 3. Sandbox (done) and its target user
1. App page → toggle **Sandbox** → **Basics Sandbox** → **Sandbox settings** → **Target users** →
   **Add account** → log in to the TikTok account to test with → accept the Developer Terms. It can take
   up to an hour to show.
2. **Which account:** unaudited and sandbox posting only works to an account that is **private** at
   posting time, and only as "Only me". Making @thernbasics private would hide it from its followers
   during the test, so the better choice is a **separate test TikTok account** (set to private in TikTok
   → Profile → ☰ → Settings and privacy → Privacy → Private account). Use @thernbasics only if a short
   private window is acceptable.
3. If any setting changed: **Apply changes**.

### 4. Publish the Terms page (Alex)
1. Review `QuizApp/website-drafts/terms.html` (it names the operator exactly as the privacy page does:
   "Alex G"; see the note at the top of the draft).
2. Copy it to the RN site as `terms.html`, and add a **Terms** link next to "Privacy policy" in the
   footer of the home page (TikTok wants both links visible on `https://rnbasics.com/` without opening
   a menu). Publish as usual for the RN site.
3. Add the TikTok paragraph to the privacy page (suggested text in tiktok-audit.md §6), because the
   current one says the App collects nothing and has no sign-in, which does not cover Basics Social.
4. In the app's **URL properties**, confirm `https://rnbasics.com/terms.html` shows as verified (it is
   under the verified prefix).

### 5. Store the sandbox credentials and sign in (Terminal on the Mac)

    sh scripts/setup-tiktok.sh

Answer **1** (Sandbox). It asks for the Client key (shown) and Client secret (hidden); both are on the
app page with the toggle on Sandbox → Basics Sandbox → **App details → Credentials**. It stores them in
the keychain, makes sandbox the active app, and opens the browser:

- Log in as the target user from step 3 and allow every permission.
- The browser says "Signed in to TikTok"; the terminal prints the account and stores its tokens.

The script checks that the account is RN Basics. For a separate test account, run
`sh scripts/setup-tiktok.sh sandbox rn --any` instead. If a permission was unticked or it is the
wrong account, nothing is stored; run it again.

### 6. Check without posting

    node scripts/tiktok-auth.mjs rn check

prints the account, the scopes, the sign-in expiry, and the creator settings (privacy options, max
length). The first keychain read may ask to allow `security`: **Always Allow**.

### 7. Open the posting page

    node scripts/tiktok-poster.mjs

It opens `http://127.0.0.1:8765/`. Pick a short, check the caption, choose **Only me** (the only
choice a sandbox/unaudited app can use, on a private account), and press **Post**. The post shows on
the account's profile as private within a few minutes.

### 8. Record the demo video and submit for review
Follow the shot list in tiktok-audit.md §4 (QuickTime → File → New Screen Recording), keep it under
50 MB, then on the app page (toggle **Production**): **Import** the sandbox configuration into the
draft if anything differs, fill **App review** with the texts in tiktok-audit.md §1-3, upload the
video, **Submit for review**. Read section 0 first.

### 9. After approval: production credentials
TikTok gives production its own Client key and secret. Run

    sh scripts/setup-tiktok.sh production

and sign in again (sandbox sign-ins do not carry over). `TIKTOK_ACTIVE_ENV` in the keychain then says
production, and the page's badge reads Production. Public posting still needs the Direct Post audit
(the "Why are my posts private" answer in the App Review FAQ); until then posts stay "Only me".

## 3. The posting page (scripts/tiktok-poster.mjs + tiktok-poster.html)

    node scripts/tiktok-poster.mjs                       # http://127.0.0.1:8765/
    TIKTOK_FAKE_DIR=/tmp/tt node --import ./scripts/tiktok-fake-api.mjs scripts/tiktok-poster.mjs   # fake TikTok, real shorts
    node scripts/tiktok-test.mjs                         # offline tests (fake API, temp folders)

- Lists every topic folder with `short - <Brand> Basics.mp4` for the chosen account (rn: RN Basics,
  icu, medic), its length, and whether it was already sent (posted.json). Caption: the TIKTOK block of
  that brand's section in `short - captions and tags.txt`; without one, the brand's Instagram caption,
  flagged "edit it for TikTok".
- Rule 1: creator_info is fetched when the account changes and each time a short is opened, and again
  on the server when Post is pressed; 1a nickname, @username and avatar on top; 1b a creator_info error
  (posting cap, banned, app cap) pauses posting with TikTok's reason; 1c the length is read from the MP4
  and compared with `max_video_post_duration_sec`.
- Rule 2: editable caption with a 2,200 counter; "Who can view this video" dropdown built from
  `privacy_level_options` with a disabled placeholder and no default; Comment, Duet, Stitch unchecked,
  greyed out with "(turned off in this account's TikTok settings)" when creator_info says so; the Music
  Usage declaration with its link right above Post.
- Rule 3: "Disclose video content" switch off by default; Your brand / Branded content with TikTok's
  label texts; Post disabled with the hover text while nothing is checked; "Only me" disabled with the
  hover text while Branded content is checked; Branded content disabled with an explanation while "Only
  me" is selected.
- Rule 4: the declaration switches to "Branded Content Policy and Music Usage Confirmation" when
  Branded content is checked.
- Rule 5: video preview of the exact file; nothing added to the video; nothing sent before the Post
  click (the server refuses a request without it); the processing notice under the button; status
  polled every 5 s and shown as steps, ending in the TikTok link (public posts) or the fail reason.
- Extra: "Label this video as AI-generated" (`is_aigc`), ticked when the caption file says the voice is
  AI, and the "Send to my TikTok inbox as a draft" mode (`video.upload`) with a Copy caption button.
- The server re-checks every rule before calling TikTok, accepts requests only with the page's per-run
  token and a 127.0.0.1/localhost Host header, and keeps the file paths to itself.
- Already sent: the page shows when and the link, and asks for an explicit "post again" tick.

### Errors you may see
- "Until TikTok audits this app, it can post only to a private account, as Only me": choose Only me,
  and make the account private in TikTok.
- "posting limit for the last 24 hours" (about 15 a day per account, shared with every app).
- "5 drafts waiting in this account's TikTok inbox": post or delete them in the app.
- "The TikTok sign-in is no longer valid" / "token refresh failed": `sh scripts/setup-tiktok.sh`
  (after 180 days without a refresh, or after removing the app in TikTok's settings).
