# ICU Basics and RN Basics · Question of the Day

Rendered Instagram posts for [@icubasics](https://www.instagram.com/icubasics) and
[@rnbasicsnclex](https://www.instagram.com/rnbasicsnclex), served from GitHub Pages, and a daily
GitHub Actions job that publishes each account's carousel at 7:00 AM Central.

The posts are generated from the [ICU Basics](https://apps.apple.com/app/id6809866200) question
banks by `scripts/social/push-month.sh` in the app repo, which renders a month of slides and
pushes them here.

```
posts/<date>-<exam>/1-question.jpg   slide 1
posts/<date>-<exam>/2-answer.jpg     slide 2
posts/<date>-<exam>/caption.txt      caption with hashtags
posts/index.json                     date → folder
posts/<date>-<exam>/reel.mp4         the same question as a 34-second Reel (optional)
published/<date>.json                written by the job after posting (prevents double posts)
published/<date>-reel.json           the same for the Reel
posts-rn/..., published-rn/...       the same for RN Basics (NCLEX questions, @rnbasicsnclex)
```

Generate RN Basics posts with `BRAND=rn scripts/social/push-month.sh <start> <days>` in the app repo.

## One-time setup

1. **GitHub Pages:** repo Settings → Pages → Source "Deploy from a branch", branch `main`, folder `/ (root)`.
   Images are then served at `https://alexgateley.github.io/icubasics-social/posts/...`.
2. **Meta app:** at developers.facebook.com/apps create an app with the use case "Manage messaging
   and content on Instagram" (Business app). In the left menu open Instagram → "API setup with
   Instagram business login". Under "Generate access tokens" click Add account and log in as
   @icubasics (a professional account), then under permissions click "Add all required permissions"
   and also add `instagram_business_content_publish`. Click Generate token, log in, and copy the
   **Instagram user ID** and the **access token** (long-lived, 60 days). The app can stay in
   development mode: accounts with a role on the app need no App Review.
3. **Secrets:** run `sh scripts/setup-secrets.sh` (prompts for the values, never shows the token,
   checks it against the API), or add them by hand at repo Settings → Secrets and variables → Actions:
   - `IG_USER_ID` – the Instagram user id
   - `IG_ACCESS_TOKEN` – the long-lived token (60 days)
   - `GH_PAT` (optional but recommended) – a fine-grained personal access token for this repo with
     *Secrets: Read and write*, so the job can store the refreshed token every Sunday. Without it,
     regenerate the token in the Meta dashboard every 60 days.
4. **Test:** Actions → "Post Question of the Day" → Run workflow with `dry_run` checked, then once
   more with a `date` to post for real.
5. **RN Basics:** repeat step 2 in the same Meta app, adding @rnbasicsnclex under "Generate access
   tokens" (it must be a professional account), then `sh scripts/setup-secrets.sh rn`, which stores
   `IG_USER_ID_RN` and `IG_ACCESS_TOKEN_RN`. Until those exist the RN job skips with a notice.
   Test with `gh workflow run "Post Question of the Day" -f brand=rn -f dry_run=true`.

## Every month

In the app repo: `scripts/social/push-month.sh 2026-12-01 31`. It renders the posts, copies them
here, updates `index.json`, and pushes. The job picks them up on their dates.

## Notes

- Since 2026-10-29 the question Reel posts on **Tuesdays and Thursdays**, and since 2026-11-02 also on **Saturdays and Sundays** (`QOTD_DAYS`, default `0,2,4,6`), plus any date listed for a brand in `qotd-extra-dates.json` (used where a day's short is missing, so each account still gets two videos); explainer shorts take Monday, Wednesday and Friday (posted automatically at noon Chicago since 2026-10-30; see below). The 6 PM feature Reels keep posting daily until the prepared ones run out (they will not be remade), and the Sunday recap continues.
- The job runs at 12:07 and 13:07 UTC; the script posts only when it is 7 AM in Chicago, which
  handles daylight saving time.
- If a day has no folder in `index.json`, the job logs that and does nothing.
- To skip a day, delete its folder before 7 AM. To re-post a day, delete `published/<date>.json`
  and run the workflow with that date.

## Why posts arrive from a launch agent on Alex's Mac

GitHub's cron scheduler fires hours late or not at all on a quiet repository (its first two
scheduled runs were six hours late and it skipped whole days), so the schedule in the workflow is
only a backup. The real trigger is a launchd agent on Alex's Mac, `launchd/com.icubasics.qotd.plist`,
which runs `scripts/kick-post.sh` at 7:05 and 9:05 AM Chicago. The script calls
`gh workflow run "Post Question of the Day" -f dry_run=false`; the workflow posts today's item once
(the marker in `published/` prevents duplicates) and only from 7 AM Chicago onward, so extra kicks
are harmless. launchd runs a missed job at the next wake, but a Mac that is shut down or offline at
both times posts only if GitHub's own schedule happens to fire. Logs: `~/Library/Logs/icubasics-qotd.log`.

Install on a new Mac: `cp launchd/com.icubasics.qotd.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.icubasics.qotd.plist`
(edit the script path in the plist first if the repo lives elsewhere). Test: `launchctl kickstart gui/$(id -u)/com.icubasics.qotd`.


## Explainer shorts (Mon/Wed/Fri, noon Chicago)

The code-drawn explainer shorts from `~/Desktop/Social Media Uploads/<Topic>/` post on all three
accounts. Schedule one with

    node scripts/add-short.mjs "<Topic folder>" <YYYY-MM-DD> [slug]

which copies each brand's `short - <Brand> Basics.mp4` to `shorts/<brand>/<slug>/reel.mp4`, takes
that brand's INSTAGRAM REELS caption from `short - captions and tags.txt`, makes `cover.jpg` from
`short - cover.png`, and adds the date to `shorts/<brand>/schedule.json`. Commit and push. The
workflow posts it with `kind=short` from noon Chicago (markers `published*/<date>-short.json`); a
launch agent kicks it at noon and 2 PM Chicago:

    cp launchd/com.icubasics.short.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.icubasics.short.plist

## Evening feature Reels

A second daily Reel shows one app feature (rhythm drill, case studies, mock exams and so on). The
videos are made in the QuizApp repo (`scripts/social/features.sh <brand>`, then
`scripts/social/push-features.sh <brand> <first date> <days>`) and live in `features/<brand>/<id>/`
with `reel.mp4` and `caption.txt`; `features/<brand>/schedule.json` maps each date to a feature.
The workflow posts them with `kind=feature` from 6 PM Chicago, with markers in
`published*/<date>-feature.json`. A second launch agent kicks it at 6:05 and 8:05 PM Chicago:

    cp launchd/com.icubasics.feature.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.icubasics.feature.plist

## Weekly recap (Sundays)

Since 2026-10-07 the daily two-slide carousel is no longer posted; the morning job posts only the
Question of the Day Reel. On Sundays it also posts a weekly recap carousel from
`posts*/recaps/<date>/` (0-cover.jpg plus the week's seven answer slides, caption.txt, slides.json),
made in the QuizApp repo by `scripts/social/recap.sh <brand> <first Sunday> <last Sunday>`
(push-month.sh runs it for every Sunday in a new run). Its marker is `published*/<date>.json`.

## Afternoon explainer series (since 2026-11-02)

A second explainer series posts from **3 PM Chicago** (kind `afternoon`), from `shorts-pm/<brand>/schedule.json`, alongside the noon series. Schedule with `SLOT=pm node scripts/add-short.mjs "<topic folder>" <date> [slug]`, then commit and push. The Mac kicks it at 3:05 and 5:05 PM Chicago (`launchd/com.icubasics.afternoon.plist`; install it like the other agents).

## YouTube (@TheRNBasics, scheduled from the Mac)

Basics has one YouTube channel, @TheRNBasics, and it always gets the RN version. It releases one
topic per day: the topic's long at 9:00 AM Pacific and its Shorts right after (9:05, 9:10, ...).
Nothing about YouTube runs in GitHub Actions. `scripts/youtube-schedule.mjs` runs on Alex's Mac and
uploads the kits in `~/Desktop/YouTube Uploads - TheRNBasics/<day>/<n> LONG|SHORT - <name>/` (video,
`upload.txt`, and for longs `thumbnail.png` and `captions.srt`) as private videos with the publish time
from `upload.txt`, then sets the long's thumbnail and captions and adds each video to the suggested
playlists that exist. Its record of what is uploaded is `~/basics-growth-work/youtube/uploaded.json`
(never this repository), and it also skips any kit whose title is already on the channel. Credentials
are in the login keychain (`sh scripts/setup-youtube.sh`). Setup and details:
[docs/youtube-setup.md](docs/youtube-setup.md).

    node scripts/youtube-schedule.mjs --dry-run --all       # the plan: PT and UTC times, quota, hand-work
    node scripts/youtube-schedule.mjs --all                 # upload and schedule what is not uploaded yet
    node scripts/youtube-schedule.mjs reschedule-file "<CLAUDE TASK - Reschedule ....md>" --dry-run

The same scheduler also serves Rhea's channel, @Rheafi, with `--channel rheafi` (its own refresh
token `YT_REFRESH_TOKEN_RHEAFI`, kits in `~/Desktop/YouTube Uploads - Rheafi/`, record
`~/basics-growth-work/youtube/uploaded-rheafi.json`, and the Rhea description rules instead of the
three app links). Without `--channel` everything is @TheRNBasics as before.

    sh scripts/setup-youtube.sh --channel rheafi            # one-time sign-in to @Rheafi
    node scripts/youtube-schedule.mjs --channel rheafi --dry-run --all

## TikTok (posting page on the Mac; app in TikTok's sandbox)

TikTok posts go through TikTok's Content Posting API from a local page on Alex's Mac,
`scripts/tiktok-poster.mjs` (http://127.0.0.1:8765/). It lists the shorts in
`~/Desktop/Social Media Uploads/<topic>/short - <Brand> Basics.mp4` with the TikTok caption from
`short - captions and tags.txt`, and posts the one Alex picks with the screen TikTok requires for Direct
Post (creator info, privacy chosen by hand, interaction settings, commercial-content disclosure, the
Music Usage declaration, preview, status). There is no scheduled posting: TikTok requires the user's
consent to each post. The app is unaudited, so posts are "Only me" to a private account until TikTok
approves it. Requirements with sources and Alex's steps: [docs/tiktok-setup.md](docs/tiktok-setup.md);
review texts and the demo-video script: [docs/tiktok-audit.md](docs/tiktok-audit.md).

    sh scripts/setup-tiktok.sh                 # once: sandbox or production key, then sign in (keychain)
    node scripts/tiktok-auth.mjs rn check      # read-only check
    node scripts/tiktok-poster.mjs             # the posting page
    node scripts/tiktok-test.mjs               # offline tests against scripts/tiktok-fake-api.mjs

## Analytics (on the Mac only)

Instagram insights are private and this repository is public, so analytics never run in Actions and
nothing is committed here. `scripts/analytics.mjs` runs nightly on Alex's Mac
(`launchd/com.icubasics.analytics.plist`, 2:05 AM Pacific) with credentials from the login keychain
(`scripts/setup-keychain.sh <account>` or `all` for Instagram, `scripts/setup-youtube.sh` for YouTube). It reads
per-Reel insights for every Instagram account with a keychain token (icu, rn, medic, rhea, winery,
franchifi, gripwheels; the others are skipped with a note) (views, reach, saved, shares, likes, comments,
total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time), follower counts, and
per-video YouTube Analytics (views, estimatedMinutesWatched, averageViewDuration, likes,
subscribersGained), appends them to `~/basics-growth-work/analytics/*.jsonl`, and rebuilds
`~/basics-growth-work/analytics/dashboard.html` (followers over time, top 10 this week, every Reel
and Short with filters by account, topic and slot). Topics and slots come from the markers in
`published*/`, YouTube topics from the scheduler's `uploaded.json`. It refreshes its own keychain
copy of each Instagram token weekly and records the date in `state.json` (`igTokens`), which the
Basics Social Mac app shows.

    node scripts/analytics.mjs                 # fetch and rebuild the dashboard
    node scripts/analytics.mjs dashboard       # rebuild only
    FIXTURES=1 ANALYTICS_DIR=/tmp/a node scripts/analytics.mjs   # made-up data, no network

## Later: Facebook Reels and Threads

Not built. Each would be a step after "Publish today's post" that reads the same marker and
`reel.mp4` URL on GitHub Pages and writes its own marker folder (`published-facebook/`,
`published-threads/`). Facebook Reels use the Pages API
(`/<page-id>/video_reels`, upload phase start → transfer by `file_url` → finish) with a Page token
from the same Meta app; Threads uses `graph.threads.net` (`/<threads-user-id>/threads` with
`media_type=VIDEO` and `video_url`, then `/threads_publish`) with its own Threads token. Analytics
would add one fetch function each to `analytics.mjs` (Page video insights; Threads `/insights` with
views, likes, replies, reposts, quotes, shares) and one more account card on the dashboard.
