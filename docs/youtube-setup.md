# YouTube Shorts upload and analytics: one-time setup

Everything here is done by Alex on his own Mac and Google account. No value from these steps ever
goes into a chat, a commit or a terminal command line: the scripts prompt for them with the input
hidden and store them in the macOS keychain and as GitHub secrets.

Checked against Google's documentation on 2026-11-03:

- `videos.insert` costs about 100 quota units (since Dec 2025) in its own "Video Uploads" bucket, with
  a limit of 100 uploads a day. The default 10,000-unit daily quota is plenty.
- Since 2026-11-02, uploads from unverified (unaudited) API projects are **no longer forced to
  private**. Before that date every API upload from a new project stayed private until a compliance
  audit. The first real upload will confirm it; `youtube.mjs` logs the privacy YouTube actually set.
- `status.containsSyntheticMedia` (added Oct 2024) sets the "altered or synthetic content" label; the
  script sets it to `true` on every upload because the voice is synthetic.
- A consent screen left in **Testing** issues refresh tokens that **expire after 7 days**. Set it to
  **In production**. As an unverified app it shows a "Google hasn't verified this app" screen and is
  capped at 100 users; neither matters for Alex's own channel, and verification is not needed.
- Refresh tokens still stop working if unused for 6 months (the nightly analytics job uses it every
  day), if access is revoked at myaccount.google.com/permissions, or if more than 100 are issued for
  one client. If YouTube uploads start failing with `invalid_grant`, rerun step 6.

## 1. Google Cloud project

1. Go to https://console.cloud.google.com/ signed in with the Google account that owns
   @TheRNBasics (if the channel is a Brand Account, use the Google account that manages it).
2. Top bar project picker → **New project** → name it `Basics Social` → **Create**, then select it.

## 2. Enable the two APIs

1. **APIs & Services → Library**, search **YouTube Data API v3** → **Enable**.
2. Back to the Library, search **YouTube Analytics API** → **Enable**.

## 3. OAuth consent screen (Google Auth platform)

1. **Menu → Google Auth platform → Branding** → **Get started**.
2. App name `Basics Social`, user support email: Alex's address → **Next**.
3. Audience: **External** → **Next**. Contact email → **Next**. Agree to the User Data Policy →
   **Continue** → **Create**.
4. **Data Access** → **Add or remove scopes** → tick (filter for "youtube"):
   - `.../auth/youtube.upload`
   - `.../auth/youtube.readonly`
   - `.../auth/yt-analytics.readonly`

   → **Update** → **Save**.
5. **Audience** → under Publishing status click **Publish app** → **Confirm**. The status must read
   **In production** (not Testing), otherwise the token dies after 7 days. Do not submit the app for
   verification; it is not needed for Alex's own channel.

## 4. Desktop OAuth client

1. **Google Auth platform → Clients** → **Create client**.
2. Application type **Desktop app**, name `Basics Social Mac` → **Create**.
3. Leave the dialog open (or download the JSON): the next step asks for the **Client ID** and the
   **Client secret**.

## 5. Store the client and sign in (Terminal on the Mac)

Needs the GitHub CLI logged in (`gh auth status`). In the repository folder:

    sh scripts/setup-youtube.sh

It asks for the Client ID (shown) and the Client secret (hidden), stores both in the keychain
(service `icubasics-social`) and as the GitHub secrets `YT_CLIENT_ID` and `YT_CLIENT_SECRET`, then
opens the browser:

- Sign in with the account that owns @TheRNBasics and, if asked, choose the **TheRNBasics** channel.
- "Google hasn't verified this app" → **Advanced** → **Go to Basics Social (unsafe)**. It is Alex's own app.
- Tick every permission box → **Continue**.

The browser then says "Signed in", and the terminal prints the channel name and stores
`YT_REFRESH_TOKEN` in the keychain and as a GitHub secret. If it signed in to the wrong channel it
stores nothing and says so; run it again.

## 6. Test without uploading

    gh workflow run "Post Question of the Day" --repo alexgateley/icubasics-social -f brand=rn -f dry_run=true

The RN job's "Upload the RN short to YouTube" step prints `Credentials OK for The RN Basics ...` and
lists what it would upload. Locally, with the secrets in the environment, `node scripts/youtube.mjs check`
does the same check.

## 7. What uploads, and when

- Every RN short in `shorts/rn/` (noon) and `shorts-am/rn/` (7 AM) uploads right after its
  Instagram Reel posts, in the same workflow run, as a public Short in the Education category, not
  made for kids, with the altered or synthetic content label.
- Title and description come from the short's `youtube.json`, which `add-short.mjs` writes from the
  YOUTUBE SHORTS part of the Desktop captions file. A short without a YouTube part (for example the
  "Clip - HIT Heparin Clots" folder) gets no `youtube.json` and is not uploaded.
- `youtube-skip.json` lists the 21 RN shorts Alex uploaded or hand-scheduled himself (through
  Nov 27); they never upload. The script also skips any short whose title is already on the channel.
- Each upload writes `published-youtube/<slug>.json`, committed by the bot like the Instagram markers,
  so nothing uploads twice. To re-upload, delete the video on YouTube and that marker.
- Shorts scheduled before this feature have no `youtube.json` yet. Add it once per short (it only
  reads the Desktop folder and writes that one file):

      YOUTUBE_ONLY=1 node scripts/add-short.mjs "Heparin - Antidotes" heparin-antidotes
      YOUTUBE_ONLY=1 SLOT=am node scripts/add-short.mjs "STEMI - Reciprocal Changes" stemi-reciprocal

## 8. Analytics on the Mac (Instagram + YouTube)

1. Store each Instagram account for the analytics job (read-only checks first; the token is hidden):

       sh scripts/setup-keychain.sh        # @icubasics
       sh scripts/setup-keychain.sh rn     # @rnbasicsnclex
       sh scripts/setup-keychain.sh medic  # @themedicbasics

   Use the same token as the posting job or generate a fresh one in the Meta dashboard (Instagram →
   API setup with Instagram business login → Generate token). It needs the
   `instagram_business_manage_insights` permission; the script checks it and stops if it is missing.
2. The YouTube refresh token from step 5 is already in the keychain.
3. Try it: `node scripts/analytics.mjs`, then open `~/basics-growth-work/analytics/dashboard.html`.
4. Install the nightly job (2:05 AM Pacific):

       cp launchd/com.icubasics.analytics.plist ~/Library/LaunchAgents/
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.icubasics.analytics.plist

   Test it now with `launchctl kickstart gui/$(id -u)/com.icubasics.analytics`; the log is
   `~/Library/Logs/icubasics-analytics.log`. The first time the job reads the keychain macOS may ask
   to allow `security`; choose **Always Allow**.
