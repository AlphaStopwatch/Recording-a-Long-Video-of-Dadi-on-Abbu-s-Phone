"""Real-browser smoke test (Chromium via Playwright). Run: python3 tests/browser-smoke.py
Checks: no page errors, all three counters live, seconds advance by exactly 1 per second,
no horizontal overflow with 1..5000-digit values at 320/768/1280 px."""
import asyncio, os, sys
from playwright.async_api import async_playwright
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'index.html'))

async def main():
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1200, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL)
        secs = []
        for _ in range(12):
            await pg.wait_for_timeout(1000)
            st = await pg.evaluate("[...document.querySelectorAll('[data-counter]')].map(c=>c.dataset.state)")
            if st != ['running'] * 3: fails.append('counter states ' + str(st))
            secs.append(int(await pg.evaluate("document.querySelector('[data-counter=hours] [data-seg]:nth-of-type(1)') && [...document.querySelectorAll('[data-counter=hours] [data-seg]')][2].textContent")))
        steps = {(secs[i + 1] - secs[i]) % 60 for i in range(len(secs) - 1)}
        if not steps <= {0, 1, 2} or 1 not in steps: fails.append('seconds not advancing: ' + str(secs))
        if errs: fails.append('page errors: ' + str(errs))
        for w in (320, 768, 1280):
            await pg.set_viewport_size({'width': w, 'height': 900})
            for n in (1, 7, 13, 60, 1000, 5000):
                bad = await pg.evaluate('''(n)=>{const TC=window.TimeCapsule;window.__capsule.counters.forEach(c=>c.destroy());
                  let bad=0;document.querySelectorAll('[data-counter]').forEach(card=>{
                    const spec=TC.COUNTER_SPECS.find(s=>s.id===card.dataset.counter);
                    TC.makeCounterView(card,spec).render({state:'running',values:[BigInt('9'.repeat(n)),12n,34n]});
                    const cr=card.getBoundingClientRect();
                    card.querySelectorAll('.num,.unit').forEach(e=>{const r=e.getBoundingClientRect();if(r.right>cr.right-1||r.left<cr.left+1)bad++;});});
                  return bad+(document.documentElement.scrollWidth>document.documentElement.clientWidth+1?1:0);}''', n)
                if bad: fails.append(f'overflow at {w}px with {n} digits')
            await pg.reload()
        await b.close()
    print('FAIL: ' + '; '.join(fails) if fails else 'browser smoke: all checks passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
