'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TC = require('../script.js');
const H = require('./helpers.js');

const REF = TC.REFERENCE.utcMs;
const SEC = 1000n, MIN = 60000n, HR = 3600000n, DAY = 86400000n;
const OFF = 6n * HR;

/* ---------- independent oracles (do not reuse the code under test) ---------- */

// Schoolbook decimal division of a digit string by a small integer.
function divmodStr(numStr, divisor) {
  let rem = 0, out = '';
  for (const ch of numStr) {
    const cur = rem * 10 + (ch.charCodeAt(0) - 48);
    out += Math.floor(cur / divisor);
    rem = cur % divisor;
  }
  return { q: out.replace(/^0+(?=\d)/, ''), r: rem };
}

function addMonthsNaive(S, k) {
  const y = S.getUTCFullYear() + Math.floor((S.getUTCMonth() + k) / 12);
  const m = (S.getUTCMonth() + k) % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(S.getUTCDate(), dim), S.getUTCHours(), S.getUTCMinutes(), S.getUTCSeconds(), S.getUTCMilliseconds());
}
function naiveDiff(s, e) {
  const S = new Date(s);
  let months = 0;
  while (addMonthsNaive(S, months + 1) <= e) months++;
  const anchor = addMonthsNaive(S, months);
  return [Math.floor(months / 12), months % 12, Math.floor((e - anchor) / 864e5)];
}
function diffAsNumbers(s, e) {
  const r = TC.calendarDiff(BigInt(s), BigInt(e));
  return [Number(r.years), Number(r.months), Number(r.days)];
}
function lcg(seed) { let x = seed; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; }

/* ======================= A. starting timestamp ======================= */
test('A1 reference is exactly 28 Oct 2026 05:10:00 +06:00 = 2026-10-27T23:10:00Z', () => {
  assert.equal(TC.REFERENCE.iso, '2026-10-28T05:10:00+06:00');
  assert.equal(TC.REFERENCE.utcIso, '2026-10-27T23:10:00Z');
  assert.equal(Date.parse('2026-10-28T05:10:00+06:00'), Number(REF));
  assert.equal(Date.parse('2026-10-27T23:10:00Z'), Number(REF));
  assert.equal(TC.referenceIsConsistent(), true);
  assert.equal(TC.REFERENCE.zone, 'Asia/Dhaka');
  assert.equal(TC.REFERENCE.offsetMinutes, 360);
});
test('A2 reference is frozen and cannot be changed', () => {
  assert.equal(Object.isFrozen(TC.REFERENCE), true);
  assert.throws(() => { 'use strict'; TC.REFERENCE.utcMs = 0n; }, TypeError);
  assert.equal(TC.REFERENCE.utcMs, REF);
});
test('A3 Asia/Dhaka wall clock at the reference instant is 05:10 (Intl cross-check)', () => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(Number(REF)));
  const get = (t) => parts.find((p) => p.type === t).value;
  assert.deepEqual([get('year'), get('month'), get('day'), get('hour'), get('minute')], ['2026', '10', '28', '05', '10']);
});
test('A4 before the reference: waiting state, never negative', () => {
  for (const f of [TC.computeCalendar, TC.computeTotalDays, TC.computeTotalHours]) {
    assert.equal(f(REF - 1n).state, 'waiting');
    assert.equal(f(REF - 10n ** 12n).state, 'waiting');
    assert.equal(f(REF).state, 'running');
  }
  assert.deepEqual(TC.computeTotalHours(REF).values, [0n, 0n, 0n]);
});

