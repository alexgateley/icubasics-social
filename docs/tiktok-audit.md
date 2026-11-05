# TikTok app review and Direct Post audit: texts, demo script, URLs

For the TikTok app **Basics Social** (Login Kit + Content Posting API). Requirements and sources are in
[tiktok-setup.md](tiktok-setup.md); read its section 0 first: TikTok's guidelines list "a utility tool
to help upload contents to the account(s) you or your team manages" as not acceptable for Direct Post,
and that is what Basics Social is today. The texts below describe it truthfully. Do not change them to
claim users, customers or features that do not exist: a misleading submission can cost the developer
account, and the answer would come back the same once TikTok looks at it.

Paste-ready texts are in the indented blocks.

## 1. App details

**App name:** Basics Social (matches nothing on the website yet: if the reviewer asks for the name to
match the site, rename it to "RN Basics"; the website's name is RN Basics and it is published by Grip
Theory LLC per the site footer).

**Category:** Education.

**Description** (shown to users on TikTok's authorization page; keep it short):

    Basics Social posts the short nursing and paramedic exam-prep videos made for RN Basics, ICU Basics
    and Medic Basics to their TikTok accounts. You pick a video, review the caption and choose who can
    see it before anything is posted.

**Website:** https://rnbasics.com/ · **Terms:** https://rnbasics.com/terms.html · **Privacy:**
https://rnbasics.com/privacy.html

## 2. App review: how each product and scope is used

    Basics Social is a desktop posting tool for the creators of RN Basics, ICU Basics and Medic Basics,
    free exam-prep apps for nursing and paramedic students (https://rnbasics.com). We make short
    original educational videos (about 60 seconds, vertical, our own animation and narration) that
    explain clinical topics such as arterial blood gases and drug safety. Basics Social lets our team
    post those videos to our own TikTok accounts with the full Direct Post flow.

    Login Kit (Desktop): the user clicks Sign in, which opens TikTok's authorization page in the
    browser; after the user approves, TikTok redirects to http://localhost:8763/callback on the same
    computer. We use PKCE (S256, hex challenge) and a state value, exchange the code on the computer,
    and keep the tokens in the operating system's keychain. Nothing is sent to any server of ours.

    Content Posting API, Direct Post: the posting screen loads the creator's info (nickname, avatar,
    privacy options, comment/duet/stitch settings, maximum video length) every time it is shown. The
    user picks one video, sees a preview, edits the caption, chooses who can view it from the options
    TikTok returns (no default), turns comments/duet/stitch on if wanted (off by default, greyed out
    when disabled in TikTok), can disclose commercial content (Your brand / Branded content, with
    TikTok's labels and rules), and sees the Music Usage Confirmation declaration (and the Branded
    Content Policy when applicable) above the Post button. Nothing is sent until the user presses
    Post. The video is uploaded with FILE_UPLOAD from the user's computer, and the screen polls the post
    status and shows it, with a notice that processing can take a few minutes.

    Content Posting API, Upload: as an alternative, the user can send the video to their TikTok inbox
    as a draft and finish it (caption, sounds, privacy) in the TikTok app. The screen tells the user to
    open the inbox notification to complete the post.

    We add no watermark, logo or link to the videos, and post only videos the account owner made.

## 3. Scope justifications

    user.info.basic: after sign-in we read the display name and avatar to confirm which TikTok account
    was connected and to show it on the posting screen.

    video.publish: needed for creator_info (to show the account's nickname and avatar, its privacy
    options, interaction settings and maximum video length on the posting screen), to post the video
    the user chose with Direct Post, and to read that post's status.

    video.upload: lets the user send a video to their TikTok inbox as a draft instead of posting it
    directly, and read that upload's status.

## 4. Demo video: shot-by-shot script

Record in the **sandbox** (required for a never-approved app), with the target user from
tiktok-setup.md step 3 (a **private** account), using QuickTime → File → New Screen Recording, full
screen, 1080p or more. Keep it under **50 MB** (about 3-4 minutes; export at 1080p if needed). No
voice-over is needed; the on-screen text is enough, but a short narration helps. Before starting: the
sandbox client key and secret are already in the keychain (run `sh scripts/setup-tiktok.sh sandbox`
once before recording; the setup run on camera then skips the prompts and goes straight to a fresh
sign-in), and the browser is logged out of TikTok, so the whole sign-in is shown.

Every selected product and scope must be visible: Login Kit, Direct Post (`video.publish`), Upload
(`video.upload`), `user.info.basic`.

| # | Show | Notes |
|---|------|-------|
| 1 | Terminal in the repository folder. Type `sh scripts/setup-tiktok.sh sandbox` (the client key prompt is skipped because it is stored; if it is not, store it before recording, never on camera). | The secret is never typed on camera. |
| 2 | The browser opens TikTok's authorization page: the app name **Basics Social**, its icon, and the three permissions. Zoom in so the URL bar shows `www.tiktok.com/v2/auth/authorize/`. | Login Kit, scopes listed. |
| 3 | Log in as the test account and approve. The browser lands on `localhost:8763/callback` "Signed in to TikTok". The terminal prints "Signed in as TikTok account: ..." and "Stored ...". | Redirect URI and token exchange. |
| 4 | `node scripts/tiktok-poster.mjs`. The page opens at `127.0.0.1:8765` with the **Sandbox** badge. | |
| 5 | Top of the form: avatar, nickname, @username, "the video will be posted to this TikTok account". | 1a, user.info.basic + creator_info. |
| 6 | Click a short in the list (for example "ABG - Compensation"). Play 3-4 seconds of the preview. Point at "Length 0:59 · this account can post up to ...". | 5a, 1c. |
| 7 | Edit the caption on camera (add a word, remove a hashtag). | 2a, 5b. |
| 8 | Open "Who can view this video": show the placeholder and that the options are the account's own (a private account shows Followers, Friends, Only me). Close it without choosing; point at the disabled Post button and "Choose who can view this video". | 2b: no default. |
| 9 | Allow users to: show Comment unchecked; Duet and Stitch greyed out "(turned off in this account's TikTok settings)" (private accounts have them off). Tick Comment. | 2c. |
| 10 | Turn on "Disclose video content": the two checkboxes appear and Post is disabled; hover Post to show "You need to indicate if your content promotes yourself, a third party, or both." | 3a. |
| 11 | Tick **Your brand**: "Your video will be labeled as 'Promotional content'", declaration = Music Usage. Tick **Branded content**: label changes to 'Paid partnership', the declaration adds the Branded Content Policy, and in the dropdown "Only me" is disabled (hover: "Branded content visibility cannot be set to private."). | 3a, 3b, 4. |
| 12 | Choose "Only me": Branded content is unchecked and disabled with the explanation. Turn the disclosure switch off again. | 3b. |
| 13 | Click the Music Usage Confirmation link (opens TikTok's page), come back. | Declaration. |
| 14 | With "Only me" chosen, press **Post**. Show the status steps: uploaded, processing, posted, and the notice that processing can take a few minutes. | 5c, 5d, 5e. |
| 15 | Phone (screen mirror or a camera shot) or the TikTok website: the test account's profile with the new private video, caption as edited. | Proves the post. |
| 16 | Back on the page: pick another short, choose "Send to my TikTok inbox as a draft", show the text that explains the inbox, press **Send to TikTok inbox**, status "Sent to the TikTok inbox". Show the inbox notification in the TikTok app and open the draft. | video.upload. |
| 17 | End on the page with both shorts marked (posted / in inbox). | |

If the reviewer asks for a website domain match: the page runs locally on the Mac (Desktop app), and
the website URL is the product's site; say so in the review text.

## 5. URLs for the forms

| What | URL |
|------|-----|
| Website / Desktop URL | https://rnbasics.com/ |
| Terms of Service | https://rnbasics.com/terms.html (publish first: draft at QuizApp/website-drafts/terms.html) |
| Privacy Policy | https://rnbasics.com/privacy.html (add §6 below) |
| Redirect URI (Login Kit, Desktop) | http://localhost:8763/callback |
| URL prefix (verified) | https://rnbasics.com/ |
| Music Usage Confirmation (in the UI) | https://www.tiktok.com/legal/page/global/music-usage-confirmation/en |
| Branded Content Policy (in the UI) | https://www.tiktok.com/legal/page/global/bc-policy/en |
| Support / contact | contact@rnbasics.com |

## 6. Privacy policy paragraph to add (rnbasics.com/privacy.html)

The current policy says the App has no accounts, no sign-in and sends nothing but optional analytics.
That stays true for RN Basics, but TikTok reviews the privacy policy of Basics Social too. Suggested
new section before "Children's Privacy" (Alex decides the wording):

    Basics Social (our TikTok posting tool). We use a separate desktop tool, Basics Social, to post our
    own videos to our TikTok accounts through TikTok's official API. When an account holder signs in to
    TikTok through it, TikTok gives the tool an access token and basic profile information (display
    name, avatar and account identifier). These are stored only in the operating system's keychain on
    the computer that runs the tool, are used only to show which account is connected and to post the
    videos the account holder chooses, and are never sold or shared. The account holder can disconnect
    the tool at any time in TikTok's settings (Settings and privacy > Security > Apps and services
    permissions). TikTok's own privacy policy applies to TikTok.

## 7. Direct Post audit (after app approval)

The audit lifts the private-only restriction. Its application asks for usage estimates that set the
24-hour active-creator cap. Truthful numbers for today:

    Accounts that will post: 1 (RN Basics) now, up to 3 (RN Basics, ICU Basics, Medic Basics).
    Posts per day: 1-3 per account (well under TikTok's per-account cap).
    Content: original short educational videos made by the account owner; no reposting from other
    platforms.

Expect the intended-use question ("a utility tool to help upload contents to the account(s) you or
your team manages" is listed as not acceptable). If TikTok declines on that ground, the options are in
tiktok-setup.md section 0.
