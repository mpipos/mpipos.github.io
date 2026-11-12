// The heatmap: every stock in an index, coloured by the day's move. Treemap tiles are sized by market cap,
// as Groww shows them, and equal tiles sorted by the move are as NSE shows them. Tiles glide between layouts.
const HEAT_LAYOUTS = [
  { value: 'treemap', label: 'Treemap' },
  { value: 'tiles', label: 'Tiles' },
  { value: 'list', label: 'List' },
];
const HEAT_LEGEND = [
  [-4, 'Below −3%'],
  [-3, '−3%'],
  [-2, '−2%'],
  [-1, '−1%'],
  [0, '0%'],
  [1, '+1%'],
  [2, '+2%'],
  [3, '+3%'],
  [4, 'Above +3%'],
];
// This page shows official closing moves. During market hours NSE's own heatmap has the live ones.
const NSE_LIVE_HEATMAP = 'https://www.nseindia.com/market-data/live-market-indices/heatmap';
const HEAT_GAP = 2;
const SECTOR_HEADER = 18;
const LEAVE_MS = 420;

const bandClass = (percent) => {
  const band = heatBand(percent);
  return `heat-${band < 0 ? 'n' : 'p'}${Math.abs(band)}`;
};

function renderHeatmapView(host, { info, loadDay, tradingDays, open, initialDate, savedGroup, savedLayout, onChange }) {
  const stocks = info.stocks.map(([symbol, name, sector, cap]) => ({ symbol, name, sector: info.sectors[sector] ?? 'Other', cap }));
  const indices = info.indices.map(([symbol, label, members]) => ({ symbol, label, members }));
  const openable = indices.filter(({ members }) => members?.length);
  const state = {
    date: initialDate,
    group: openable.some(({ symbol }) => symbol === savedGroup) ? savedGroup : openable[0]?.symbol,
    layout: HEAT_LAYOUTS.some(({ value }) => value === savedLayout) ? savedLayout : 'treemap',
    day: null,
  };

  const tiles = new Map();
  let order = [];
  let focusIndex = 0;
  let token = 0;

  const dateInput = el('input', { type: 'date', min: tradingDays[0], max: tradingDays.at(-1), 'aria-label': 'Trading day' });
  const previous = el('button', { type: 'button', class: 'step', 'aria-label': 'Previous trading day' }, chevron('M10 3 5 8l5 5'));
  const next = el('button', { type: 'button', class: 'step', 'aria-label': 'Next trading day' }, chevron('m6 3 5 5-5 5'));
  const strip = el('div', { class: 'heat-indices', role: 'group', 'aria-label': 'NSE indices, with the day’s move. Choose one to map its stocks.' });
  const summary = el('p', { class: 'heat-summary', 'aria-live': 'polite' });
  const map = el('div', { class: 'heat-map', role: 'group', 'aria-label': 'Heatmap. Use the arrow keys to move between stocks.' });
  const tooltip = el('div', { class: 'heat-tip', role: 'tooltip', hidden: '' });
  const list = el('div', { class: 'heat-list', hidden: '' });
  const board = el('div', { class: 'heat-board' }, map, tooltip, list);
  const message = el('p', { class: 'heat-message', hidden: '' });

  function chevron(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', path);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
    return svg;
  }

  // A closed day shows the session before it, which is the move people mean by "that day".
  const sessionOnOrBefore = (iso) => tradingDays.findLast((day) => day <= iso) ?? tradingDays[0];
  const sessionIndex = () => tradingDays.indexOf(state.date);

  const groupStocks = () => (indices.find(({ symbol }) => symbol === state.group)?.members ?? []).map((i) => ({ ...stocks[i], index: i }));
  const moveOf = (stock) => state.day?.s[stock.index] ?? null;

  /* Layouts. Each returns the map's height and a rectangle for every tile, keyed by symbol. */

  function treemapLayout(members, width) {
    const height = width < 640 ? Math.round(width * 1.35) : Math.round(Math.min(720, Math.max(420, width * 0.56)));
    const known = members.map(({ cap }) => cap).filter(Boolean).sort((a, b) => a - b);
    const fallback = known.length ? known[0] : 1;
    const size = (stock) => stock.cap || fallback;
    const bySector = new Map();
    for (const stock of members) {
      if (!bySector.has(stock.sector)) bySector.set(stock.sector, []);
      bySector.get(stock.sector).push(stock);
    }
    const showSectors = bySector.size > 1;
    const sectorRects = showSectors
      ? squarify([...bySector].map(([sector, group]) => ({ key: sector, value: group.reduce((sum, stock) => sum + size(stock), 0) })), 0, 0, width, height)
      : [{ key: [...bySector.keys()][0], x: 0, y: 0, width, height }];

    const rects = [];
    const sectors = [];
    for (const area of sectorRects) {
      const labelled = showSectors && area.width > 84 && area.height > 52;
      const top = labelled ? SECTOR_HEADER : 0;
      if (labelled) sectors.push({ key: area.key, x: area.x, y: area.y, width: area.width });
      const inner = squarify(
        bySector.get(area.key).map((stock) => ({ key: stock.symbol, value: size(stock) })),
        area.x + (showSectors ? 1 : 0),
        area.y + top,
        area.width - (showSectors ? 2 : 0),
        area.height - top - (showSectors ? 2 : 0),
      );
      rects.push(...inner);
    }
    return { height, rects, sectors };
  }

  function tilesLayout(members, width) {
    const sorted = [...members].sort((a, b) => (moveOf(b)?.[1] ?? -Infinity) - (moveOf(a)?.[1] ?? -Infinity) || a.symbol.localeCompare(b.symbol));
    return { ...tileGrid(sorted.map(({ symbol }) => symbol), width, { minWidth: width < 640 ? 88 : 104, height: 60 }), sectors: [] };
  }

  /* Tiles */

  function tileLabel(stock, move) {
    const change = move ? `${move[1] > 0 ? 'up' : move[1] < 0 ? 'down' : 'unchanged'} ${formatNumber(Math.abs(move[1]))}%` : 'no comparable move';
    return `${stock.name} (${stock.symbol}), ${change}`;
  }

  function makeTile(stock) {
    const node = el(
      'button',
      { type: 'button', class: 'heat-tile is-entering', tabindex: '-1', 'data-symbol': stock.symbol, onclick: () => open(stock.symbol, state.date) },
      el('span', { class: 'heat-sym' }, displaySymbol(stock.symbol)),
      el('span', { class: 'heat-pct' }),
    );
    map.append(node);
    return node;
  }

  function placeTile(node, rect, stock, move) {
    const width = Math.max(0, rect.width - HEAT_GAP);
    const height = Math.max(0, rect.height - HEAT_GAP);
    node.style.translate = `${rect.x + HEAT_GAP / 2}px ${rect.y + HEAT_GAP / 2}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    node.className = `heat-tile ${bandClass(move?.[1])}${node.classList.contains('is-entering') ? ' is-entering' : ''}`;
    // The symbol is sized to fit the tile. The move shows below it when there's room, and tiny tiles stay plain.
    const symbolLength = Math.max(4, displaySymbol(stock.symbol).length);
    const fit = Math.min(20, (width - 6) / (symbolLength * 0.76), height / 2.2);
    node.dataset.size = fit < 8.5 ? 'none' : height >= fit * 2.6 && width >= 40 ? 'full' : 'name';
    node.style.fontSize = `${Math.max(8.5, fit).toFixed(1)}px`;
    node.querySelector('.heat-pct').textContent = move ? `${formatSigned(move[1])}%` : '—';
    node.setAttribute('aria-label', tileLabel(stock, move));
  }

  function drawMap() {
    const width = map.clientWidth;
    if (!width) return;
    const members = groupStocks();
    const bySymbol = new Map(members.map((stock) => [stock.symbol, stock]));
    const layout = state.layout === 'tiles' ? tilesLayout(members, width) : treemapLayout(members, width);
    map.style.height = `${layout.height}px`;

    const seen = new Set();
    for (const rect of layout.rects) {
      const stock = bySymbol.get(rect.key);
      seen.add(rect.key);
      let node = tiles.get(rect.key);
      if (!node || node.classList.contains('is-leaving')) {
        node?.remove();
        node = makeTile(stock);
        tiles.set(rect.key, node);
      }
      placeTile(node, rect, stock, moveOf(stock));
    }
    // New tiles grow in once they're in place; departing ones fade before they go.
    void map.offsetHeight;
    requestAnimationFrame(() => map.querySelectorAll('.is-entering').forEach((node) => node.classList.remove('is-entering')));
    for (const [key, node] of tiles) {
      if (seen.has(key) || key.startsWith('sector:')) continue;
      node.classList.add('is-leaving');
      tiles.delete(key);
      setTimeout(() => node.remove(), prefersMotion() ? LEAVE_MS : 0);
    }

    const sectorKeys = new Set();
    for (const sector of layout.sectors) {
      const key = `sector:${sector.key}`;
      sectorKeys.add(key);
      let node = tiles.get(key);
      if (!node) {
        node = el('span', { class: 'heat-sector', 'aria-hidden': 'true' }, sector.key);
        map.append(node);
        tiles.set(key, node);
      }
      node.style.translate = `${sector.x + 4}px ${sector.y + 2}px`;
      node.style.width = `${sector.width - 8}px`;
    }
    for (const [key, node] of tiles) {
      if (key.startsWith('sector:') && !sectorKeys.has(key)) {
        node.remove();
        tiles.delete(key);
      }
    }

    // Arrow keys follow what's on screen: the treemap's largest first, or the tiles' order.
    order = layout.rects.map(({ key }) => key);
    focusIndex = Math.min(focusIndex, Math.max(0, order.length - 1));
    tiles.forEach((node, key) => !key.startsWith('sector:') && node.setAttribute('tabindex', key === order[focusIndex] ? '0' : '-1'));
  }

  map.addEventListener('keydown', (event) => {
    const steps = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in steps) || !order.length) return;
    event.preventDefault();
    focusIndex = Math.max(0, Math.min(order.length - 1, focusIndex + steps[event.key]));
    tiles.forEach((node, key) => !key.startsWith('sector:') && node.setAttribute('tabindex', key === order[focusIndex] ? '0' : '-1'));
    tiles.get(order[focusIndex])?.focus();
  });

  /* Tooltip */

  function showTip(node, x, y) {
    const stock = stocks.find(({ symbol }) => symbol === node.dataset.symbol);
    if (!stock) return;
    const move = state.day?.s[stocks.indexOf(stock)] ?? null;
    tooltip.replaceChildren(
      el('strong', {}, stock.name),
      el('span', { class: 'heat-tip-meta' }, `${displaySymbol(stock.symbol)} · ${stock.sector}`),
      el(
        'dl',
        {},
        el('div', {}, el('dt', {}, 'Close'), el('dd', {}, move ? `₹${formatNumber(move[0])}` : '—')),
        el('div', {}, el('dt', {}, 'Change'), el('dd', { class: move ? directionClass(move[1]) : null }, move ? `${formatSigned(move[1])}%` : 'Not comparable')),
        stock.cap ? el('div', {}, el('dt', {}, 'Market cap'), el('dd', {}, `₹${formatNumber(stock.cap, 'INR', 0)} Cr`)) : null,
      ),
    );
    tooltip.hidden = false;
    const bounds = board.getBoundingClientRect();
    const tipWidth = tooltip.offsetWidth;
    const tipHeight = tooltip.offsetHeight;
    let left = x - bounds.left + 14;
    let top = y - bounds.top + 14;
    if (left + tipWidth > bounds.width) left = Math.max(0, x - bounds.left - tipWidth - 14);
    if (top + tipHeight > bounds.height) top = Math.max(0, y - bounds.top - tipHeight - 14);
    tooltip.style.translate = `${left}px ${top}px`;
  }

  map.addEventListener('pointermove', (event) => {
    const node = event.target.closest('.heat-tile');
    if (node && event.pointerType !== 'touch') showTip(node, event.clientX, event.clientY);
    else tooltip.hidden = true;
  });
  map.addEventListener('pointerleave', () => (tooltip.hidden = true));
  map.addEventListener('focusin', (event) => {
    const node = event.target.closest('.heat-tile');
    if (!node) return;
    focusIndex = Math.max(0, order.indexOf(node.dataset.symbol));
    const rect = node.getBoundingClientRect();
    showTip(node, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  map.addEventListener('focusout', () => (tooltip.hidden = true));

  /* The list: the same stocks as a table, sorted by the move. */

  function drawList() {
    const rows = groupStocks()
      .map((stock) => ({ stock, move: moveOf(stock) }))
      .sort((a, b) => (b.move?.[1] ?? -Infinity) - (a.move?.[1] ?? -Infinity) || a.stock.symbol.localeCompare(b.stock.symbol));
    list.replaceChildren(
      el(
        'div',
        { class: 'table-scroll is-tall', tabindex: '0', role: 'region', 'aria-label': 'Stocks in the index, by the day’s move' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, ...['Stock', 'Sector', 'Close', 'Change', 'Market cap (₹ Cr)'].map((heading) => el('th', { scope: 'col' }, heading)))),
          el(
            'tbody',
            {},
            ...rows.map(({ stock, move }) =>
              el(
                'tr',
                {},
                el('td', {}, el('button', { type: 'button', class: 'row-button', onclick: () => open(stock.symbol, state.date) }, el('span', { class: `heat-swatch ${bandClass(move?.[1])}`, 'aria-hidden': 'true' }), stock.name)),
                el('td', {}, stock.sector),
                el('td', {}, move ? formatNumber(move[0]) : '—'),
                el('td', { class: move ? directionClass(move[1]) : null }, move ? `${formatSigned(move[1])}%` : '—'),
                el('td', {}, stock.cap ? formatNumber(stock.cap, 'INR', 0) : '—'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /* Index strip and summary */

  // Built once and updated in place, so each index's colour fades from one day to the next.
  const stripItems = indices.map((index) => {
    const change = el('span', { class: 'heat-index-change' });
    const content = [el('span', { class: 'heat-index-name' }, index.label), change];
    const node = index.members?.length
      ? el(
          'button',
          {
            type: 'button',
            onclick: () => {
              state.group = index.symbol;
              onChange({ group: state.group });
              draw();
            },
          },
          ...content,
        )
      : el('span', {}, ...content);
    return { index, node, change };
  });
  strip.append(...stripItems.map(({ node }) => node));

  function drawStrip() {
    stripItems.forEach(({ index, node, change }, i) => {
      const move = state.day?.i[i] ?? null;
      node.className = `heat-index ${bandClass(move)}${index.members?.length ? '' : ' is-static'}`;
      if (index.members?.length) node.setAttribute('aria-pressed', String(index.symbol === state.group));
      change.textContent = move === null ? '—' : `${formatSigned(move)}%`;
    });
  }

  function drawSummary() {
    const members = groupStocks();
    const moves = members.map(moveOf).filter(Boolean);
    const up = moves.filter(([, change]) => change > 0).length;
    const down = moves.filter(([, change]) => change < 0).length;
    const flat = moves.length - up - down;
    const index = indices.findIndex(({ symbol }) => symbol === state.group);
    const change = state.day?.i[index] ?? null;
    const label = indices[index]?.label ?? state.group;
    summary.replaceChildren(
      el('strong', {}, label),
      change === null ? null : el('span', { class: directionClass(change) }, ` ${formatSigned(change)}%`),
      ` on ${formatDate(state.date)}. `,
      el('span', { class: 'is-up' }, `${up} rose`),
      ', ',
      el('span', { class: 'is-down' }, `${down} fell`),
      flat ? `, ${flat} unchanged` : '',
      members.length > moves.length ? `, ${members.length - moves.length} not comparable` : '',
      '.',
    );
  }

  function draw() {
    drawStrip();
    if (!state.day) return;
    drawSummary();
    const showList = state.layout === 'list';
    map.hidden = showList;
    list.hidden = !showList;
    tooltip.hidden = true;
    if (showList) drawList();
    else drawMap();
  }

  async function goTo(iso) {
    state.date = sessionOnOrBefore(iso);
    dateInput.value = state.date;
    previous.disabled = sessionIndex() <= 0;
    next.disabled = sessionIndex() >= tradingDays.length - 1;
    onChange({ date: state.date });
    const mine = ++token;
    board.classList.add('is-loading');
    try {
      const day = await loadDay(state.date);
      if (mine !== token) return;
      board.classList.remove('is-loading');
      if (!day) {
        message.hidden = false;
        message.textContent = `There are no moves to compare on ${formatPlainDate(state.date)}.`;
        return;
      }
      message.hidden = true;
      state.day = day;
      draw();
    } catch {
      if (mine !== token) return;
      board.classList.remove('is-loading');
      message.hidden = false;
      message.textContent = 'Could not load this day’s heatmap. Choose the date again to retry.';
    }
  }

  dateInput.addEventListener('change', () => dateInput.value && dateInput.validity.valid && goTo(dateInput.value));
  previous.addEventListener('click', () => sessionIndex() > 0 && goTo(tradingDays[sessionIndex() - 1]));
  next.addEventListener('click', () => sessionIndex() < tradingDays.length - 1 && goTo(tradingDays[sessionIndex() + 1]));

  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === lastWidth) return;
    lastWidth = entry.contentRect.width;
    if (state.day && state.layout !== 'list') drawMap();
  }).observe(board);

  const legend = el(
    'div',
    { class: 'heat-legend', role: 'list', 'aria-label': 'Colour key' },
    ...HEAT_LEGEND.map(([band, text]) => el('span', { role: 'listitem', class: 'heat-key' }, el('span', { class: `heat-swatch heat-${band < 0 ? 'n' : 'p'}${Math.abs(band)}`, 'aria-hidden': 'true' }), text)),
  );

  host.replaceChildren(
    el(
      'div',
      { class: 'heat-view reveal' },
      el(
        'header',
        { class: 'ipo-hero heat-hero' },
        el(
          'div',
          {},
          el('h1', {}, 'Heatmap'),
          el('p', { class: 'ipo-intro' }, 'Each stock in an NSE index, coloured by how far its close moved from the previous close. Choose an index, a day and a layout. Select a stock to see its pivot.'),
        ),
        el(
          'a',
          { class: 'heat-live', href: NSE_LIVE_HEATMAP, target: '_blank', rel: 'noopener noreferrer', title: 'NSE’s live heatmap, during market hours. Opens in a new tab.' },
          chevron('M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5'),
          'Live heatmap on NSE',
        ),
      ),
      el(
        'section',
        { class: 'heat-card' },
        el(
          'div',
          { class: 'heat-tools' },
          el('div', { class: 'date-control heat-date' }, previous, dateInput, next),
          segmented({
            label: 'Layout',
            options: HEAT_LAYOUTS,
            chosen: state.layout,
            onChoose: (value) => {
              state.layout = value;
              onChange({ layout: value });
              draw();
            },
          }),
        ),
        strip,
        summary,
        message,
        board,
        legend,
        el('p', { class: 'section-note' }, 'Treemap tiles are sized by the latest market cap and grouped by sector. Index members are today’s, from NSE. Moves leave out corporate-action days and stocks that had not traded for over a week. From NSE’s daily reports.'),
      ),
    ),
  );

  goTo(state.date);
}