/* ======================= B. numerical ======================= */
test('B1 boundary values for all three fixed-duration conversions', () => {
  const cases = [0n, 1n, 999n, 1000n, 59n * SEC, 60n * SEC, 3599999n, 3600000n, 86399999n, 86400000n, 10n ** 9n, 10n ** 12n, 10n ** 15n, 10n ** 18n];
  for (const e of cases) {
    const d = TC.computeTotalDays(REF + e).values;
    assert.equal(d[0] * DAY + d[1] * HR + d[2] * MIN + (e % MIN), e);
    assert.ok(d[1] < 24n && d[2] < 60n);
    const h = TC.computeTotalHours(REF + e).values;
    assert.equal(h[0] * HR + h[1] * MIN + h[2] * SEC + (e % SEC), e);
    assert.ok(h[1] < 60n && h[2] < 60n);
  }
  assert.deepEqual(TC.computeTotalHours(REF + 59n * SEC).values, [0n, 0n, 59n]);
  assert.deepEqual(TC.computeTotalHours(REF + 60n * SEC).values, [0n, 1n, 0n]);
  assert.deepEqual(TC.computeTotalHours(REF + 250n * HR + 18n * MIN + 36n * SEC).values, [250n, 18n, 36n]);
  assert.deepEqual(TC.computeTotalDays(REF + 10n * DAY + 7n * HR + 42n * MIN).values, [10n, 7n, 42n]);
});
test('B2 beyond Number.MAX_SAFE_INTEGER: exact, no float conversion', () => {
  const big = BigInt(Number.MAX_SAFE_INTEGER) * 1000n + 123456789n; // not representable as a Number
  const e = big * HR + 17n * MIN + 5n * SEC;
  const h = TC.computeTotalHours(REF + e).values;
  assert.deepEqual(h, [big, 17n, 5n]);
  assert.equal(h[0].toString(), big.toString());
  const d = TC.computeTotalDays(REF + big * DAY + 3n * HR + 4n * MIN).values;
  assert.deepEqual(d, [big, 3n, 4n]);
});
test('B3 thousands of digits: every digit present, verified with independent decimal division', () => {
  const e = 10n ** 3000n + 987654321987654321n;
  const eStr = e.toString();
  assert.equal(eStr.length, 3001);
  const h = TC.computeTotalHours(REF + e).values;
  const d = TC.computeTotalDays(REF + e).values;
  // oracle: e / 3_600_000 and e / 86_400_000 by schoolbook long division on the digit string
  let q = divmodStr(eStr, 3600000 % 10 === 0 ? 3600000 : 3600000);
  assert.equal(h[0].toString(), q.q);
  q = divmodStr(eStr, 86400000);
  assert.equal(d[0].toString(), q.q);
  assert.ok(h[0].toString().length > 2990);
  // exact display text keeps all digits (grouping only inserts commas)
  const shown = TC.formatSegment(h[0], false);
  assert.equal(shown.replace(/,/g, ''), h[0].toString());
  assert.ok(!/e\+|\.\.\.|…|[KMBTQ]$/.test(shown));
});
test('B4 grouping never changes digits and handles edge lengths', () => {
  for (const s of ['0', '7', '59', '999', '1000', '1234567', '1000000000000000000']) {
    assert.equal(TC.groupDigits(s).replace(/,/g, ''), s);
  }
  assert.equal(TC.groupDigits('1000'), '1,000');
  assert.equal(TC.groupDigits('1234567'), '1,234,567');
  assert.equal(TC.pad2(5n), '05');
  assert.equal(TC.pad2(42n), '42');
});
test('B5 huge value is cheap: 5000-digit conversion finishes quickly and does not allocate unboundedly', () => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) TC.computeTotalHours(REF + 10n ** 5000n + BigInt(i));
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 3000, 'took ' + ms + ' ms');
});

/* ======================= C. calendar ======================= */
const local = (y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) => Date.UTC(y, m - 1, d, hh, mm, ss, ms);

