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
