// Builds the site: one page with the list of everything built in, plus a data file for each instrument.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { instrumentFile } from '../lib/market.js';
import { collectMovers } from '../lib/movers.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const moduleCode = (text) => text.replace(/^import .*\n/gm, '').replace(/^export /gm, '');
const dist = new URL('../dist/', import.meta.url);
const site = new URL('../.cache/site/', import.meta.url);

const FONTS = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';
const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#111111"/><path d="M5 16h22" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M11 8v7M11 19v5M21 6v3M21 13v13" stroke="#fff" stroke-opacity=".62" stroke-width="2.5" stroke-linecap="round"/></svg>')}`;
// Runs before the first paint, so a saved theme never flashes the wrong colours.
const THEME_SCRIPT = `try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch{}`;
// Also before the first paint, so the opening starts from black. Any touch or key skips it.
const INTRO_SCRIPT = `if(matchMedia('(prefers-reduced-motion: no-preference)').matches){const r=document.documentElement,e=['pointerdown','keydown','wheel','touchstart'],end=()=>{r.classList.remove('intro');e.forEach(n=>removeEventListener(n,end,true))};r.classList.add('intro');e.forEach(n=>addEventListener(n,end,{capture:true,passive:true}));setTimeout(end,2400)}`;

const meta = await read('.cache/site/meta.json');
// "<" is escaped so that no company name can end the script tag early.
const data = meta.replace(/</g, '\\u003c');

const script = [
  moduleCode(await read('lib/pivot.js')),
  moduleCode(await read('lib/market.js')),
  moduleCode(await read('page/ui.js')),
  moduleCode(await read('page/chart.js')),
  moduleCode(await read('page/ipo.js')),
  await read('page/app.js'),
].join('\n');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="google-site-verification" content="YMwkZ820s7uDLKN7I7OW0ydEguS_hjWnRuNEMCQa0j4">
<title>Market Pivots and IPOs</title>
<meta name="description" content="Pivot points, charts, fundamentals, news and IPOs for the Indian stock market.">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<script>${THEME_SCRIPT}${INTRO_SCRIPT}</script>
<style>
${await read('page/styles.css')}</style>
</head>
<body>
${await read('page/backdrop.html')}${await read('page/body.html')}
<script type="application/json" id="market-data">${data}</script>
<script type="module">
${script}</script>
</body>
</html>
`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(new URL('data/', dist), { recursive: true });
cpSync(new URL('i/', site), new URL('data/i/', dist), { recursive: true });
if (existsSync(new URL('ipos.json', site))) cpSync(new URL('ipos.json', site), new URL('data/ipos.json', dist));
await writeFile(new URL('index.html', dist), page);

// Named from the list rather than the folder, so a stray copy of a file can't count a stock twice.
function* allStocks() {
  for (const [symbol, , type] of JSON.parse(meta).list) {
    if (type === 'Stock') yield JSON.parse(readFileSync(new URL(`i/${instrumentFile(symbol)}`, site), 'utf8'));
  }
}
mkdirSync(new URL('data/m/', dist), { recursive: true });
const movers = collectMovers(allStocks());
for (const [date, day] of movers) writeFileSync(new URL(`data/m/${date}.json`, dist), JSON.stringify(day));

const { coverage } = JSON.parse(meta);
console.log(`Built dist/: ${(page.length / 1e6).toFixed(2)} MB page, ${coverage}, gainers and losers for ${movers.size} days`);