test('C1 day number round-trip matches Date over ±300 000 days', () => {
  for (let z = -300000; z <= 300000; z += 37) {
    const dt = new Date(z * 86400000);
    const c = TC.civilFromDays(BigInt(z));
    assert.deepEqual([Number(c.y), Number(c.m), Number(c.d)], [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()]);
    assert.equal(TC.daysFromCivil(c.y, c.m, c.d), BigInt(z));
  }
});
test('C2 leap years and month lengths', () => {
  for (const [y, leap] of [[1900, false], [2000, true], [2024, true], [2026, false], [2028, true], [2100, false], [2400, true]]) {
    assert.equal(TC.isLeap(BigInt(y)), leap, 'year ' + y);
    assert.equal(TC.daysInMonth(BigInt(y), 2n), leap ? 29n : 28n);
  }
  assert.equal(TC.daysInMonth(2026n, 4n), 30n);
  assert.equal(TC.daysInMonth(2026n, 12n), 31n);
});
test('C3 the real reference: anniversaries and boundaries', () => {
  const start = REF + OFF;
  const at = (iso) => BigInt(Date.parse(iso)) + OFF; // iso given as UTC for readability
  const r = (end) => TC.calendarDiff(start, end);
  assert.deepEqual(Object.values(r(start)).map(Number), [0, 0, 0]);
  assert.deepEqual(Object.values(r(start + DAY - 1n)).map(Number), [0, 0, 0]);
  assert.deepEqual(Object.values(r(start + DAY)).map(Number), [0, 0, 1]);
  assert.deepEqual(Object.values(r(BigInt(local(2026, 11, 28, 5, 10)))).map(Number), [0, 1, 0]);
  assert.deepEqual(Object.values(r(BigInt(local(2026, 11, 28, 5, 9, 59, 999)))).map(Number), [0, 0, 30]);
  assert.deepEqual(Object.values(r(BigInt(local(2027, 10, 28, 5, 10)))).map(Number), [1, 0, 0]);
  assert.deepEqual(Object.values(r(BigInt(local(2027, 10, 28, 5, 9, 59, 999)))).map(Number), [0, 11, 29]);
  assert.deepEqual(Object.values(r(BigInt(local(2028, 2, 29, 5, 10)))).map(Number), [1, 4, 1]);
  assert.ok(at);
});
test('C4 dates that do not exist in the target month are clamped (documented convention)', () => {
  const s = BigInt(local(2028, 1, 31, 9, 0));
  const r = (e) => Object.values(TC.calendarDiff(s, BigInt(e))).map(Number);
  assert.deepEqual(r(local(2028, 2, 28, 9, 0)), [0, 0, 28]); // Feb 29 anchor not reached yet
  assert.deepEqual(r(local(2028, 2, 29, 9, 0)), [0, 1, 0]); // clamped to Feb 29 (leap)
  assert.deepEqual(r(local(2028, 3, 31, 9, 0)), [0, 2, 0]);
  const s2 = BigInt(local(2027, 1, 31, 9, 0));
  assert.deepEqual(Object.values(TC.calendarDiff(s2, BigInt(local(2027, 2, 28, 9, 0)))).map(Number), [0, 1, 0]);
  assert.deepEqual(Object.values(TC.calendarDiff(s2, BigInt(local(2027, 3, 1, 9, 0)))).map(Number), [0, 1, 1]);
  const leapDay = BigInt(local(2028, 2, 29, 0, 0));
  assert.deepEqual(Object.values(TC.calendarDiff(leapDay, BigInt(local(2029, 2, 28, 0, 0)))).map(Number), [1, 0, 0]);
  assert.deepEqual(Object.values(TC.calendarDiff(leapDay, BigInt(local(2029, 3, 1, 0, 0)))).map(Number), [1, 0, 1]);
  assert.deepEqual(Object.values(TC.calendarDiff(leapDay, BigInt(local(2032, 2, 29, 0, 0)))).map(Number), [4, 0, 0]);
});
test('C5 month-end, year-end and century boundaries', () => {
  const s = BigInt(local(1999, 12, 31, 23, 59, 59));
  assert.deepEqual(Object.values(TC.calendarDiff(s, BigInt(local(2000, 1, 1, 0, 0, 0)))).map(Number), [0, 0, 0]);
  assert.deepEqual(Object.values(TC.calendarDiff(s, BigInt(local(2000, 2, 29, 23, 59, 59)))).map(Number), [0, 2, 0]);
  const s2 = BigInt(local(2096, 2, 29, 0, 0));
  assert.deepEqual(Object.values(TC.calendarDiff(s2, BigInt(local(2100, 2, 28, 0, 0)))).map(Number), [4, 0, 0]); // 2100 is not leap
  assert.throws(() => TC.calendarDiff(10n, 9n), RangeError);
});
test('C6 property test: 1500 random start/end pairs agree with an independent Date-based oracle', () => {
  const rnd = lcg(20261028);
  for (let i = 0; i < 1500; i++) {
    const s = local(2000 + Math.floor(rnd() * 200), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 31), Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 60), Math.floor(rnd() * 1000));
    if (!Number.isFinite(s)) continue;
    const sd = new Date(s);
    // skip impossible calendar days Date silently rolled over (e.g. Feb 31 -> Mar 3)
    const e = s + Math.floor(rnd() * 150 * 365 * 864e5);
    assert.deepEqual(diffAsNumbers(s, e), naiveDiff(s, e), 'start ' + sd.toISOString() + ' end ' + new Date(e).toISOString());
  }
});
test('C7 calendar arithmetic is not limited by Date: year 10^30', () => {
  const start = TC.REFERENCE.utcMs + OFF;
  const farDays = TC.daysFromCivil(10n ** 30n + 2026n, 10n, 28n);
  const end = farDays * DAY + 5n * HR + 10n * MIN;
  const r = TC.calendarDiff(start, end);
  assert.equal(r.years, 10n ** 30n);
  assert.equal(r.months, 0n);
  assert.equal(r.days, 0n);
  const c = TC.civilFromDays(farDays);
  assert.deepEqual([c.y, c.m, c.d], [10n ** 30n + 2026n, 10n, 28n]);
  // Gregorian cycle is exactly 146097 days per 400 years
  assert.equal(TC.daysFromCivil(2426n, 10n, 28n) - TC.daysFromCivil(2026n, 10n, 28n), 146097n);
});

