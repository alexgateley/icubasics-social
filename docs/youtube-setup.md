# YouTube scheduling and analytics: one-time setup

@TheRNBasics releases **one topic per day**: the topic's long at **9:00 AM Pacific** and all of its
Shorts right after (9:05, 9:10, ...). `scripts/youtube-schedule.mjs` uploads the upload kits in
`~/Desktop/YouTube Uploads - TheRNBasics/` through the YouTube API as scheduled (private until their
time) videos. It runs on Alex's Mac, where the videos are; nothing about YouTube runs in GitHub
Actions any more, and no video, token or upload record goes into this public repository.

Steps 1-6 are done once by Alex on his own Mac and Google account. No value from these steps ever
goes into a chat, a commit or a terminal command line: the scripts prompt for them with the input
hidden and store them in the macOS login keychain (service `icubasics-social`).

Checked against Google's documentation on 2026-11-03:

- Quota: `videos.insert` has its own bucket of **100 uploads a day** (Google's quota table lists it
  at 1 unit a call). Everything else shares the default **10,000 units a day**: `thumbnails.set` 50,
  `captions.insert` 400, `playlistItems.insert` 50, `videos.update` 50, list calls 1. The quota resets
  at midnight Pacific. The 41 kits of Nov 5-15 need about 5,850 units (4 longs × 450, plus 81
  playlist adds), and the 17 moves at most 867, so the whole set fits in one day. The scheduler stops
  before 9,000 and continues on the next run.
- Since 2026-11-02, uploads from unverified (unaudited) API projects are **no longer forced to
  private**. Earlier, every API upload from a new project stayed private until a compliance audit. The
  scheduler uploads private with a publish time either way, and prints the privacy and publish time
  YouTube actually kept.
- `status.publishAt` works only with `privacyStatus` private, and `videos.update` can move it only
  while the video is private and has never been published. An update clears every status field it
  leaves out, so the reschedule sends the current ones back unchanged.
- `status.containsSyntheticMedia` sets the "altered or synthetic content" label; every upload sets it
  to `true` because the voice is synthetic.
- `captions.insert`, `videos.update` and `playlistItems.insert` need the **youtube.force-ssl** scope
  (they do not accept youtube.upload).
- The API cannot set a Short's **Related video** and cannot pin a comment. The scheduler prints
  those as a to-do list.
- A consent screen left in **Testing** issues refresh tokens that **expire after 7 days**. Set it to
  **In production**. As an unverified app it shows a "Google hasn't verified this app" screen and is
  capped at 100 users; neither matters for Alex's own channel, and verification is not needed.
- Refresh tokens still stop working if unused for 6 months (the nightly analytics job uses it every
  day), if access is revoked at myaccount.google.com/permissions, or if more than 100 are issued for
  one client. If YouTube calls start failing with `invalid_grant`, rerun step 5.

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
4. **Data Access** → **Add or remove scopes** → tick these four (filter for "youtube"):
   - `.../auth/youtube.upload`
   - `.../auth/youtube.readonly`
   - `.../auth/yt-analytics.readonly`
   - `.../auth/youtube.force-ssl` (captions, rescheduling, playlists)

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

In the repository folder:

    sh scripts/setup-youtube.sh

It asks for the Client ID (shown) and the Client secret (hidden), stores both in the keychain, then
opens the browser:

- Sign in with the account that owns @TheRNBasics and, if asked, choose the **TheRNBasics** channel.
- "Google hasn't verified this app" → **Advanced** → **Go to Basics Social (unsafe)**. It is Alex's own app.
- Tick **every** permission box → **Continue**.

The browser then says "Signed in", and the terminal prints the channel name and stores
`YT_REFRESH_TOKEN` in the keychain. If it signed in to the wrong channel, or a permission box was left
unticked, it stores nothing and says so; run it again.

## 6. Test without changing anything

    node scripts/youtube-schedule.mjs check

prints `Credentials OK for The RN Basics ...; all 4 permissions granted`. The first time the script
reads the keychain macOS may ask to allow `security`; choose **Always Allow**. Then tell Claude it is
set up.

