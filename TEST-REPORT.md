# Testing and verification report

Run: `node --test tests/core.test.js tests/dom.test.js` on Node 22.22.2.
Result: **49 tests, 49 passed, 0 failed** (about 6.8 s). Raw output: `tests/last-run.tap`.

## What was actually run

**Reference (A1–A4)**: exact timestamp and UTC equivalent against `Date.parse`; frozen constant; Dhaka wall clock at the reference instant via `Intl`; waiting state before the reference, never negative.

**Numbers (B1–B5)**: 0, 1, 59/60 s, 999/1000 ms, hour/day boundaries, 10^9 to 10^18, values beyond `Number.MAX_SAFE_INTEGER`, a 3001-digit elapsed value checked against an independent schoolbook decimal division written in the test, digit preservation after formatting, and a speed check on 5000-digit values.

**Calendar (C1–C7, G1–G3)**: day-number round trip against `Date` over ±300,000 days; leap years (1900, 2000, 2024, 2100, 2400); anniversaries of the real reference; 31 Jan and 29 Feb clamping; month, year and century boundaries; **1,500 random start/end pairs and 400 random reference-based elapsed values compared with an independent `Date`-based oracle**; year 10^30 (beyond `Date`'s range); no reset at midnight, month-end, year-end or leap day.

**Independent counters (D)**: for each of the three counters in turn, a forced calculation failure leaves the other two updating and error-free, and the failed one recovers to the *current* value rather than zero; forced display failure; repeated failure keeps one timer per counter with a 30 s cap; failure of the shared clock degrades locally.

**Synchronisation (E1–E15)** on simulated clocks and a fake network: valid sources (device clock 5 min wrong is corrected); latency midpoint and uncertainty; malformed, wrong-zone and inconsistent responses; sources that disagree; a single outlier; hanging requests with timeout and no overlapping rounds; a 3-hour and a 3-day outage and reconnection; 24 simulated hours of total failure (bounded retries, bounded log, no timer pile-up); a large single-source correction held until confirmed; device clock moved backward; device sleep with the monotonic clock paused (offline and online); implausible timestamps; the reference untouched by any of it.

**Page-level in jsdom (DOM1–DOM6)**: real `index.html` + `script.js`: live values match the engine; fault injected into one counter in the real page is isolated and self-heals; offline start is labelled as unverified; a 3000-digit value reaches the DOM digit-for-digit and the inspector shows it; one `h1`, counters precede memory, one polite live region.

**Memory passage (H1–H4)**: title, exactly ten paragraphs, the opening words of each, the key facts (4 h 4 min 4 s, about 21 GB, about 5.1 GB, YouTube, handbag, closing line), only Bengali characters inside the passage, `lang="bn"`, no scripts or counter hooks inside the section, no external hosts, exactly three counter cards.

## Not tested (do not assume these pass)

- **Real network.** The sandbox could not reach the time services. Their JSON field names come from published documentation and examples, and the parsers are tested against that shape, but **a live round trip to WorldTimeAPI, TimeAPI.io and the GitHub Pages `Date` header has not been performed**, and CORS has not been confirmed. If a source fails in production the site falls back to the others and then to its last anchor, and says so; check *Recent technical notes* at the bottom of the page after deploying.
- **Real browsers and devices.** No headless browser was available, so layout was not rendered: narrow-screen fit, absence of horizontal overflow, Bengali glyph shaping, font fallback, colour contrast, reduced-motion behaviour and performance on a budget Android phone are **designed for but unverified**. Open the deployed page on a phone and a desktop and check.
- **Real suspension, bfcache and storage.** Sleep, tab freezing and back-forward restoration were simulated through clock behaviour, not on hardware. The site does not use browser storage.
- **Byte-for-byte fidelity of the Bengali passage** against your original. The upload was not on disk, so the passage was checked structurally and by key phrases as above. Please read it once against your source.
- Screen-reader behaviour (only the markup was checked).