/* ======================= G. long duration, simulated ======================= */
test('G1 counters recalculate from timestamps across years and leap days (no timer counting)', () => {
  const rnd = lcg(7);
  for (let i = 0; i < 400; i++) {
    const e = BigInt(Math.floor(rnd() * 80 * 365.2425 * 864e5));
    const now = REF + e;
    const cal = TC.computeCalendar(now).values;
    const nv = naiveDiff(Number(REF + OFF), Number(now + OFF));
    assert.deepEqual(cal.map(Number), nv);
    const d = TC.computeTotalDays(now).values;
    assert.equal(Number(d[0]), Math.floor(Number(e) / 864e5));
    const h = TC.computeTotalHours(now).values;
    assert.equal(Number(h[0]), Math.floor(Number(e) / 36e5));
  }
});
test('G2 result depends only on (now, reference): identical after any number of simulated interruptions', () => {
  const now = REF + 123456789012n;
  const first = TC.computeTotalHours(now);
  for (let i = 0; i < 1000; i++) TC.computeTotalHours(now + BigInt(i)); // "interruptions"
  assert.deepEqual(TC.computeTotalHours(now).values, first.values);
});
test('G3 no reset at midnight, month-end, year-end or leap day', () => {
  const bdMidnight = (y, m, d) => BigInt(local(y, m, d, 0, 0)) - OFF;
  for (const [y, m, d] of [[2026, 10, 31], [2026, 12, 31], [2027, 12, 31], [2028, 2, 29], [2029, 2, 28]]) {
    const before = TC.computeTotalHours(bdMidnight(y, m, d) - 1000n).values[0];
    const after = TC.computeTotalHours(bdMidnight(y, m, d) + 1000n).values[0];
    assert.ok(after >= before);
    const d1 = TC.computeTotalDays(bdMidnight(y, m, d) - 1000n).values[0];
    const d2 = TC.computeTotalDays(bdMidnight(y, m, d) + 1000n).values[0];
    assert.ok(d2 >= d1 && d2 - d1 <= 1n);
  }
});

/* ======================= D. independent counters ======================= */
function makeView(log) {
  return {
    renders: [],
    status: null,
    error: null,
    render(r) { if (this.failRender) throw new Error('render boom'); this.renders.push(r); },
    setStatus(s) { this.status = s; },
    setError(m) { this.error = m; }
  };
}
function buildCounters(env, nowFn, faults) {
  const timers = { set: env.setTimeout, clear: env.clearTimeout };
  const out = {};
  for (const spec of TC.COUNTER_SPECS) {
    const view = makeView();
    out[spec.id] = {
      view,
      c: TC.createCounter({
        id: spec.id,
        timers,
        capMs: spec.capMs,
        view,
        getNow: nowFn,
        compute: (now) => {
          if (faults[spec.id]) throw new Error('forced ' + spec.id + ' failure');
          return spec.compute(now);
        }
      })
    };
  }
  return out;
}
for (const victim of ['calendar', 'days', 'hours']) {
  test('D forced failure of "' + victim + '": the other two keep updating; recovery does not reset', async () => {
    const env = H.makeEnv(H.T0 + 100 * 864e5);
    const faults = {};
    const ctr = buildCounters(env, () => BigInt(env.wall), faults);
    Object.values(ctr).forEach((x) => x.c.start());
    await env.advance(35000);
    const rendersBefore = Object.fromEntries(Object.entries(ctr).map(([k, v]) => [k, v.view.renders.length]));
    faults[victim] = true;
    ctr[victim].c.refresh();
    assert.equal(ctr[victim].view.status, 'recovering');
    assert.ok(ctr[victim].view.error);
    await env.advance(35000);
    for (const [k, v] of Object.entries(ctr)) {
      if (k === victim) continue;
      assert.equal(v.view.error, null, k + ' must be unaffected');
      assert.ok(v.view.renders.length > rendersBefore[k], k + ' must keep updating');
      assert.equal(v.view.status, 'running');
    }
    // heal: value must be recalculated from the reference, not restarted at zero
    faults[victim] = false;
    await env.advance(40000);
    const last = ctr[victim].view.renders.at(-1);
    assert.equal(ctr[victim].view.error, null);
    assert.equal(ctr[victim].view.status, 'running');
    const expected = TC.COUNTER_SPECS.find((s) => s.id === victim).compute(BigInt(env.wall)).values;
    assert.ok(last.values[0] >= expected[0] - 1n && last.values[0] <= expected[0], 'recovered value is current, not reset');
    assert.ok(last.values[0] > 0n || victim === 'calendar');
    ctr[victim].c.destroy();
  });
}
test('D4 render failure in one counter is isolated and retried with bounded backoff', async () => {
  const env = H.makeEnv(H.T0 + 5 * 864e5);
  const ctr = buildCounters(env, () => BigInt(env.wall), {});
  ctr.days.view.failRender = true;
  Object.values(ctr).forEach((x) => x.c.start());
  await env.advance(1500);
  assert.ok(ctr.days.view.error);
  assert.equal(ctr.calendar.view.error, null);
  assert.equal(ctr.hours.view.error, null);
  assert.ok(ctr.hours.view.renders.length >= 2);
  // repeated failures never schedule more than one pending timer per counter, delay capped at 30 s
  await env.advance(10 * 60 * 1000);
  assert.ok(env.timers.length <= 3, 'timers: ' + env.timers.length);
  assert.ok(env.timers.every((t) => t.at - env.mono <= 30000 + 1));
  ctr.days.view.failRender = false;
  await env.advance(40000);
  assert.equal(ctr.days.view.error, null);
});
test('D5 a failure of the shared clock degrades every counter locally, none crashes the page', async () => {
  const env = H.makeEnv();
  let broken = false;
  const ctr = buildCounters(env, () => { if (broken) throw new Error('clock gone'); return BigInt(env.wall); }, {});
  Object.values(ctr).forEach((x) => x.c.start());
  broken = true;
  Object.values(ctr).forEach((x) => x.c.refresh());
  assert.ok(Object.values(ctr).every((x) => x.view.status === 'recovering'));
  broken = false;
  await env.advance(1500);
  assert.ok(Object.values(ctr).every((x) => x.view.status === 'running' || x.view.status === 'waiting'));
});

