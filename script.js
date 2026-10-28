/*
 * The Grandma's Time Capsule — script.js
 *
 * One file, four isolated layers (each can fail without taking down the others):
 *   1. CORE      pure BigInt math + calendar arithmetic (no DOM, no clock, no network)
 *   2. TIME      time-synchronisation service (HTTPS sources, monotonic clock)
 *   3. COUNTERS  three independent counter engines, each with its own error boundary
 *   4. UI        DOM views + boot (only runs in a browser)
 *
 * Works in a browser (global `TimeCapsule`) and in Node (module.exports) so the
 * same code is exercised by tests/run-tests.js.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimeCapsule = api;
  if (typeof document !== 'undefined') api.boot();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ====================================================================
   * 1. CORE
   * ==================================================================== */

  // The immutable historical reference. Never read from storage or the network.
  var REFERENCE = Object.freeze({
    iso: '2026-10-28T05:10:00+06:00',
    utcIso: '2026-10-27T23:10:00Z',
    utcMs: 1793142600000n, // integer milliseconds since the Unix epoch (UTC)
    offsetMinutes: 360, // Asia/Dhaka at the reference instant: UTC+06:00
    zone: 'Asia/Dhaka'
  });

  var SECOND = 1000n;
  var MINUTE = 60000n;
  var HOUR = 3600000n;
  var DAY = 86400000n;

  // Sanity floor for time-source answers (NOT an expiry date; there is no upper bound).
  var MIN_PLAUSIBLE_UTC_MS = 1790000000000; // 2026-09-21

  function referenceIsConsistent() {
    var parsed = parseIsoToMs(REFERENCE.iso, 0);
    var parsedUtc = parseIsoToMs(REFERENCE.utcIso, 0);
    return (
      parsed !== null &&
      parsedUtc !== null &&
      BigInt(parsed) === REFERENCE.utcMs &&
      BigInt(parsedUtc) === REFERENCE.utcMs
    );
  }

  function floorDiv(a, b) {
    var q = a / b;
    if (a % b !== 0n && a < 0n !== b < 0n) q -= 1n;
    return q;
  }
  function mod(a, b) {
    return a - floorDiv(a, b) * b;
  }

  function isLeap(y) {
    return (y % 4n === 0n && y % 100n !== 0n) || y % 400n === 0n;
  }
  var MONTH_DAYS = [31n, 28n, 31n, 30n, 31n, 30n, 31n, 31n, 30n, 31n, 30n, 31n];
  function daysInMonth(y, m) {
    return m === 2n && isLeap(y) ? 29n : MONTH_DAYS[Number(m - 1n)];
  }

  // Proleptic Gregorian <-> day number (days since 1970-01-01), BigInt, unbounded range.
  function daysFromCivil(y, m, d) {
    if (m <= 2n) y -= 1n;
    var era = floorDiv(y, 400n);
    var yoe = y - era * 400n;
    var mp = (m + 9n) % 12n;
    var doy = (153n * mp + 2n) / 5n + d - 1n;
    var doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
    return era * 146097n + doe - 719468n;
  }
  function civilFromDays(z) {
    z += 719468n;
    var era = floorDiv(z, 146097n);
    var doe = z - era * 146097n;
    var yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
    var y = yoe + era * 400n;
    var doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
    var mp = (5n * doy + 2n) / 153n;
    var d = doy - (153n * mp + 2n) / 5n + 1n;
    var m = mp < 10n ? mp + 3n : mp - 9n;
    if (m <= 2n) y += 1n;
    return { y: y, m: m, d: d };
  }

  function splitLocal(ms) {
    var days = floorDiv(ms, DAY);
    var tod = ms - days * DAY;
    var c = civilFromDays(days);
    return { y: c.y, m: c.m, d: c.d, tod: tod };
  }

  function addMonthsClamped(s, months) {
    var idx = s.y * 12n + (s.m - 1n) + months;
    var y = floorDiv(idx, 12n);
    var m = mod(idx, 12n) + 1n;
    var dim = daysInMonth(y, m);
    var d = s.d > dim ? dim : s.d;
    return daysFromCivil(y, m, d) * DAY + s.tod;
  }

  /*
   * Calendar convention (documented in README):
   *   A month is complete when the same day-of-month at the same time of day is reached.
   *   If the target month is shorter, the day is clamped to its last day (Jan 31 + 1 month
   *   = Feb 28/29). Remaining days are whole 24-hour periods after that anchor.
   * Inputs are BigInt "local" epoch milliseconds (UTC ms + zone offset).
   */
  function calendarDiff(startLocalMs, endLocalMs) {
    if (endLocalMs < startLocalMs) throw new RangeError('end precedes start');
    var s = splitLocal(startLocalMs);
    var e = splitLocal(endLocalMs);
    var months = (e.y - s.y) * 12n + (e.m - s.m);
    if (months < 0n) months = 0n;
    var anchor = addMonthsClamped(s, months);
    var guard = 0;
    while (anchor > endLocalMs && months > 0n && guard++ < 3) {
      months -= 1n;
      anchor = addMonthsClamped(s, months);
    }
    return {
      years: months / 12n,
      months: months % 12n,
      days: floorDiv(endLocalMs - anchor, DAY)
    };
  }

  /* --- digit formatting: exact, never abbreviated ------------------------- */
  function groupDigits(str) {
    var neg = str.charAt(0) === '-';
    var digits = neg ? str.slice(1) : str;
    var out = '';
    for (var i = digits.length; i > 0; i -= 3) {
      out = digits.slice(Math.max(0, i - 3), i) + (out ? ',' + out : '');
    }
    return (neg ? '-' : '') + out;
  }
  function pad2(big) {
    var s = big.toString();
    return s.length < 2 ? '0' + s : s;
  }

  /* --- the three computations (pure; take BigInt UTC ms) ------------------ */
  function computeCalendar(nowUtcMs) {
    var elapsed = nowUtcMs - REFERENCE.utcMs;
    if (elapsed < 0n) return { state: 'waiting', msToNext: Number(-elapsed > 60000n ? 60000n : -elapsed) };
    var off = BigInt(REFERENCE.offsetMinutes) * MINUTE;
    var r = calendarDiff(REFERENCE.utcMs + off, nowUtcMs + off);
    return {
      state: 'running',
      values: [r.years, r.months, r.days],
      msToNext: Number(DAY - (elapsed % DAY))
    };
  }
  function computeTotalDays(nowUtcMs) {
    var elapsed = nowUtcMs - REFERENCE.utcMs;
    if (elapsed < 0n) return { state: 'waiting', msToNext: Number(-elapsed > 60000n ? 60000n : -elapsed) };
    var days = elapsed / DAY;
    var hours = (elapsed % DAY) / HOUR;
    var minutes = (elapsed % HOUR) / MINUTE;
    return { state: 'running', values: [days, hours, minutes], msToNext: Number(MINUTE - (elapsed % MINUTE)) };
  }
  function computeTotalHours(nowUtcMs) {
    var elapsed = nowUtcMs - REFERENCE.utcMs;
    if (elapsed < 0n) return { state: 'waiting', msToNext: Number(-elapsed > 60000n ? 60000n : -elapsed) };
    var hours = elapsed / HOUR;
    var minutes = (elapsed % HOUR) / MINUTE;
    var seconds = (elapsed % MINUTE) / SECOND;
    return { state: 'running', values: [hours, minutes, seconds], msToNext: Number(SECOND - (elapsed % SECOND)) };
  }

  /* --- ISO-8601 parser (tolerates >3 fraction digits, optional offset) ---- */
  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
  function parseIsoToMs(str, defaultOffsetMinutes) {
    if (typeof str !== 'string') return null;
    var m = ISO_RE.exec(str.trim());
    if (!m) return null;
    var Y = +m[1], Mo = +m[2], D = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || s > 60) return null;
    var frac = m[7] ? Math.floor(parseFloat('0.' + m[7]) * 1000) : 0;
    var offset = defaultOffsetMinutes;
    if (m[8]) {
      if (m[8] === 'Z') offset = 0;
      else {
        var sign = m[8].charAt(0) === '-' ? -1 : 1;
        var digits = m[8].slice(1).replace(':', '');
        offset = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10));
      }
    }
    var ms = Date.UTC(Y, Mo - 1, D, h, mi, s, frac) - offset * 60000;
    return Number.isFinite(ms) ? ms : null;
  }

  /* ====================================================================
   * 2. TIME SERVICE
   * ==================================================================== */

  var DHAKA_OFFSET_MIN = 360;

  function parseWorldTimeApi(json) {
    if (!json || typeof json !== 'object') throw new Error('not an object');
    var utc = parseIsoToMs(json.utc_datetime, 0);
    if (utc === null) throw new Error('bad utc_datetime');
    if (typeof json.unixtime !== 'number' || !Number.isFinite(json.unixtime)) throw new Error('bad unixtime');
    if (Math.abs(json.unixtime * 1000 - utc) > 2000) throw new Error('unixtime and utc_datetime disagree');
    if (json.timezone && json.timezone !== 'Asia/Dhaka') throw new Error('unexpected timezone');
    return { utcMs: utc, resolutionMs: 1 };
  }
  function parseTimeApiIo(json) {
    if (!json || typeof json !== 'object') throw new Error('not an object');
    if (json.timeZone && json.timeZone !== 'Asia/Dhaka') throw new Error('unexpected timezone');
    // timeapi.io returns local wall time without an offset; Asia/Dhaka is a fixed UTC+06:00.
    var utc = parseIsoToMs(json.dateTime, DHAKA_OFFSET_MIN);
    if (utc === null) throw new Error('bad dateTime');
    return { utcMs: utc, resolutionMs: 1 };
  }
  function parseDateHeader(dateHeader, ageHeader) {
    if (typeof dateHeader !== 'string') throw new Error('no Date header');
    var t = Date.parse(dateHeader);
    if (!Number.isFinite(t)) throw new Error('bad Date header');
    var age = ageHeader ? parseInt(ageHeader, 10) : 0;
    if (!Number.isFinite(age) || age < 0) age = 0;
    // Date has 1 s resolution: true time lies in [t, t+1000); use the midpoint.
    return { utcMs: t + age * 1000 + 500, resolutionMs: 1000, coarse: true };
  }

  function defaultSources(locationHref) {
    var list = [
      {
        id: 'worldtimeapi',
        label: 'WorldTimeAPI',
        url: 'https://worldtimeapi.org/api/timezone/Asia/Dhaka',
        read: function (res) {
          return res.json().then(parseWorldTimeApi);
        }
      },
      {
        id: 'timeapi-io',
        label: 'TimeAPI.io',
        url: 'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Dhaka',
        read: function (res) {
          return res.json().then(parseTimeApiIo);
        }
      }
    ];
    if (locationHref && /^https:/i.test(locationHref)) {
      list.push({
        id: 'host-date-header',
        label: 'This website’s host (HTTP Date header)',
        url: locationHref.split('#')[0],
        method: 'HEAD',
        read: function (res) {
          return Promise.resolve(parseDateHeader(res.headers.get('date'), res.headers.get('age')));
        }
      });
    }
    return list;
  }

  /*
   * TimeService keeps ONE anchor: (utcMs at monotonic instant `mono`) + uncertainty.
   * estimate = anchor.utcMs + (mono() - anchor.mono). Timers are never the source of truth.
   * All clocks and I/O are injected so tests can run on simulated time.
   */
  function TimeService(opts) {
    opts = opts || {};
    var cfg = {
      sources: opts.sources || [],
      mono: opts.mono || function () { return performance.now(); },
      wall: opts.wall || function () { return Date.now(); },
      fetchFn: opts.fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
      setTimeout: opts.setTimeout || function (f, ms) { return setTimeout(f, ms); },
      clearTimeout: opts.clearTimeout || function (h) { return clearTimeout(h); },
      timeoutMs: opts.timeoutMs || 8000,
      healthyIntervalMs: opts.healthyIntervalMs || 5 * 60 * 1000,
      staleAfterMs: opts.staleAfterMs || 10 * 60 * 1000,
      backoffBaseMs: opts.backoffBaseMs || 5000,
      backoffMaxMs: opts.backoffMaxMs || 5 * 60 * 1000,
      largeCorrectionMs: opts.largeCorrectionMs || 2000,
      driftPpm: 50,
      isOnline: opts.isOnline || function () { return typeof navigator === 'undefined' || navigator.onLine !== false; }
    };

    var anchor = null; // { utcMs, mono, uncMs, sourceId, sourceLabel, syncedMono, multi }
    var pending = null; // unconfirmed large correction
    var inflight = null;
    var failures = 0;
    var timer = null;
    var lastCheck = { wall: cfg.wall(), mono: cfg.mono() };
    var note = '';
    var lastRound = { ok: false, detail: '' };
    var listeners = [];
    var log = [];
    var stopped = false;

    function addLog(msg) {
      log.push({ at: cfg.wall(), msg: String(msg).slice(0, 200) });
      if (log.length > 40) log.splice(0, log.length - 40); // bounded diagnostics
    }
    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (e) { addLog('listener error: ' + (e && e.message)); }
      }
    }

    function estimateUtcMsFloat() {
      if (anchor) return anchor.utcMs + (cfg.mono() - anchor.mono);
      return cfg.wall(); // unverified fallback — labelled as such in the status
    }
    function nowUtcMs() {
      var v = estimateUtcMsFloat();
      if (!Number.isFinite(v)) throw new Error('time estimate unavailable');
      return BigInt(Math.floor(v));
    }

    function uncertaintyMs() {
      if (!anchor) return null;
      var age = Math.max(0, cfg.mono() - anchor.syncedMono);
      return Math.round(anchor.uncMs + age * cfg.driftPpm * 1e-6);
    }

    function getStatus() {
      var unc = uncertaintyMs();
      var level, label;
      if (!anchor) {
        level = 'unverified';
        label = cfg.isOnline() ? 'Checking internet time…' : 'Offline — using this device’s clock (not verified)';
      } else {
        var age = cfg.mono() - anchor.syncedMono;
        if (age > cfg.staleAfterMs || note) {
          level = 'stale';
          label = cfg.isOnline() ? 'Estimating — last check ' + humanAge(age) + ' ago' : 'Offline — estimating from the last check ' + humanAge(age) + ' ago';
        } else {
          level = 'synced';
          label = 'Synced with internet time';
        }
      }
      return {
        level: level,
        label: label,
        source: anchor ? anchor.sourceLabel : null,
        multiSource: anchor ? anchor.multi : false,
        uncertaintyMs: unc,
        ageMs: anchor ? Math.round(cfg.mono() - anchor.syncedMono) : null,
        note: note || (pending ? 'Large time correction found — verifying with another check.' : ''),
        lastRound: lastRound
      };
    }
    function humanAge(ms) {
      var s = Math.max(0, Math.round(ms / 1000));
      if (s < 90) return s + ' s';
      var m = Math.round(s / 60);
      if (m < 90) return m + ' min';
      var h = Math.round(m / 60);
      if (h < 48) return h + ' h';
      return Math.round(h / 24) + ' days';
    }

    /* Detect sleep / suspension / clock jumps by comparing wall and monotonic deltas. */
    function checkpoint(reason) {
      var w = cfg.wall();
      var m = cfg.mono();
      var wallDelta = w - lastCheck.wall;
      var monoDelta = m - lastCheck.mono;
      lastCheck = { wall: w, mono: m };
      var gap = wallDelta - monoDelta;
      if (Math.abs(gap) < 1500) return 0;
      if (gap > 0 && anchor) {
        // The monotonic clock paused (sleep / suspension) while the wall clock moved on.
        anchor.utcMs += gap;
        anchor.uncMs += 1000;
        note = 'Resumed after a pause — re-checking internet time.';
        addLog('resume gap ' + Math.round(gap) + ' ms compensated (' + reason + ')');
      } else if (gap < 0) {
        addLog('device clock moved backward ' + Math.round(-gap) + ' ms; ignored (' + reason + ')');
        note = 'Device clock changed — ignoring it and re-checking internet time.';
      }
      syncSoon(0);
      emit();
      return gap;
    }

    function withTimeout(promise, ms, controller) {
      return new Promise(function (resolve, reject) {
        var h = cfg.setTimeout(function () {
          try { if (controller) controller.abort(); } catch (e) { /* ignore */ }
          reject(new Error('timeout'));
        }, ms);
        promise.then(
          function (v) { cfg.clearTimeout(h); resolve(v); },
          function (e) { cfg.clearTimeout(h); reject(e); }
        );
      });
    }

    function querySource(src) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var t0 = cfg.mono();
      var init = { method: src.method || 'GET', cache: 'no-store', credentials: 'omit' };
      if (controller) init.signal = controller.signal;
      var p = Promise.resolve()
        .then(function () { return cfg.fetchFn(src.url, init); })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
          return src.read(res);
        });
      return withTimeout(p, cfg.timeoutMs, controller).then(function (r) {
        var t1 = cfg.mono();
        var rtt = t1 - t0;
        if (!(rtt >= 0) || rtt > cfg.timeoutMs) throw new Error('implausible round trip');
        if (!Number.isFinite(r.utcMs) || r.utcMs < MIN_PLAUSIBLE_UTC_MS) throw new Error('implausible time value');
        return {
          id: src.id,
          label: src.label,
          utcMs: r.utcMs,
          mono: t0 + rtt / 2, // server time is assumed to apply at the request midpoint
          uncMs: rtt / 2 + r.resolutionMs / 2 + 25,
          coarse: !!r.coarse
        };
      });
    }

    function project(res) {
      return res.utcMs + (cfg.mono() - res.mono);
    }

    function pickCluster(results) {
      var best = [];
      for (var i = 0; i < results.length; i++) {
        var group = [results[i]];
        for (var j = 0; j < results.length; j++) {
          if (i === j) continue;
          var tol = results[i].uncMs + results[j].uncMs + 1000;
          if (Math.abs(project(results[i]) - project(results[j])) <= tol) group.push(results[j]);
        }
        if (group.length > best.length) best = group;
      }
      return best;
    }

    function applyAnchor(sel, multi) {
      var best = sel.slice().sort(function (a, b) { return a.uncMs - b.uncMs; })[0];
      anchor = {
        utcMs: best.utcMs,
        mono: best.mono,
        uncMs: best.uncMs,
        sourceId: best.id,
        sourceLabel: multi ? best.label + ' + ' + (sel.length - 1) + ' more' : best.label + (best.coarse ? ' (1 s resolution)' : ''),
        syncedMono: cfg.mono(),
        multi: multi
      };
      pending = null;
      note = '';
    }

    function round(reason) {
      var sources = cfg.sources;
      var attempts = sources.map(function (s) {
        return querySource(s).then(
          function (r) { return { ok: true, r: r, id: s.id }; },
          function (e) { return { ok: false, id: s.id, err: (e && e.message) || 'failed' }; }
        );
      });
      return Promise.all(attempts).then(function (outs) {
        var good = outs.filter(function (o) { return o.ok; }).map(function (o) { return o.r; });
        outs.filter(function (o) { return !o.ok; }).forEach(function (o) { addLog(o.id + ' failed: ' + o.err); });
        if (!good.length) {
          failures++;
          lastRound = { ok: false, detail: 'No time source answered.' };
          return false;
        }
        var cluster = pickCluster(good);
        var multi = cluster.length >= 2;
        if (!multi && good.length >= 2) {
          // several answers, none agree — do not trust any of them
          failures++;
          lastRound = { ok: false, detail: 'Time sources disagree; keeping the previous estimate.' };
          addLog('sources disagree: ' + good.map(function (g) { return g.id + '=' + Math.round(project(g)); }).join(', '));
          return false;
        }
        if (good.length > cluster.length) {
          good.forEach(function (g) {
            if (cluster.indexOf(g) < 0) addLog('rejected outlier ' + g.id);
          });
        }
        var cand = cluster.slice().sort(function (a, b) { return a.uncMs - b.uncMs; })[0];
        var candNow = project(cand);
        if (anchor) {
          var delta = candNow - estimateUtcMsFloat();
          var allowed = Math.max(cfg.largeCorrectionMs, 3 * (uncertaintyMs() + cand.uncMs));
          if (Math.abs(delta) > allowed && !multi) {
            // A single source asking for a big jump: require a second, consistent confirmation.
            if (pending && Math.abs(candNow - (pending.utcMs + (cfg.mono() - pending.mono))) <= 2 * (cand.uncMs + pending.uncMs) + 1000) {
              applyAnchor([cand], false);
              addLog('large correction confirmed: ' + Math.round(delta) + ' ms');
            } else {
              pending = { utcMs: cand.utcMs, mono: cand.mono, uncMs: cand.uncMs };
              lastRound = { ok: false, detail: 'Large correction awaiting confirmation.' };
              addLog('large correction pending: ' + Math.round(delta) + ' ms');
              return 'pending';
            }
          } else {
            applyAnchor(cluster, multi);
            if (Math.abs(delta) > allowed) addLog('large correction applied (multi-source): ' + Math.round(delta) + ' ms');
          }
        } else {
          applyAnchor(cluster, multi);
        }
        failures = 0;
        lastRound = { ok: true, detail: multi ? 'Sources agree.' : 'Single source answered.' };
        lastCheck = { wall: cfg.wall(), mono: cfg.mono() };
        return true;
      });
    }

    function syncOnce(reason) {
      if (inflight) return inflight; // never overlap requests
      if (!cfg.fetchFn || !cfg.sources.length) {
        lastRound = { ok: false, detail: 'No time source configured.' };
        emit();
        return Promise.resolve(false);
      }
      inflight = round(reason)
        .catch(function (e) {
          failures++;
          addLog('round error: ' + (e && e.message));
          return false;
        })
        .then(function (ok) {
          inflight = null;
          if (ok === true) note = '';
          schedule(ok);
          emit();
          return ok;
        });
      return inflight;
    }

    function schedule(ok) {
      if (stopped) return;
      if (timer !== null) cfg.clearTimeout(timer);
      var delay;
      if (ok === true) {
        delay = cfg.healthyIntervalMs * (0.9 + Math.random() * 0.2);
      } else if (ok === 'pending') {
        delay = 3000;
      } else {
        delay = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * Math.pow(2, Math.max(0, failures - 1)));
        delay *= 0.9 + Math.random() * 0.2;
      }
      timer = cfg.setTimeout(function () { timer = null; syncOnce('scheduled'); }, delay);
    }
    function syncSoon(ms) {
      if (stopped) return;
      if (timer !== null) cfg.clearTimeout(timer);
      timer = cfg.setTimeout(function () { timer = null; syncOnce('soon'); }, ms || 0);
    }

    return {
      nowUtcMs: nowUtcMs,
      getStatus: getStatus,
      syncOnce: syncOnce,
      syncSoon: syncSoon,
      checkpoint: checkpoint,
      subscribe: function (fn) { listeners.push(fn); },
      getLog: function () { return log.slice(); },
      start: function () { stopped = false; return syncOnce('start'); },
      stop: function () { stopped = true; if (timer !== null) cfg.clearTimeout(timer); timer = null; },
      _debug: function () { return { anchor: anchor && Object.assign({}, anchor), pending: pending, failures: failures }; }
    };
  }

  /* ====================================================================
   * 3. COUNTERS — three separate engines, each with its own error boundary
   * ==================================================================== */

  /*
   * A counter owns: its compute function, its view, its scheduler, its error state and
   * its recovery loop. It reads only (a) the shared time estimate and (b) the immutable
   * reference. It never reads another counter's output.
   */
  function createCounter(spec) {
    var id = spec.id;
    var timers = spec.timers || { set: setTimeout, clear: clearTimeout };
    var capMs = spec.capMs;
    var handle = null;
    var errorCount = 0;
    var state = { status: 'starting', lastError: null, renders: 0 };
    var destroyed = false;

    function schedule(ms) {
      if (destroyed) return;
      if (handle !== null) timers.clear(handle);
      handle = timers.set(tick, Math.max(30, ms));
    }

    function fail(stage, err) {
      errorCount++;
      state.status = 'recovering';
      state.lastError = stage + ': ' + ((err && err.message) || err);
      try { spec.view.setError('This counter hit a problem (' + stage + ') and is recalculating from the fixed start time. The other counters are not affected.'); } catch (e) { /* view itself broken */ }
      try { spec.view.setStatus('recovering'); } catch (e) { /* ignore */ }
      // bounded exponential backoff for this counter only: 0.5 s … 30 s
      schedule(Math.min(30000, 500 * Math.pow(2, Math.min(errorCount - 1, 6))));
    }

    function tick() {
      handle = null;
      if (destroyed) return;
      var result;
      try {
        result = spec.compute(spec.getNow());
      } catch (e) {
        fail('calculation', e);
        return;
      }
      try {
        spec.view.render(result);
        spec.view.setStatus(result.state);
        spec.view.setError(null);
      } catch (e) {
        fail('display', e);
        return;
      }
      errorCount = 0;
      state.status = result.state;
      state.lastError = null;
      state.renders++;
      schedule(Math.min(capMs, (result.msToNext || capMs) + 15));
    }

    return {
      id: id,
      start: function () { tick(); },
      refresh: function () { if (handle !== null) timers.clear(handle); handle = null; tick(); },
      destroy: function () { destroyed = true; if (handle !== null) timers.clear(handle); },
      getState: function () { return Object.assign({}, state, { errorCount: errorCount }); }
    };
  }

  var COUNTER_SPECS = Object.freeze([
    { id: 'calendar', compute: computeCalendar, capMs: 30000, units: ['YEARS', 'MONTHS', 'DAYS'], pads: [false, true, true] },
    { id: 'days', compute: computeTotalDays, capMs: 10000, units: ['DAYS', 'HOURS', 'MINUTES'], pads: [false, true, true] },
    { id: 'hours', compute: computeTotalHours, capMs: 1000, units: ['HOURS', 'MINUTES', 'SECONDS'], pads: [false, true, true] }
  ]);

  /* ====================================================================
   * 4. UI (browser only)
   * ==================================================================== */

  function formatSegment(value, padded) {
    return padded ? pad2(value) : groupDigits(value.toString());
  }

  function makeCounterView(cardEl, spec) {
    var valueEls = cardEl.querySelectorAll('[data-seg]');
    var statusEl = cardEl.querySelector('[data-status]');
    var errorEl = cardEl.querySelector('[data-error]');
    var timerEl = cardEl.querySelector('[data-timer]');
    var inspect = cardEl.querySelector('[data-inspect]');
    var inspectOut = cardEl.querySelector('[data-inspect-out]');
    var shown = ['', '', ''];
    var lastResult = null;
    var lastErr = null;
    var lastStatus = null;

    var STATUS_TEXT = {
      running: '● Live',
      waiting: '◌ Waiting for the first moment',
      recovering: '▲ Recalculating',
      starting: '◌ Starting'
    };

    function renderInspector() {
      if (!inspect || !inspect.open || !lastResult || lastResult.state !== 'running') return;
      var lines = [];
      for (var i = 0; i < 3; i++) {
        var s = lastResult.values[i].toString();
        lines.push(spec.units[i] + ' (' + s.length + ' digit' + (s.length === 1 ? '' : 's') + ')\n' + s);
      }
      inspectOut.textContent = lines.join('\n\n');
    }
    if (inspect) inspect.addEventListener('toggle', renderInspector);

    return {
      render: function (result) {
        lastResult = result;
        var texts;
        if (result.state === 'running') {
          texts = result.values.map(function (v, i) { return formatSegment(v, spec.pads[i]); });
        } else {
          texts = ['0', '00', '00'];
        }
        var longest = 0;
        for (var i = 0; i < 3; i++) {
          if (texts[i] !== shown[i]) {
            valueEls[i].textContent = texts[i];
            shown[i] = texts[i];
          }
          if (texts[i].length > longest) longest = texts[i].length;
        }
        var size = longest <= 6 ? 'm' : longest <= 12 ? 's' : longest <= 24 ? 'xs' : 'xxs';
        if (cardEl.getAttribute('data-size') !== size) cardEl.setAttribute('data-size', size);
        if (result.state === 'running') {
          timerEl.setAttribute(
            'aria-label',
            texts.map(function (t, i) { return t.replace(/,/g, '') + ' ' + spec.units[i].toLowerCase(); }).join(', ')
          );
        } else {
          timerEl.setAttribute('aria-label', 'Waiting for the starting moment');
        }
        renderInspector();
      },
      setStatus: function (key) {
        if (key === lastStatus) return;
        lastStatus = key;
        statusEl.textContent = STATUS_TEXT[key] || STATUS_TEXT.starting;
        cardEl.setAttribute('data-state', key);
      },
      setError: function (msg) {
        if (msg === lastErr) return;
        lastErr = msg;
        if (msg) { errorEl.textContent = msg; errorEl.hidden = false; }
        else { errorEl.textContent = ''; errorEl.hidden = true; }
      }
    };
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return '±' + ms + ' ms';
    return '±' + (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  }

  function boot() {
    var d = document;
    // Integrity self-check: refuse to run counters if the constant is internally inconsistent.
    var integrityOk = false;
    try { integrityOk = referenceIsConsistent(); } catch (e) { integrityOk = false; }

    var service = TimeService({ sources: defaultSources(location.protocol === 'https:' ? location.href : null) });
    var counters = [];
    var viewsOk = [];

    var syncStatusEl = d.getElementById('sync-status');
    var syncDetailEl = d.getElementById('sync-detail');
    var syncBtn = d.getElementById('sync-now');
    var diagEl = d.getElementById('diagnostics');
    var lastLevel = null;

    function renderSync() {
      try {
        var s = service.getStatus();
        var glyph = s.level === 'synced' ? '● ' : s.level === 'stale' ? '▲ ' : '◌ ';
        var text = glyph + s.label;
        if (syncStatusEl.textContent !== text) syncStatusEl.textContent = text;
        d.documentElement.setAttribute('data-sync', s.level);
        var bits = [];
        if (s.source) bits.push('Source: ' + s.source);
        if (s.uncertaintyMs !== null) bits.push('Uncertainty ' + formatMs(s.uncertaintyMs));
        if (s.note) bits.push(s.note);
        else if (s.lastRound && !s.lastRound.ok && s.lastRound.detail) bits.push(s.lastRound.detail);
        var detail = bits.join(' · ');
        if (syncDetailEl.textContent !== detail) syncDetailEl.textContent = detail;
        if (lastLevel !== s.level) {
          lastLevel = s.level;
        }
      } catch (e) {
        syncStatusEl.textContent = '▲ Synchronisation status unavailable';
      }
    }

    function renderDiagnostics() {
      if (!diagEl) return;
      var parent = diagEl.parentElement;
      if (parent && parent.open === false) return;
      var lines = service.getLog().map(function (l) { return new Date(l.at).toISOString() + '  ' + l.msg; });
      diagEl.textContent = lines.length ? lines.join('\n') : 'No problems recorded.';
    }

    service.subscribe(function () {
      renderSync();
      renderDiagnostics();
      counters.forEach(function (c) { try { c.refresh(); } catch (e) { /* counter isolates its own errors */ } });
    });

    // Build each counter independently; a failure in one never prevents the rest.
    COUNTER_SPECS.forEach(function (spec) {
      try {
        var card = d.querySelector('[data-counter="' + spec.id + '"]');
        if (!card) throw new Error('missing card');
        var view = makeCounterView(card, spec);
        // Test hook: window.__capsuleFaults = { calendar: 'compute' | 'render' } injects a
        // failure into ONE counter so fault isolation can be verified. Inert by default.
        var rawRender = view.render;
        view.render = function (r) {
          var f = window.__capsuleFaults;
          if (f && f[spec.id] === 'render') throw new Error('injected render fault');
          return rawRender(r);
        };
        var c = createCounter({
          id: spec.id,
          compute: function (now) {
            var f = window.__capsuleFaults;
            if (f && f[spec.id] === 'compute') throw new Error('injected calculation fault');
            return spec.compute(now);
          },
          getNow: function () { return service.nowUtcMs(); },
          view: view,
          capMs: spec.capMs
        });
        counters.push(c);
      } catch (e) {
        try {
          var broken = d.querySelector('[data-counter="' + spec.id + '"] [data-error]');
          if (broken) { broken.textContent = 'This counter could not start. Reload the page to try again.'; broken.hidden = false; }
        } catch (e2) { /* ignore */ }
      }
    });

    if (!integrityOk) {
      var banner = d.getElementById('integrity-error');
      if (banner) banner.hidden = false;
    } else {
      counters.forEach(function (c) { c.start(); });
    }

    renderSync();
    service.start();
    // Cheap status refresh (text only changes when something actually changed).
    setInterval(renderSync, 5000);
    // Continuity watchdog: detects sleep / suspension / clock jumps.
    setInterval(function () { try { service.checkpoint('watchdog'); } catch (e) { /* ignore */ } }, 5000);

    function onResume(reason) {
      try { service.checkpoint(reason); } catch (e) { /* ignore */ }
      service.syncSoon(0);
      counters.forEach(function (c) { try { c.refresh(); } catch (e) { /* ignore */ } });
      renderSync();
    }
    d.addEventListener('visibilitychange', function () {
      if (d.visibilityState === 'visible') onResume('visible');
      else { try { service.checkpoint('hidden'); } catch (e) { /* ignore */ } }
    });
    window.addEventListener('pageshow', function () { onResume('pageshow'); });
    window.addEventListener('focus', function () { onResume('focus'); });
    window.addEventListener('online', function () { onResume('online'); });
    window.addEventListener('offline', renderSync);
    d.addEventListener('resume', function () { onResume('resume'); });

    if (syncBtn) {
      syncBtn.addEventListener('click', function () {
        syncBtn.disabled = true;
        service.syncOnce('manual').then(function () { syncBtn.disabled = false; renderSync(); });
      });
    }
    var diagParent = diagEl && diagEl.parentElement;
    if (diagParent) diagParent.addEventListener('toggle', renderDiagnostics);

    // Read-only handle for diagnostics and tests.
    window.__capsule = Object.freeze({ service: service, counters: counters, reference: REFERENCE });
  }

  return {
    REFERENCE: REFERENCE,
    MIN_PLAUSIBLE_UTC_MS: MIN_PLAUSIBLE_UTC_MS,
    referenceIsConsistent: referenceIsConsistent,
    floorDiv: floorDiv,
    mod: mod,
    isLeap: isLeap,
    daysInMonth: daysInMonth,
    daysFromCivil: daysFromCivil,
    civilFromDays: civilFromDays,
    calendarDiff: calendarDiff,
    groupDigits: groupDigits,
    pad2: pad2,
    formatSegment: formatSegment,
    computeCalendar: computeCalendar,
    computeTotalDays: computeTotalDays,
    computeTotalHours: computeTotalHours,
    parseIsoToMs: parseIsoToMs,
    parseWorldTimeApi: parseWorldTimeApi,
    parseTimeApiIo: parseTimeApiIo,
    parseDateHeader: parseDateHeader,
    defaultSources: defaultSources,
    TimeService: TimeService,
    createCounter: createCounter,
    makeCounterView: makeCounterView,
    COUNTER_SPECS: COUNTER_SPECS,
    boot: boot
  };
});