## 7. How Claude runs the scheduler

From the repository folder on the Mac:

    node scripts/youtube-schedule.mjs --dry-run --all     # the plan; changes nothing
    node scripts/youtube-schedule.mjs --all               # upload and schedule
    node scripts/youtube-schedule.mjs --day 2026-11-06    # one day folder only

The dry run lists every kit with its publish time in Pacific and UTC, what it would do (upload,
thumbnail, captions, playlists), the playlists it found or did not find on the channel, the quota, and
the hand-work lists. Each kit becomes a private video with that publish time (Education, not made
for kids, altered or synthetic content: yes, title, description and tags from `upload.txt`); a long
also gets `thumbnail.png` and `captions.srt` (English, published, not a draft); each "Playlist
suggestion" that already exists on the channel gets the video (a name ending in "(Shorts)" also
matches the playlist without it). No playlist is created.

- **Never twice.** `~/basics-growth-work/youtube/uploaded.json` maps each kit folder to its video
  id and the steps done. A kit there is not uploaded again; a step that failed (thumbnail, captions,
  playlist) is retried by the next run on the same video. A kit that is not in the file but whose
  title is already on the channel is skipped and reported, to be checked by hand. To upload a kit
  again on purpose, delete the video on YouTube and then its entry in that file.
- **Past times.** A kit whose publish time is past, or under 15 minutes away, is skipped and listed.
- **Quota.** The run prints what it will spend, counts what it spent today in the same file, and
  leaves the rest of the kits (in order) for a run after midnight Pacific when the next one would pass
  9,000 units or 100 uploads.
- **By hand afterwards** (the API cannot do these), printed at the end of every run:
  - each Short's **Related video**: after its long goes public at 9:00 AM that day (or any time when
    the long was already public: Heparin, IV Fluids), YouTube Studio > Content > Shorts > the Short >
    Related video;
  - each long's pinned "Sources and corrections" comment, from its `upload.txt`.

### Moving videos that are already scheduled

    node scripts/youtube-schedule.mjs reschedule <videoId> 2026-11-04T09:05 --dry-run   # Pacific time
    node scripts/youtube-schedule.mjs reschedule <videoId> 2026-11-04T09:05

    node scripts/youtube-schedule.mjs reschedule-file "$HOME/Desktop/YouTube Uploads - TheRNBasics/CLAUDE TASK - Reschedule existing YouTube videos.md" --dry-run
    node scripts/youtube-schedule.mjs reschedule-file "$HOME/Desktop/YouTube Uploads - TheRNBasics/CLAUDE TASK - Reschedule existing YouTube videos.md"

`reschedule-file` reads the file's table (the Link and "Move to" columns; the year is the one in which
that date falls on the weekday given) and moves each video with `videos.update`, changing only the
publish time. It skips a video that is already public, not scheduled, not found, or whose title on
YouTube does not match the table, and prints the time YouTube shows after each save. A video already
at its new time is left alone, so running it twice is harmless.

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
   YouTube videos uploaded by the scheduler are labeled with their day's topic.
4. Install the nightly job (2:05 AM Pacific):

       cp launchd/com.icubasics.analytics.plist ~/Library/LaunchAgents/
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.icubasics.analytics.plist

   Test it now with `launchctl kickstart gui/$(id -u)/com.icubasics.analytics`; the log is
   `~/Library/Logs/icubasics-analytics.log`. The first time the job reads the keychain macOS may ask
   to allow `security`; choose **Always Allow**.

## Testing without Google

`scripts/youtube-fake-api.mjs` stands in for every Google endpoint the scheduler calls (fake
credentials, a fake channel kept in a JSON file), so the upload, resume, duplicate, quota and
reschedule paths can be run with no network and no sign-in:

    YT_FAKE_DB=/tmp/yt/db.json YT_STATE=/tmp/yt/uploaded.json \
      node --import ./scripts/youtube-fake-api.mjs scripts/youtube-schedule.mjs --day 2026-11-06