/* ======================= E. synchronisation ======================= */
function svc(env, routes, extra) {
  const fetchFn = H.makeFetch(env, routes, extra && extra.fetchOpts);
  const s = TC.TimeService(Object.assign({
    sources: TC.defaultSources('https://example.github.io/capsule/'),
    mono: () => env.mono,
    wall: () => env.wall,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    fetchFn,
    isOnline: () => true
  }, (extra && extra.opts) || {}));
  s._fetch = fetchFn;
  return s;
}
const okRoutes = (env, skew) => ({
  'worldtimeapi.org': () => H.worldTime(env.wall + (skew || 0)),
  'timeapi.io': () => H.timeApiIo(env.wall + (skew || 0)),
  'example.github.io': () => H.dateHeaderResponse(env.wall + (skew || 0))
});

test('E1 valid sources: synced, multi-source, device clock 5 minutes wrong is corrected', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const truth = env.wall;
  const routes = {
    'worldtimeapi.org': () => H.worldTime(truth + (env.mono - 5000)),
    'timeapi.io': () => H.timeApiIo(truth + (env.mono - 5000)),
    'example.github.io': () => H.dateHeaderResponse(truth + (env.mono - 5000))
  };
  env.wall += 5 * 60 * 1000; // device clock is wrong
  const s = svc(env, routes);
  assert.equal(s.getStatus().level, 'unverified');
  await s.start();
  const st = s.getStatus();
  assert.equal(st.level, 'synced');
  assert.equal(st.multiSource, true);
  assert.ok(Math.abs(Number(s.nowUtcMs()) - (truth + (env.mono - 5000))) < 5, 'estimate follows internet time, not device clock');
  s.stop();
});
test('E2 latency: midpoint estimate is accurate under symmetric 400 ms round-trip; uncertainty covers half of it', async () => {
  const env = H.makeEnv(H.T0 + 5e8);
  const s = svc(env, { 'worldtimeapi.org': (e) => H.worldTime(e.wall + 200) }, { fetchOpts: { latency: 400 } });
  await s.start();
  const st = s.getStatus();
  assert.ok(st.uncertaintyMs >= 200 && st.uncertaintyMs < 400, 'uncertainty ' + st.uncertaintyMs);
  s.stop();
});
test('E3 malformed responses are rejected; remaining valid source is used and flagged single-source', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, {
    'worldtimeapi.org': () => H.jsonResponse({ utc_datetime: 'garbage', unixtime: 'x' }),
    'timeapi.io': () => H.timeApiIo(env.wall),
    'example.github.io': () => new Error('network down')
  });
  await s.start();
  const st = s.getStatus();
  assert.equal(st.level, 'synced');
  assert.equal(st.multiSource, false);
  assert.match(st.source, /TimeAPI\.io/);
  assert.ok(s.getLog().some((l) => /worldtimeapi failed/.test(l.msg)));
  s.stop();
});
test('E4 inconsistent fields inside one response are rejected (unixtime vs utc_datetime)', () => {
  assert.throws(() => TC.parseWorldTimeApi({ timezone: 'Asia/Dhaka', unixtime: 1793142600, utc_datetime: '2027-01-01T00:00:00.000+00:00' }));
  assert.throws(() => TC.parseWorldTimeApi({ timezone: 'Europe/Paris', unixtime: 1793142600, utc_datetime: '2026-10-27T23:10:00.000+00:00' }));
  assert.throws(() => TC.parseTimeApiIo({ timeZone: 'UTC', dateTime: '2026-10-28T05:10:00.0000000' }));
  assert.throws(() => TC.parseTimeApiIo(null));
  assert.throws(() => TC.parseDateHeader(undefined));
  assert.equal(TC.parseTimeApiIo({ timeZone: 'Asia/Dhaka', dateTime: '2026-10-28T05:10:00.1234567' }).utcMs, Number(REF) + 123);
  assert.equal(TC.parseWorldTimeApi({ timezone: 'Asia/Dhaka', unixtime: 1793142600, utc_datetime: '2026-10-27T23:10:00.250123+00:00' }).utcMs, Number(REF) + 250);
});
test('E5 sources that disagree wildly: none is trusted, estimate unchanged, status honest', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, {
    'worldtimeapi.org': () => H.worldTime(env.wall + 3600000),
    'timeapi.io': () => H.timeApiIo(env.wall - 7200000),
    'example.github.io': () => new Error('x')
  });
  await s.start();
  const st = s.getStatus();
  assert.equal(st.level, 'unverified');
  assert.match(st.lastRound.detail, /disagree/);
  assert.equal(Number(s.nowUtcMs()), Math.floor(env.wall)); // device clock, labelled unverified
  s.stop();
});
test('E6 one outlier among three is rejected, the agreeing pair is used', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, {
    'worldtimeapi.org': () => H.worldTime(env.wall),
    'timeapi.io': () => H.timeApiIo(env.wall + 1),
    'example.github.io': () => H.dateHeaderResponse(env.wall + 9 * 3600000)
  });
  await s.start();
  assert.equal(s.getStatus().multiSource, true);
  assert.ok(s.getLog().some((l) => /rejected outlier host-date-header/.test(l.msg)));
  assert.ok(Math.abs(Number(s.nowUtcMs()) - env.wall) < 50);
  s.stop();
});
test('E7 hanging request times out; requests never overlap; later round recovers', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  let hang = true;
  const s = svc(env, {
    'worldtimeapi.org': () => (hang ? 'hang' : H.worldTime(env.wall)),
    'timeapi.io': () => (hang ? 'hang' : H.timeApiIo(env.wall)),
    'example.github.io': () => (hang ? 'hang' : H.dateHeaderResponse(env.wall))
  });
  const p1 = s.syncOnce('a');
  const p2 = s.syncOnce('b');
  assert.strictEqual(p1, p2, 'overlapping sync reuses the in-flight round');
  await env.advance(8100);
  assert.equal(s.getStatus().level, 'unverified');
  assert.equal(s._fetch.calls.length, 3, 'exactly one request per source');
  hang = false;
  await env.advance(8000); // backoff retry
  assert.equal(s.getStatus().level, 'synced');
  s.stop();
});
test('E8 network outage after a good sync: counters keep advancing from the monotonic clock, status becomes stale, nothing resets', async () => {
  const env = H.makeEnv(H.T0 + 2e9);
  let up = true;
  const routes = {
    'worldtimeapi.org': () => (up ? H.worldTime(env.wall) : new Error('offline')),
    'timeapi.io': () => (up ? H.timeApiIo(env.wall) : new Error('offline')),
    'example.github.io': () => (up ? H.dateHeaderResponse(env.wall) : new Error('offline'))
  };
  const s = svc(env, routes);
  await s.start();
  const before = TC.computeTotalHours(s.nowUtcMs()).values[0];
  up = false;
  await env.advance(3 * 3600 * 1000); // 3 simulated hours offline
  const st = s.getStatus();
  assert.equal(st.level, 'stale');
  assert.ok(st.uncertaintyMs > 100 && st.uncertaintyMs < 5000);
  const after = TC.computeTotalHours(s.nowUtcMs()).values[0];
  assert.equal(after - before, 3n);
  assert.ok(s.getLog().length <= 40, 'diagnostic log is bounded');
  assert.ok(env.timers.length <= 2, 'no timer pile-up');
  up = true;
  await env.advance(6 * 60 * 1000);
  assert.equal(s.getStatus().level, 'synced');
  s.stop();
});
test('E9 backoff grows and is capped; retries remain bounded over a day of failures', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, { 'worldtimeapi.org': () => new Error('x'), 'timeapi.io': () => new Error('x'), 'example.github.io': () => new Error('x') });
  s.start();
  await env.advance(24 * 3600 * 1000);
  const rounds = s._fetch.calls.length / 3;
  assert.ok(rounds < 400, 'rounds in a day: ' + rounds);
  assert.ok(rounds > 250, 'still retrying: ' + rounds);
  assert.ok(s.getLog().length <= 40);
  s.stop();
});
test('E10 a large single-source correction is held until confirmed by a second consistent answer', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  let skew = 0;
  let single = false;
  const s = svc(env, {
    'worldtimeapi.org': () => H.worldTime(env.wall + skew),
    'timeapi.io': () => (single ? new Error('x') : H.timeApiIo(env.wall + skew)),
    'example.github.io': () => (single ? new Error('x') : H.dateHeaderResponse(env.wall + skew))
  });
  await s.start();
  const base = Number(s.nowUtcMs());
  single = true;
  skew = 60000; // one source suddenly claims +60 s
  await s.syncOnce('t');
  assert.ok(Math.abs(Number(s.nowUtcMs()) - base) < 50, 'not applied yet');
  assert.match(s.getStatus().note, /verifying/);
  await env.advance(4000); // quick retry
  assert.ok(Math.abs(Number(s.nowUtcMs()) - (base + 60000 + 4000)) < 100, 'applied after confirmation');
  s.stop();
});
test('E11 device clock moved backward or forward while the page is running: estimate follows the monotonic clock', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, okRoutes(env));
  await s.start();
  const t0 = Number(s.nowUtcMs());
  env.jumpWall(-3600000); // user sets clock back one hour
  s.checkpoint('test');
  assert.ok(Math.abs(Number(s.nowUtcMs()) - t0) < 20);
  assert.match(s.getStatus().note, /Device clock changed/);
  s.stop();
});
test('E12 browser suspension / device sleep: monotonic clock paused, wall clock moved on -> compensated and re-verified', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  let up = true;
  const s = svc(env, {
    'worldtimeapi.org': () => (up ? H.worldTime(env.wall) : new Error('offline')),
    'timeapi.io': () => (up ? H.timeApiIo(env.wall) : new Error('offline')),
    'example.github.io': () => (up ? H.dateHeaderResponse(env.wall) : new Error('offline'))
  });
  await s.start();
  up = false;
  env.sleep(8 * 3600 * 1000); // phone asleep for 8 hours, monotonic did not advance
  s.checkpoint('resume');
  assert.ok(Math.abs(Number(s.nowUtcMs()) - env.wall) < 20, 'offline resume still lands on the right time');
  assert.equal(s.getStatus().level, 'stale');
  up = true;
  await env.advance(10000);
  assert.equal(s.getStatus().level, 'synced');
  assert.ok(Math.abs(Number(s.nowUtcMs()) - env.wall) < 100);
  s.stop();
});
test('E13 long outage then reconnection (3 days): recalculated from reference, correct, and honest', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  let up = true;
  const s = svc(env, {
    'worldtimeapi.org': () => (up ? H.worldTime(env.wall) : new Error('offline')),
    'timeapi.io': () => (up ? H.timeApiIo(env.wall) : new Error('offline')),
    'example.github.io': () => (up ? H.dateHeaderResponse(env.wall) : new Error('offline'))
  });
  await s.start();
  up = false;
  await env.advance(3 * 864e5);
  assert.equal(s.getStatus().level, 'stale');
  up = true;
  await env.advance(6 * 60 * 1000);
  assert.equal(s.getStatus().level, 'synced');
  assert.equal(TC.computeTotalDays(s.nowUtcMs()).values[0], BigInt(Math.floor((env.wall - H.T0) / 864e5)));
  s.stop();
});
test('E14 implausible timestamps (before the sanity floor) are rejected', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, { 'worldtimeapi.org': () => H.worldTime(1000000000000), 'timeapi.io': () => new Error('x'), 'example.github.io': () => new Error('x') });
  await s.start();
  assert.equal(s.getStatus().level, 'unverified');
  s.stop();
});
test('E15 the time service never touches the reference', async () => {
  const env = H.makeEnv(H.T0 + 1e9);
  const s = svc(env, okRoutes(env, 777777));
  await s.start();
  env.jumpWall(-1e9);
  s.checkpoint('x');
  assert.equal(TC.REFERENCE.utcMs, 1793142600000n);
  assert.equal(TC.referenceIsConsistent(), true);
  s.stop();
});

