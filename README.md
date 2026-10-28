# The Grandma's Time Capsule

A static website with **three independent counters** measuring the time since
**28 October 2026, 05:10:00 AM Bangladesh time** (`2026-10-28T05:10:00+06:00`, which is
`2026-10-27T23:10:00Z`). Below the counters is the complete Bengali memory passage.

No build step, no framework, no external fonts or scripts. Four files run the site:

| File | Role |
|---|---|
| `index.html` | Structure, three counter cards, the Bengali memory section |
| `style.css` | Design (system fonts only), responsive layout, reduced-motion support |
| `script.js` | Number engine, calendar arithmetic, time service, counters, UI |
| `README.md` | This document |

`tests/`, `package.json` and `TEST-REPORT.md` are for development only and are not needed to publish.

## The three counters

| Card | Display | Meaning |
|---|---|---|
| Calendar journey | `YEARS : MONTHS : DAYS` | Calendar time in Bangladesh local time |
| Total days remembered | `TOTAL DAYS : HOURS : MINUTES` | Whole elapsed 24-hour days, then remaining hours and minutes |
| Every second matters | `TOTAL HOURS : MINUTES : SECONDS` | Total elapsed hours (never wraps at 24), then minutes and seconds |

Each counter has its own calculation function, view, scheduler, error state and recovery loop.
They share only the immutable reference and the current-time estimate. None reads another's output.
A calculation or display failure in one shows a message on that card only, and that counter retries
on its own (0.5 s doubling to 30 s) while the others keep running.

### Calendar convention (Counter 1)
A month is complete when the same day-of-month at the same time of day is reached. If the target month is
shorter, the day is clamped to its last day (31 Jan + 1 month = 28/29 Feb). Remaining days are whole
24-hour periods after that anchor. Bangladesh has no daylight saving time, so every day is 24 hours.
This is an ordinary, documented convention; other conventions exist.

## Large numbers
All elapsed-time arithmetic uses `BigInt` in integer milliseconds. Calendar arithmetic uses its own
BigInt Gregorian algorithm rather than `Date`, so it is not limited to the `Date` range (about ±275,000 years).
Numbers are shown in full with thousands separators. Nothing is rounded, abbreviated or replaced by scientific
notation. Very long numbers wrap and stack on the card, and *Inspect exact numbers* shows every digit with a digit count.
The only limit is device memory.

One honest caveat: the *current time itself* comes from the browser and internet sources, which only report real
present-day timestamps. The big-number support is a property of the arithmetic, not a claim that the clock can run
for astronomically long.

## Internet time
The estimate is `anchor UTC + (monotonic now − anchor monotonic)`. Timers only decide *when to redraw*; they never count seconds.

Sources (all HTTPS, queried in parallel, 8 s timeout, one round at a time):

1. **WorldTimeAPI**: `https://worldtimeapi.org/api/timezone/Asia/Dhaka` (`utc_datetime`, cross-checked against `unixtime`)
2. **TimeAPI.io**: `https://timeapi.io/api/Time/current/zone?timeZone=Asia/Dhaka` (`dateTime` is Dhaka local time, read as UTC+06:00)
3. **This site's own host**: the HTTP `Date` header of a `HEAD` request to the page itself (1 s resolution, plus `Age` if present). Only used when the site is served over HTTPS.

**None of these is an official Bangladesh government time service.** I did not find one I could verify, so none is claimed.
To add or change a source, edit `defaultSources()` in `script.js`: give it an `id`, a `label`, a `url`, and a `read(response)` function
returning `{ utcMs, resolutionMs }`. A source must allow cross-origin (CORS) requests from your site.

Rules applied to each round:
- Round-trip time is measured; the server time is assumed to apply at the midpoint; uncertainty is half the round trip plus the source's resolution.
- Malformed, wrong-zone, internally inconsistent or implausible (earlier than 21 Sep 2026) answers are discarded.
- Sources must agree within their combined uncertainty plus 1 s. An outlier is rejected. If every answer disagrees, none is trusted.
- A correction larger than about 2 s that comes from a single source is held until a second consistent answer confirms it.
- Healthy re-check every ~5 minutes; failures back off 5 s → 5 min (capped); no overlapping requests.

Status shown on the page: **Synced** (checked within 10 min), **Estimating** (older check or unresolved clock jump, uncertainty grows),
**Checking / Offline using device clock (not verified)** (no successful check yet).

## Recovery behaviour
- Refresh, closing, restarting: the reference lives in the code, so every load recalculates from it. Nothing is stored; there is no storage to fail.
- Network loss: the last good anchor plus the monotonic clock keeps counting; status becomes *Estimating* and uncertainty grows.
- Sleep or suspension where the monotonic clock pauses but the wall clock moves on: detected on resume (and by a 5 s watchdog), compensated, then re-verified online.
- Device clock changed: ignored in favour of the monotonic clock, then re-verified.
- Back-forward cache, tab return, `online` event: recalculate and re-sync immediately.
- Before 05:10:00 on 28 Oct 2026: cards show *Waiting for the first moment*; negative durations are never shown.

## Publish on GitHub Pages
1. Create a repository (for example `grandma-time-capsule`).
2. Upload `index.html`, `style.css`, `script.js` and `README.md` to the repository root.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`, **Save**.
4. After a minute the site is live at `https://<username>.github.io/<repository>/`. Use that HTTPS address so the host-header source works.

## Run the tests
Requires Node 20+. `npm install` then `npm test`. See `TEST-REPORT.md` for what is and is not covered.

## Known limitations
- A web page cannot run while the browser or phone is suspended or closed. Correctness comes from recomputing from timestamps on return, not from continuous execution.
- Accuracy is limited by network delay, source accuracy and browser timers: typically well under a second when *Synced*, worse when *Estimating*. It is not atomic-clock accuracy.
- Third-party time services can change, rate-limit or disappear. The site keeps working from the remaining sources, then from its last anchor.
- `Asia/Dhaka` is treated as a fixed UTC+06:00 for calendar arithmetic. If Bangladesh reintroduces daylight saving, `REFERENCE.offsetMinutes` handling in `script.js` must be revisited.
- Fonts are system fonts. Bengali shaping depends on the device having a Bengali-capable font (virtually all current Android, iOS, Windows and macOS devices do).
- The counters do not slew; a legitimate time correction may move a displayed value by a fraction of a second, including backward.
