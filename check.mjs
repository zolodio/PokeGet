// Checks the Pokemon Center TCG category page, diffs against Supabase,
// and alerts (ntfy push and/or Discord) when something becomes in stock.
import { chromium } from 'playwright';
import fs from 'node:fs';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  NTFY_TOPIC,
  DISCORD_WEBHOOK_URL,
  PROXY_URL, // optional, e.g. http://user:pass@host:port (residential proxy recommended)
} = process.env;

const PAGE_URL = 'https://www.pokemoncenter.com/category/tcg-cards';
const OOS_RE = /out of stock|sold out|unavailable|notify me|coming soon/i;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Missing Supabase env vars');
if (!NTFY_TOPIC && !DISCORD_WEBHOOK_URL) throw new Error('Set NTFY_TOPIC and/or DISCORD_WEBHOOK_URL');

// ---------- Supabase (REST) ----------
const sb = async (path, opts = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

// ---------- Alerts ----------
async function notify(title, body, url) {
  const jobs = [];
  if (NTFY_TOPIC) {
    jobs.push(
      fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        body,
        headers: { Title: title, Priority: 'urgent', Tags: 'rotating_light', ...(url ? { Click: url } : {}) },
      })
    );
  }
  if (DISCORD_WEBHOOK_URL) {
    jobs.push(
      fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }),
      })
    );
  }
  await Promise.allSettled(jobs);
}

const logRun = (status, product_count, in_stock_count, note) =>
  sb('check_runs', {
    method: 'POST',
    body: JSON.stringify({ status, product_count, in_stock_count, note }),
  });

// ---------- Scrape ----------
async function scrape() {
  const browser = await chromium.launch({
    headless: false, // run under xvfb; headed Chromium is blocked far less often
    proxy: PROXY_URL ? { server: PROXY_URL } : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('a[href*="/product/"]', { timeout: 30000 }).catch(() => {});
    // scroll to trigger lazy-loaded tiles
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(700);
    }

    const items = await page.evaluate((oosSrc) => {
      const oos = new RegExp(oosSrc, 'i');
      const seen = new Map();
      for (const a of document.querySelectorAll('a[href*="/product/"]')) {
        const url = new URL(a.getAttribute('href'), location.origin).href.split('?')[0];
        // walk up to the tile container (first ancestor containing price text or a button)
        let tile = a;
        for (let i = 0; i < 5 && tile.parentElement; i++) {
          tile = tile.parentElement;
          if (/\$\d/.test(tile.innerText || '') || tile.querySelector('button')) break;
        }
        const text = (tile.innerText || '').replace(/\s+/g, ' ').trim();
        const name = (a.getAttribute('aria-label') || a.innerText || text).trim().slice(0, 200);
        const prev = seen.get(url);
        // if the same product appears twice, keep the richer tile text
        if (!prev || text.length > prev.text.length) {
          seen.set(url, { url, name, text, in_stock: !oos.test(text) });
        }
      }
      return [...seen.values()];
    }, OOS_RE.source);

    if (items.length === 0) {
      const title = await page.title();
      fs.writeFileSync('debug.html', await page.content());
      await page.screenshot({ path: 'debug.png', fullPage: true }).catch(() => {});
      return { blocked: true, title, items: [] };
    }
    return { blocked: false, items };
  } finally {
    await browser.close();
  }
}

// ---------- Main ----------
const result = await scrape();

if (result.blocked) {
  const last = await sb('check_runs?select=status&order=id.desc&limit=1');
  await logRun('blocked', 0, 0, `No products found. Page title: ${result.title}`);
  if (!last?.length || last[0].status !== 'blocked') {
    await notify(
      'Pokemon tracker blocked',
      `Pokemon Center returned no products (title: "${result.title}"). Bot protection may be blocking GitHub's IPs. Set a PROXY_URL secret.`
    );
  }
  console.error('Blocked / no products found. Title:', result.title);
  process.exit(1);
}

const { items } = result;
const existing = await sb('products?select=url,in_stock');
const prev = new Map(existing.map((r) => [r.url, r.in_stock]));
const firstRun = existing.length === 0;

const nowIso = new Date().toISOString();
const newlyInStock = items.filter((i) => i.in_stock && prev.get(i.url) !== true);

await sb('products?on_conflict=url', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify(
    items.map((i) => ({
      url: i.url,
      name: i.name,
      in_stock: i.in_stock,
      last_seen: nowIso,
      ...(i.in_stock ? { last_in_stock_at: nowIso } : {}),
    }))
  ),
});

const inStockCount = items.filter((i) => i.in_stock).length;
await logRun('ok', items.length, inStockCount, firstRun ? 'seed run' : null);

if (firstRun) {
  await notify(
    'Pokemon tracker is live',
    `Tracking ${items.length} products (${inStockCount} currently in stock). You'll be alerted on new restocks.`,
    PAGE_URL
  );
} else if (newlyInStock.length) {
  const lines = newlyInStock.slice(0, 10).map((i) => `• ${i.name}\n${i.url}`).join('\n');
  await notify(`Pokemon Center: ${newlyInStock.length} item(s) in stock!`, lines, newlyInStock[0].url);
}

console.log(`Checked ${items.length} products, ${inStockCount} in stock, ${newlyInStock.length} newly in stock.`);
