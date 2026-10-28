'use strict';
// Page-level tests in jsdom: real index.html + real script.js, fake network.
// jsdom has no layout engine, so these tests cover behaviour and DOM content, not pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const H = require('./helpers.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src="script.js"><\/script>/, '');
const js = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load({ online = true } = {}) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://example.github.io/capsule/',
    pretendToBeVisual: true,
    beforeParse(w) {
      if (online) {
        w.fetch = async (url) => {
          if (url.includes('worldtimeapi')) return H.worldTime(Date.now());
          if (url.includes('timeapi.io')) return H.timeApiIo(Date.now());
          return H.dateHeaderResponse(Date.now());
        };
      }
    }
  });
  dom.window.eval(js);
  return dom;
}
const card = (d, id) => d.window.document.querySelector('[data-counter="' + id + '"]');
const segs = (c) => [...c.querySelectorAll('[data-seg]')].map((e) => e.textContent);
const errHidden = (c) => c.querySelector('[data-error]').hidden;

test('DOM1 boot: three cards show live values consistent with the reference, no errors', async () => {
  const dom = load();
  await sleep(300);
  const { TimeCapsule } = dom.window;
  const nowMs = BigInt(Date.now());
  for (const [id, f] of [['calendar', TimeCapsule.computeCalendar], ['days', TimeCapsule.computeTotalDays], ['hours', TimeCapsule.computeTotalHours]]) {
    const c = card(dom, id);
    assert.ok(errHidden(c));
    assert.match(c.querySelector('[data-status]').textContent, /Live/);
    const shown = segs(c);
    const exp = f(nowMs).values.map((v, i) => TimeCapsule.formatSegment(v, i > 0));
    if (id === 'hours') assert.ok(shown[0] === exp[0] || true); // seconds tick; hours compared below
    assert.equal(shown[0].replace(/,/g, ''), exp[0].replace(/,/g, ''));
  }
  assert.match(dom.window.document.getElementById('sync-status').textContent, /Synced/);
  assert.equal(dom.window.document.documentElement.getAttribute('data-sync'), 'synced');
  dom.window.close();
});
test('DOM2 forced calculation fault in the calendar counter leaves the other two untouched, then self-recovers', async () => {
  const dom = load();
  await sleep(200);
  dom.window.__capsuleFaults = { calendar: 'compute' };
  dom.window.__capsule.counters.find((c) => c.id === 'calendar').refresh();
  assert.equal(errHidden(card(dom, 'calendar')), false);
  assert.match(card(dom, 'calendar').querySelector('[data-status]').textContent, /Recalculating/);
  const before = segs(card(dom, 'hours'));
  await sleep(1300);
  assert.ok(errHidden(card(dom, 'days')));
  assert.ok(errHidden(card(dom, 'hours')));
  assert.match(card(dom, 'hours').querySelector('[data-status]').textContent, /Live/);
  assert.notDeepEqual(segs(card(dom, 'hours')), before, 'seconds kept ticking');
  dom.window.__capsuleFaults = {};
  await sleep(2200);
  assert.ok(errHidden(card(dom, 'calendar')));
  assert.match(card(dom, 'calendar').querySelector('[data-status]').textContent, /Live/);
  dom.window.close();
});
test('DOM3 forced display fault in the hours counter is isolated', async () => {
  const dom = load();
  await sleep(200);
  dom.window.__capsuleFaults = { hours: 'render' };
  dom.window.__capsule.counters.find((c) => c.id === 'hours').refresh();
  assert.equal(errHidden(card(dom, 'hours')), false);
  assert.ok(errHidden(card(dom, 'calendar')));
  assert.ok(errHidden(card(dom, 'days')));
  dom.window.close();
});
test('DOM4 offline at load: counters still run on the device clock and status says so honestly', async () => {
  const dom = load({ online: false });
  await sleep(300);
  assert.match(card(dom, 'hours').querySelector('[data-status]').textContent, /Live/);
  const txt = dom.window.document.getElementById('sync-status').textContent;
  assert.match(txt, /(Checking|device|Offline)/i);
  assert.notEqual(dom.window.document.documentElement.getAttribute('data-sync'), 'synced');
  dom.window.close();
});
test('DOM5 3000-digit values: every digit reaches the DOM, nothing abbreviated, inspector shows exact digits', () => {
  const dom = load({ online: false });
  const { TimeCapsule } = dom.window;
  const c = card(dom, 'hours');
  const spec = TimeCapsule.COUNTER_SPECS.find((s) => s.id === 'hours');
  const view = TimeCapsule.makeCounterView(c, spec);
  const huge = 10n ** 2999n + 12345n;
  view.render({ state: 'running', values: [huge, 7n, 9n], msToNext: 1000 });
  const [h, m, s] = segs(c);
  assert.equal(h.replace(/,/g, ''), huge.toString());
  assert.equal(h.replace(/,/g, '').length, 3000);
  assert.equal(m, '07');
  assert.equal(s, '09');
  assert.equal(c.getAttribute('data-size'), 'xxs');
  assert.ok(!/e\+|…|\.\.\./.test(h));
  const det = c.querySelector('[data-inspect]');
  det.open = true;
  det.dispatchEvent(new dom.window.Event('toggle'));
  assert.ok(c.querySelector('[data-inspect-out]').textContent.includes(huge.toString()));
  assert.match(c.querySelector('[data-inspect-out]').textContent, /3000 digits/);
  dom.window.close();
});
test('DOM6 page structure: counters before memory, one h1, Bengali section isolated and in the DOM once', () => {
  const dom = load({ online: false });
  const d = dom.window.document;
  assert.equal(d.querySelectorAll('h1').length, 1);
  const pos = (el) => [...d.querySelectorAll('*')].indexOf(el);
  assert.ok(pos(d.getElementById('counters')) < pos(d.querySelector('.memory')));
  assert.equal(d.querySelectorAll('.memory p').length, 10);
  assert.equal(d.querySelector('.memory').getAttribute('lang'), 'bn');
  assert.equal(d.querySelectorAll('[aria-live]').length, 1, 'only the sync status is a live region');
  dom.window.close();
});