/* ======================= H. Bengali passage ======================= */
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function memoryParagraphs() {
  const sec = html.match(/<section class="memory"[\s\S]*?<\/section>/)[0];
  return [...sec.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1].trim());
}
test('H1 memory section: title, ten paragraphs, key facts, no English substitution', () => {
  assert.match(html, /<h2 id="memory-title">দাদির স্মৃতি ধরে রাখার এক বিশেষ প্রচেষ্টা ❤️<\/h2>/);
  const ps = memoryParagraphs();
  assert.equal(ps.length, 10);
  const starts = ['২৮ অক্টোবর ২০২৬, ভোর ৫টা ১০ মিনিট', 'আজ আমি আব্বুর দ্বিতীয় ফোনটি', 'আমি জানি, একটি ভিডিও কখনোই', 'ভিডিওটির মূল আকার ছিল প্রায় ২১ জিবি', 'সবচেয়ে আনন্দের বিষয় হলো', 'আমার পরিকল্পনা হলো', 'আমি জানি, সময় কখনো থেমে থাকে না', 'দাদির সঙ্গে কাটানো প্রতিটি মুহূর্ত', 'আমি চাই, সময় যতই এগিয়ে যাক', 'সময় চলে যায়, কিন্তু ভালোবাসার'];
  starts.forEach((s, i) => assert.ok(ps[i].startsWith(s), 'paragraph ' + (i + 1)));
  const all = ps.join('\n');
  for (const k of ['৪ ঘণ্টা ৪ মিনিট ৪ সেকেন্ডের', 'প্রায় ২১ জিবি', 'প্রায় ৫.১ জিবি', 'ইউটিউবে', 'হ্যান্ডব্যাগ', 'কিন্তু ভালোবাসার স্মৃতিগুলো যত্ন করে ধরে রাখা যায়। ❤️']) {
    assert.ok(all.includes(k), 'missing: ' + k);
  }
  assert.ok(!/[A-Za-z0-9]/.test(all.replace(/<[^>]+>/g, '')), 'no Latin letters or Western digits inside the passage');
  assert.match(html, /<section class="memory"[^>]*lang="bn"/);
});
test('H2 memory section has no script hooks and counters never read it', () => {
  const sec = html.match(/<section class="memory"[\s\S]*?<\/section>/)[0];
  assert.ok(!/<script|data-counter|data-seg|onclick/i.test(sec));
  const js = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(!/memory/i.test(js.replace(/\/\*[\s\S]*?\*\//g, '')) || !/getElementById\(['"]memory/.test(js));
});
test('H3 no external dependencies or third-party hosts for fonts/scripts', () => {
  assert.ok(!/<script[^>]+src="https?:/i.test(html));
  assert.ok(!/<link[^>]+href="https?:/i.test(html));
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(css));
});
test('H4 exactly three counter cards', () => {
  assert.equal((html.match(/data-counter="/g) || []).length, 3);
  assert.equal(TC.COUNTER_SPECS.length, 3);
});

/* ---- Regression: browser timer binding ("Illegal invocation") ---------------------------
 * Real browsers throw if setTimeout/clearTimeout run with a `this` other than the window.
 * createCounter's DEFAULT timers (used in production) must call them as plain functions.
 * Earlier versions stored the bare functions in an object and called timers.set(...), which
 * works in Node but killed boot() in every browser. All other tests inject fake timers, so
 * this test deliberately uses the defaults with strict browser-like globals. */
test('R1 default counter timers call setTimeout/clearTimeout as plain functions', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let bindingViolations = 0;
  globalThis.setTimeout = function (fn, ms) {
    if (this !== undefined && this !== globalThis) { bindingViolations++; throw new TypeError('Illegal invocation'); }
    return realSet(fn, ms);
  };
  globalThis.clearTimeout = function (h) {
    if (this !== undefined && this !== globalThis) { bindingViolations++; throw new TypeError('Illegal invocation'); }
    return realClear(h);
  };
  let renders = 0;
  const c = TC.createCounter({
    id: 'regression',
    compute: () => ({ state: 'running', values: [1n, 2n, 3n], msToNext: 40 }),
    getNow: () => 0n,
    view: { render() { renders++; }, setStatus() {}, setError() {} },
    capMs: 1000
  });
  try {
    c.start();
    await new Promise((r) => realSet(r, 250));
    c.refresh();
    c.destroy();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.equal(bindingViolations, 0);
  assert.ok(renders >= 3, 'counter kept ticking on its own default timers, renders=' + renders);
});
