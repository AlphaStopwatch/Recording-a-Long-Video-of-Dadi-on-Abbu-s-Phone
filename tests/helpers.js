'use strict';
// Simulated time for deterministic tests: no real waiting, no real network.

const T0 = 1793142600000; // reference instant, UTC ms

function makeEnv(startWall) {
  const env = {
    mono: 5000,
    wall: startWall === undefined ? T0 : startWall,
    timers: [],
    nextId: 1,
    setTimeout(fn, ms) {
      const id = env.nextId++;
      env.timers.push({ id, at: env.mono + ms, fn });
      return id;
    },
    clearTimeout(id) {
      env.timers = env.timers.filter((t) => t.id !== id);
    },
    // Advance both clocks together, running due timers in order.
    async advance(ms) {
      const target = env.mono + ms;
      for (;;) {
        env.timers.sort((a, b) => a.at - b.at);
        const next = env.timers[0];
        if (!next || next.at > target) break;
        env.timers.shift();
        const dt = Math.max(0, next.at - env.mono);
        env.mono += dt;
        env.wall += dt;
        next.fn();
        await flush();
      }
      const rest = target - env.mono;
      env.mono += rest;
      env.wall += rest;
      await flush();
    },
    // Sleep: wall clock moves, monotonic clock does not (the failure mode on some phones).
    sleep(ms) { env.wall += ms; },
    // The user (or an OS) changes the device clock.
    jumpWall(ms) { env.wall += ms; },
    // Advance only the clocks without firing timers (a frozen page that later resumes).
    freeze(ms, { monoToo = true } = {}) {
      env.wall += ms;
      if (monoToo) env.mono += ms;
    }
  };
  return env;
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

// Build a fake fetch from { url-substring: handler }. Handler gets (env) and returns a
// response description, throws, or returns 'hang'.
function makeFetch(env, routes, opts) {
  opts = opts || {};
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init, at: env.mono });
    const key = Object.keys(routes).find((k) => url.indexOf(k) >= 0);
    if (!key) return Promise.reject(new Error('no route for ' + url));
    const out = routes[key](env, url, init);
    if (out === 'hang') return new Promise(() => {});
    if (out instanceof Error) return Promise.reject(out);
    const latency = opts.latency || 0;
    // the server stamps the response at call time; the round trip then takes `latency` ms
    env.mono += latency;
    env.wall += latency;
    return Promise.resolve(out);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, status) {
  return { ok: (status || 200) < 400, status: status || 200, json: async () => body, headers: { get: () => null } };
}
function dateHeaderResponse(utcMs, age) {
  const d = new Date(utcMs).toUTCString();
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    headers: { get: (k) => (k.toLowerCase() === 'date' ? d : k.toLowerCase() === 'age' && age !== undefined ? String(age) : null) }
  };
}
function worldTime(utcMs) {
  return jsonResponse({
    timezone: 'Asia/Dhaka',
    unixtime: Math.floor(utcMs / 1000),
    utc_datetime: new Date(utcMs).toISOString().replace('Z', '+00:00')
  });
}
function timeApiIo(utcMs) {
  const local = new Date(utcMs + 6 * 3600000).toISOString().replace('Z', '') + '0000';
  return jsonResponse({ timeZone: 'Asia/Dhaka', dateTime: local, milliSeconds: utcMs % 1000 });
}

module.exports = { T0, makeEnv, flush, makeFetch, jsonResponse, dateHeaderResponse, worldTime, timeApiIo };
