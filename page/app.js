const meta = JSON.parse(document.querySelector('#market-data').textContent);
const dataUrl = (path) => `data/${path}?v=${meta.builtOn}`;

const market = createMarket(meta, async (symbol) => {
  const response = await fetch(dataUrl(`i/${instrumentFile(symbol)}`));
  if (!response.ok) throw new Error(`Couldn't load ${symbol}`);
  return response.json();
});

const instrumentInput = document.querySelector('#instrument');
const suggestions = document.querySelector('#suggestions');
const dateInput = document.querySelector('#date');
const previousDay = document.querySelector('#previous-day');
const nextDay = document.querySelector('#next-day');
const result = document.querySelector('#result');
const announcer = document.querySelector('#announcer');
const presetsHost = document.querySelector('#presets');
const vixRangeHost = document.querySelector('#vix-range');
const progress = document.querySelector('#progress');
const views = { pivot: document.querySelector('#view-pivot'), heatmap: document.querySelector('#view-heatmap'), ipos: document.querySelector('#view-ipos') };
const menuLinks = [...document.querySelectorAll('.menu a')];
const menuIndicator = document.querySelector('.menu-indicator');

const SEARCH_DELAY_MS = 100;
const PROGRESS_DELAY_MS = 120;
const TWEEN_MS = 420;
const SOURCE_NAMES = { nse: 'Official NSE data', bse: 'Official BSE data', yahoo: 'Yahoo Finance data' };
const SOURCE_CREDITS = { nse: 'NSE daily reports', bse: 'BSE daily reports', yahoo: 'Yahoo Finance' };
// Long enough to cover India's longest market closures, so this only appears if updates have really stopped.
const STALE_AFTER_DAYS = 6;
const CHART_TYPES = [
  { value: 'candles', label: 'Candles' },
  { value: 'line', label: 'Line' },
];
// Trading sessions in each time frame.
const CHART_FRAMES = [
  { value: '1D', label: '1D', sessions: 1 },
  { value: '1W', label: '1W', sessions: 5 },
  { value: '1M', label: '1M', sessions: 21 },
  { value: '3M', label: '3M', sessions: 63 },
  { value: '6M', label: '6M', sessions: 125 },
  { value: '1Y', label: '1Y', sessions: 250 },
  { value: '3Y', label: '3Y', sessions: 750 },
];
const CANDLE_LEGEND = { day: 'Closed', week: 'Week closed', month: 'Month closed' };
const MOVER_GROUPS = [
  { value: 'all', label: 'All stocks' },
  { value: 'nifty500', label: 'NIFTY 500' },
];

let instrument = null; // { symbol, label }
let current = null;
let drawChart = null;
let chosenType = savedChoice('chartType', CHART_TYPES, 'candles');
let chosenFrame = savedChoice('chartFrame', CHART_FRAMES, '3M');
let chosenMoverGroup = savedChoice('moverGroup', MOVER_GROUPS, 'all');
const moversByDate = new Map();
let searchTimer = null;
let options = [];
let activeOption = -1;
let dateTouched = false;
let loadToken = 0;
let progressTimer = null;
let shownPivot = null;
let iposLoaded = false;

const displaySymbol = (symbol) => symbol.replace(/^BSE:/, '');

function savedChoice(key, options, fallback) {
  try {
    const saved = localStorage.getItem(key);
    if (options.some(({ value }) => value === saved)) return saved;
  } catch {
    // Without storage the page starts from the default.
  }
  return fallback;
}

function saveChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice still lasts until the page closes.
  }
}

function setBusy(busy) {
  clearTimeout(progressTimer);
  result.toggleAttribute('aria-busy', busy);
  if (busy) progressTimer = setTimeout(() => (progress.hidden = false), PROGRESS_DELAY_MS);
  else progress.hidden = true;
}

// Counts the pivot from its last value to the new one, always ending on the exact figure.
function tweenPivot(node, from, to, format) {
  node.textContent = format(to);
  if (!prefersMotion() || from === null || from === to) return;
  const start = performance.now();
  const frame = (now) => {
    if (!node.isConnected) return;
    const progressed = Math.min(1, (now - start) / TWEEN_MS);
    const eased = 1 - (1 - progressed) ** 3;
    node.textContent = format(progressed === 1 ? to : from + (to - from) * eased);
    if (progressed < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* Pivot panel */

function renderHero(data) {
  const { instrument: item, session, date, latest } = data;
  const price = (value) => formatNumber(value, item.currency, item.decimals);

  const readingText =
    session.closeVsPivot === 0
      ? `Close of ${price(session.close)} is at the pivot`
      : `Close of ${price(session.close)} is ${price(Math.abs(session.closeVsPivot))} (${formatNumber(Math.abs(session.closeVsPivotPercent), item.currency)}%) ${session.closeVsPivot > 0 ? 'above' : 'below'} the pivot`;

  const priceItem = (label, value, className) =>
    el('div', { class: className }, el('dt', {}, label), el('dd', {}, price(value)));

  const notes = data.laterActions.map((action) =>
    el(
      'p',
      { class: 'hero-note' },
      `These are the prices actually traded that day. A corporate action on ${formatPlainDate(action.date)} (such as a split, bonus or demerger) later changed the share price by a factor of ${formatNumber(action.factor, 'USD', 3)}, so they aren't directly comparable with today's price.`,
    ),
  );

  const metaLine = [item.symbol === item.name ? null : displaySymbol(item.symbol), item.exchange, item.board === 'SME' ? 'SME' : null, item.currency].filter(Boolean).join(' · ');
  const pivotValue = el('p', { class: 'pivot-value' });
  tweenPivot(pivotValue, shownPivot, session.pivot, price);
  shownPivot = session.pivot;

  return el(
    'article',
    { class: 'hero' },
    el(
      'div',
      { class: 'hero-head' },
      el('div', {}, el('h2', {}, item.name), el('p', { class: 'hero-meta' }, metaLine)),
      el('span', { class: 'source-tag' }, SOURCE_NAMES[item.source]),
    ),
    el(
      'div',
      {},
      el('p', { class: 'pivot-label' }, el('strong', {}, 'Current price'), `, last close on ${formatDate(latest.date)}`),
      el('p', { class: 'current-price' }, price(latest.close)),
    ),
    el(
      'div',
      {},
      el('p', { class: 'pivot-label' }, el('strong', {}, 'Pivot point'), ` for ${formatDate(date)}`),
      el('div', { class: 'pivot-line' }, pivotValue),
      el('p', { class: 'pivot-reading' }, readingText),
    ),
    el(
      'dl',
      { class: 'hero-prices' },
      priceItem('Open', session.open),
      priceItem('High', session.high),
      priceItem('Low (not used)', session.low, 'unused'),
      priceItem('Close', session.close),
    ),
    el('p', { class: 'working' }, `(${price(session.open)} + ${price(session.high)} + ${price(session.close)}) ÷ 3 = ${price(session.pivot)}`),
    ...notes,
  );
}

function noSessionText(data) {
  const { instrument: item } = data;
  const date = formatDate(data.date);
  switch (data.reason) {
    case 'ended':
      return {
        title: `No prices yet for ${date}`,
        body: `This page has ${item.name} prices up to ${formatDate(data.previousSession)}.`,
      };
    case 'missing':
      return {
        title: `No prices for ${date}`,
        body: `The market was open, but ${SOURCE_CREDITS[item.source]} has no prices for ${item.name} that day. It usually means the stock didn't trade.`,
      };
    case 'before':
      return {
        title: `No prices for ${date}`,
        body: `This page's ${item.name} prices start on ${formatDate(data.nextSession)}.`,
      };
    default:
      return {
        title: `No trading on ${date}`,
        body: `${item.name} has no prices for this date because the market was closed for a weekend or holiday.`,
      };
  }
}

function renderNoSession(data) {
  const { title, body } = noSessionText(data);
  const buttons = [];
  if (data.previousSession) {
    buttons.push(el('button', { type: 'button', onclick: () => goToDate(data.previousSession) }, `← ${formatDate(data.previousSession)}`));
  }
  if (data.nextSession) {
    buttons.push(el('button', { type: 'button', onclick: () => goToDate(data.nextSession) }, `${formatDate(data.nextSession)} →`));
  }
  return el(
    'article',
    { class: 'hero is-message' },
    el('p', { class: 'message-title' }, title),
    el('p', { class: 'message-body' }, body),
    buttons.length ? el('div', { class: 'actions' }, ...buttons) : null,
  );
}

/* Chart */

function legendKey(kind, color) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('width', '14');
  node.setAttribute('height', '14');
  node.setAttribute('viewBox', '0 0 14 14');
  node.setAttribute('aria-hidden', 'true');
  if (kind === 'up') node.innerHTML = '<rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="var(--up)" stroke-width="1.5"/>';
  else if (kind === 'down') node.innerHTML = '<rect x="3" y="2" width="8" height="10" rx="1" fill="var(--down)"/>';
  else if (kind === 'line') node.innerHTML = `<path d="M0 7h14" stroke="${color}" stroke-width="2"/>`;
  else node.innerHTML = '<path d="M0 7h14" stroke="var(--pivot)" stroke-width="2"/>';
  return node;
}

function renderChartCard(data, animate) {
  const { instrument: item, session } = data;
  const host = el('div', {
    class: 'chart-host',
    tabindex: '0',
    role: 'group',
    'data-refocus': 'chart',
    'aria-label': 'Price chart. Use the left and right arrow keys to read sessions, and Enter to choose one.',
  });

  const legend = el('ul', { class: 'legend' });
  const note = el('p', { class: 'chart-note' });

  let animateNext = animate;
  drawChart = () => {
    const view = data.chartFor(CHART_FRAMES.find(({ value }) => value === chosenFrame).sessions);
    const drawn = renderChart(host, {
      bars: view.bars,
      selectedIndex: view.selectedIndex,
      pivot: session.pivot,
      type: chosenType,
      formatPrice: (value) => formatNumber(value, item.currency, item.decimals),
      formatAxis: (value, decimals) => formatNumber(value, item.currency, decimals),
      formatDate,
      formatShortDate,
      onSelect: goToDate,
      animate: animateNext,
    });
    animateNext = false;
    if (!drawn) return;

    const candleWord = CANDLE_LEGEND[drawn.period];
    legend.replaceChildren(
      ...(chosenType === 'line'
        ? [el('li', {}, legendKey('line', drawn.lineColor), 'Closing price')]
        : [el('li', {}, legendKey('up'), `${candleWord} up`), el('li', {}, legendKey('down'), `${candleWord} down`)]),
      el('li', {}, legendKey('pivot'), `Pivot for ${formatShortDate(data.date)}`),
    );
    note.hidden = !view.rescaledFor.length;
    note.textContent = `A corporate action on ${view.rescaledFor.map(formatPlainDate).join(' and ')} falls in this period. The chart is rescaled to this session's price basis, and the table shows the prices actually traded.`;
  };

  return el(
    'article',
    { class: 'chart-card' },
    el(
      'div',
      { class: 'chart-tools' },
      segmented({
        label: 'Chart type',
        options: CHART_TYPES,
        chosen: chosenType,
        onChoose: (value) => {
          chosenType = value;
          saveChoice('chartType', value);
          drawChart?.();
        },
      }),
      segmented({
        label: 'Time frame',
        options: CHART_FRAMES,
        chosen: chosenFrame,
        onChoose: (value) => {
          chosenFrame = value;
          saveChoice('chartFrame', value);
          drawChart?.();
        },
      }),
    ),
    el('div', { class: 'chart-head' }, el('h3', {}, 'Price around this session'), legend),
    host,
    note,
  );
}

/* Fundamentals */

function renderSessionStats(data) {
  const { instrument: item, session, range } = data;
  const percent = (value) => `${formatSigned(value, item.currency)}%`;
  return el(
    'section',
    {},
    sectionHead(`On ${formatDate(data.date)}`, `Source: ${SOURCE_CREDITS[item.source]}`),
    statGroup(
      null,
      session.change === null
        ? null
        : stat('Change on the day', `${formatSigned(session.change, item.currency, item.decimals)} (${percent(session.changePercent)})`, { className: directionClass(session.change) }),
      range.yearReturn === null ? null : stat('1-year return', percent(range.yearReturn), { className: directionClass(range.yearReturn) }),
      session.volume ? stat('Volume', formatQuantity(session.volume)) : null,
      session.delivery === null ? null : stat('Delivery', `${formatNumber(session.delivery, item.currency)}%`),
      session.pe === null ? null : stat('P/E', formatNumber(session.pe, item.currency)),
      session.pb === null ? null : stat('P/B', formatNumber(session.pb, item.currency)),
      session.dividendYield === null ? null : stat('Dividend yield', `${formatNumber(session.dividendYield, item.currency)}%`),
    ),
  );
}

function renderRange(data) {
  const { instrument: item, range } = data;
  const price = (value) => formatNumber(value, item.currency, item.decimals);
  const title = range.coversYear ? '52-week range' : `Range since ${formatPlainDate(range.from)}`;
  return el(
    'section',
    { class: 'range' },
    sectionHead(title, `Close of ${price(data.session.close)} marked`),
    el(
      'div',
      { class: 'range-track', role: 'img', 'aria-label': `The close sits ${Math.round(range.position * 100)}% of the way from the low of ${price(range.low)} to the high of ${price(range.high)}.` },
      el('span', { class: 'range-fill', style: `width: ${(range.position * 100).toFixed(1)}%` }),
      el('span', { class: 'range-marker', style: `left: ${(range.position * 100).toFixed(1)}%` }),
    ),
    el(
      'div',
      { class: 'range-ends' },
      el('div', {}, el('strong', {}, price(range.low)), el('span', {}, `Low, ${formatPlainDate(range.lowDate)}`)),
      el('div', {}, el('strong', {}, price(range.high)), el('span', {}, `High, ${formatPlainDate(range.highDate)}`)),
    ),
  );
}

function renderProfile(item) {
  const { profile } = item;
  if (!profile) return null;
  const number = (value) => (value === null || value === undefined ? null : formatNumber(value));
  const hasFaceValue = profile.faceValue !== null && profile.faceValue !== undefined;
  return el(
    'section',
    {},
    sectionHead('Company', `Latest, as of ${formatPlainDate(profile.asOf)}. Source: ${SOURCE_CREDITS[item.source]}`),
    statGroup(
      'is-company',
      profile.marketCap ? stat('Market cap', `₹${formatCrore(profile.marketCap)} Cr`) : null,
      stat('P/E', number(profile.pe)),
      stat('Adjusted P/E', number(profile.adjustedPe)),
      profile.shares ? stat('Shares issued', formatQuantity(profile.shares)) : null,
      stat('Face value', hasFaceValue ? `₹${formatNumber(profile.faceValue, 'INR', profile.faceValue % 1 ? 2 : 0)}` : null),
      stat('Sector', profile.industry, { isText: true }),
      profile.listed ? stat('Listed since', formatPlainDate(profile.listed), { isText: true }) : null,
      stat('BSE group', profile.group, { isText: true }),
      stat('BSE scrip code', profile.code, { isText: true }),
      stat('ISIN', profile.isin, { isText: true }),
    ),
  );
}

function renderFinancials(item) {
  const rows = item.financials ?? [];
  if (!rows.length) return null;
  // Borrowing is a bank's raw material, so debt to equity says little about a lender.
  const showDebt = item.profile?.industry !== 'Financial Services';
  const cell = (value, format) => (value === null ? '–' : format(value));
  const ratio = (top, bottom) => (top === null || !bottom ? null : top / bottom);
  return el(
    'section',
    {},
    sectionHead('Annual financials', 'Source: Yahoo Finance. ₹ crore except per-share figures'),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col' }, 'Year to'),
            el('th', { scope: 'col' }, 'Revenue'),
            el('th', { scope: 'col' }, 'Net profit'),
            el('th', { scope: 'col' }, 'EPS (₹)'),
            el('th', { scope: 'col' }, 'Return on equity'),
            showDebt ? el('th', { scope: 'col' }, 'Debt ÷ equity') : null,
          ),
        ),
        el(
          'tbody',
          {},
          ...[...rows].reverse().map((row) =>
            el(
              'tr',
              {},
              el('td', {}, formatYear(row.year)),
              el('td', {}, cell(row.revenue, formatCrore)),
              el('td', {}, cell(row.profit, formatCrore)),
              el('td', {}, cell(row.eps, (value) => formatNumber(value))),
              el('td', {}, cell(ratio(row.profit, row.equity), (value) => `${formatNumber(value * 100, 'INR', 1)}%`)),
              showDebt ? el('td', {}, cell(ratio(row.debt, row.equity), (value) => formatNumber(value))) : null,
            ),
          ),
        ),
      ),
    ),
  );
}

/* Sessions table: the chart's table-view twin, always showing the prices actually traded. */

function renderSessions(data) {
  const { instrument: item, chart } = data;
  const price = (value) => formatNumber(value, item.currency, item.decimals);
  const rows = [...chart.bars].reverse().map((bar) =>
    el(
      'tr',
      { class: bar.date === data.date ? 'is-selected' : null, 'aria-current': bar.date === data.date ? 'date' : null },
      el(
        'td',
        {},
        el('button', { type: 'button', class: 'row-button', 'data-refocus': `session-${bar.date}`, onclick: () => goToDate(bar.date) }, formatPlainDate(bar.date)),
      ),
      el('td', { class: 'pivot-cell' }, price(bar.pivot)),
      el('td', {}, price(bar.open)),
      el('td', {}, price(bar.high)),
      el('td', {}, price(bar.low)),
      el('td', {}, price(bar.close)),
    ),
  );
  const wrap = el(
    'div',
    { class: 'table-scroll is-tall', tabindex: '0', role: 'region', 'aria-label': 'Sessions around the selected date' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Date', 'Pivot', 'Open', 'High', 'Low', 'Close'].map((heading) => el('th', { scope: 'col' }, heading)),
        ),
      ),
      el('tbody', {}, ...rows),
    ),
  );
  return el('section', {}, sectionHead('Pivot by session', 'Choose a date to see its pivot'), wrap);
}

/* Top gainers and losers: the whole market on the chosen date, whichever stock is open above. */

function loadMovers(date) {
  if (!moversByDate.has(date)) {
    const request = fetch(dataUrl(`m/${date}.json`)).then((response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Status ${response.status}`);
      return response.json();
    });
    // A failed download is forgotten, so the next look at this date tries again.
    moversByDate.set(date, request);
    request.catch(() => moversByDate.delete(date));
  }
  return moversByDate.get(date);
}

function openMover(symbol) {
  const entry = market.entry(symbol);
  selectInstrument(symbol, entry.label ?? entry.name);
  window.scrollTo({ top: 0, behavior: prefersMotion() ? 'smooth' : 'auto' });
}

function moverRow([symbol, close, change]) {
  const entry = market.entry(symbol);
  return el(
    'li',
    {},
    el(
      'button',
      { type: 'button', class: 'mover', onclick: () => openMover(symbol) },
      el('span', { class: 'mover-name' }, el('span', {}, entry?.name ?? symbol), el('small', {}, `${displaySymbol(symbol)} · ${entry?.exchange ?? ''}`)),
      el('span', { class: 'mover-close' }, formatNumber(close)),
      el('span', { class: `mover-change ${directionClass(change) ?? ''}` }, `${formatSigned(change)}%`),
    ),
  );
}

function moverList(title, rows) {
  return el(
    'div',
    { class: 'mover-column' },
    el('h4', {}, title),
    rows.length ? el('ol', { class: 'mover-list' }, ...rows.map(moverRow)) : el('p', { class: 'section-note' }, 'None on this day.'),
  );
}

function renderMovers(date) {
  const note = el('p', { class: 'section-note' }, formatPlainDate(date));
  const body = el('div', { class: 'movers-body is-loading' });
  let day = null;

  const draw = () => {
    if (!day) return;
    const group = day[chosenMoverGroup];
    note.textContent = `${formatPlainDate(date)}, from ${formatNumber(group.count, 'INR', 0)} stocks that traded`;
    body.classList.remove('is-loading');
    body.replaceChildren(
      el('div', { class: 'mover-columns' }, moverList('Top gainers', group.gainers), moverList('Top losers', group.losers)),
      el('p', { class: 'section-note mover-note' }, 'Closing price against the previous close. Leaves out corporate-action days, moves above 40%, and stocks that had not traded for over a week.'),
    );
  };

  const message = (text) => {
    body.classList.remove('is-loading');
    body.replaceChildren(el('p', { class: 'mover-message' }, text));
  };

  // A date past this page's calendar is newer than the page, not a holiday.
  const closed = date <= market.maxDate && !market.isOpen('NSE', date);
  if (closed) message(`The Indian market was closed on ${formatPlainDate(date)}, so there are no gainers or losers.`);
  else {
    loadMovers(date)
      .then((loaded) => {
        if (!loaded) return message(`The exchanges' reports for ${formatPlainDate(date)} are not in yet.`);
        day = loaded;
        draw();
      })
      .catch(() => message('Could not load the gainers and losers. Choose the date again to retry.'));
  }

  return el(
    'section',
    { class: 'movers' },
    el(
      'div',
      { class: 'movers-head' },
      el('div', {}, el('h3', { class: 'section-title' }, 'Top gainers and losers'), note),
      segmented({
        label: 'Stocks to compare',
        options: MOVER_GROUPS,
        chosen: chosenMoverGroup,
        onChoose: (value) => {
          chosenMoverGroup = value;
          saveChoice('moverGroup', value);
          draw();
        },
      }),
    ),
    body,
  );
}

/* News and exchange notices */

function renderUpcoming(item) {
  if (!item.upcoming?.length) return null;
  return el(
    'section',
    {},
    sectionHead('Coming up', 'Source: NSE'),
    el(
      'ul',
      { class: 'feed' },
      ...item.upcoming.map((event) =>
        el('li', {}, el('p', { class: 'feed-title' }, `${event.kind}, ${formatPlainDate(event.date)}`), el('p', { class: 'feed-meta' }, event.text)),
      ),
    ),
  );
}

function renderFilings(item) {
  if (!item.filings?.length) return null;
  return el(
    'section',
    {},
    sectionHead('Filings with NSE', 'Last 8 trading days'),
    el(
      'ul',
      { class: 'feed' },
      ...item.filings.map((filing) =>
        el(
          'li',
          {},
          el('p', { class: 'feed-title' }, filing.category),
          el('p', { class: 'feed-meta' }, filing.text ? `${formatPlainDate(filing.date)}. ${filing.text}` : formatPlainDate(filing.date)),
        ),
      ),
    ),
  );
}

function renderNews(item) {
  const links = el(
    'p',
    { class: 'links' },
    item.newsUrl ? externalLink(item.newsUrl, 'Latest news ↗') : null,
    item.officialUrl ? externalLink(item.officialUrl, 'Official page ↗') : null,
  );
  const collected = item.news.length || item.type === 'Index' || item.financials?.length;
  return el(
    'section',
    {},
    sectionHead('News', collected ? `Collected on ${formatPlainDate(market.builtOn)}` : null),
    item.news.length
      ? el(
          'ul',
          { class: 'feed' },
          ...item.news.map((story) =>
            el(
              'li',
              {},
              el('p', { class: 'feed-title' }, externalLink(story.url, story.title)),
              el('p', { class: 'feed-meta' }, `${story.publisher}, ${formatPlainDate(story.date)}`),
            ),
          ),
        )
      : el('p', { class: 'empty' }, collected ? 'No recent headlines from the publishers this page trusts.' : `Headlines are collected for ${market.newsCoverage} companies and major indices. Use the link below to see news for this company.`),
    links,
  );
}

/* Page */

function renderPrompt(message) {
  drawChart = null;
  shownPivot = null;
  result.replaceChildren(el('article', { class: 'hero is-message' }, el('p', { class: 'message-body' }, message)));
}

function renderLoadError() {
  drawChart = null;
  result.replaceChildren(
    el(
      'article',
      { class: 'hero is-message' },
      el('p', { class: 'message-title' }, `Couldn’t load ${instrument.label}`),
      el('p', { class: 'message-body' }, 'Check your internet connection and try again.'),
      el('div', { class: 'actions' }, el('button', { type: 'button', onclick: () => showCurrent({ fresh: true }) }, 'Try again')),
    ),
  );
}

function render({ fresh = false } = {}) {
  if (!dateInput.value || !dateInput.validity.valid) {
    previousDay.disabled = true;
    nextDay.disabled = true;
    return renderPrompt(`Choose a date between ${formatPlainDate(dateInput.min)} and ${formatPlainDate(dateInput.max)}.`);
  }

  const refocus = document.activeElement?.dataset?.refocus;
  const data = market.lookup(instrument.symbol, dateInput.value);
  current = data;
  previousDay.disabled = !data.previousSession;
  nextDay.disabled = !data.nextSession;

  const { instrument: item, session } = data;
  const sections = [];
  drawChart = null;

  if (session) {
    sections.push(el('div', { class: 'primary' }, renderHero(data), renderChartCard(data, fresh)));
    const profile = renderProfile(item);
    sections.push(
      el(
        'div',
        { class: 'fundamentals' },
        renderSessionStats(data),
        el('div', { class: profile ? 'about-row' : null }, renderRange(data), profile),
        renderFinancials(item),
      ),
    );
  } else {
    shownPivot = null;
    sections.push(el('div', { class: 'primary' }, renderNoSession(data)));
    const about = [renderProfile(item), renderFinancials(item)].filter(Boolean);
    if (about.length) sections.push(el('div', { class: 'fundamentals' }, ...about));
  }

  sections.push(
    el(
      'div',
      { class: 'secondary' },
      session ? renderSessions(data) : null,
      renderMovers(dateInput.value),
      el('div', { class: 'news-column' }, renderUpcoming(item), renderNews(item), renderFilings(item)),
    ),
  );

  if (fresh) sections.forEach((section, index) => {
    section.classList.add('reveal');
    section.style.setProperty('--i', index);
  });
  result.replaceChildren(...sections);
  stampCards(item);
  drawChart?.();

  const selectedRow = result.querySelector('tr.is-selected');
  const scroller = selectedRow?.closest('.is-tall');
  if (scroller) scroller.scrollTop = Math.max(0, selectedRow.offsetTop - scroller.clientHeight / 2);

  if (refocus) result.querySelector(`[data-refocus="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });

  announcer.textContent = session
    ? `${item.name}: pivot ${formatNumber(session.pivot, item.currency, item.decimals)} for ${formatDate(data.date)}.`
    : noSessionText(data).title;
}

// Each card says when its own data was last collected. Prices come with the stock or index itself,
// gainers and losers with the whole update, and headlines from whenever they were last read.
function stampCards(item) {
  const stamp = (node, when) => {
    const badge = node && updatedBadge(when);
    if (badge) node.append(badge);
  };
  const prices = item.updatedAt;
  stamp(result.querySelector('.hero'), prices);
  stamp(result.querySelector('.chart-card'), prices);
  stamp(result.querySelector('.fundamentals'), prices);
  stamp(result.querySelector('.secondary > section:not(.movers)'), prices);
  stamp(result.querySelector('.movers'), market.updatedAt);
  stamp(result.querySelector('.news-column'), item.newsAt ?? prices);
}

async function showCurrent({ fresh = false } = {}) {
  const token = ++loadToken;
  const { symbol } = instrument;
  if (!market.isLoaded(symbol)) {
    setBusy(true);
    try {
      await market.load(symbol);
    } catch {
      if (token === loadToken) {
        setBusy(false);
        renderLoadError();
      }
      return;
    }
    if (token !== loadToken) return;
    setBusy(false);
  }
  const item = await market.load(symbol);
  const latest = isoDay(item.days.at(-1));
  // A copy of the page saved before an update can meet newer data files, so their latest date has to stay choosable.
  if (latest > dateInput.max) dateInput.max = latest;
  // Until someone picks a date, each stock opens on its own latest session, as thinly traded ones may not have traded today.
  if (!dateTouched) dateInput.value = latest;
  transition(() => render({ fresh }));
}

function goToDate(iso) {
  dateTouched = true;
  dateInput.value = iso;
  showCurrent();
}

function selectInstrument(symbol, label) {
  instrument = { symbol, label };
  instrumentInput.value = label;
  shownPivot = null;
  for (const button of presetsHost.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.symbol === symbol));
  }
  return showCurrent({ fresh: true });
}

/* Search box */

function closeSuggestions() {
  clearTimeout(searchTimer);
  suggestions.hidden = true;
  options = [];
  activeOption = -1;
  instrumentInput.setAttribute('aria-expanded', 'false');
  instrumentInput.removeAttribute('aria-activedescendant');
}

function showSuggestionsMessage(message) {
  options = [];
  activeOption = -1;
  suggestions.replaceChildren(el('li', { class: 'suggestions-message' }, message));
  suggestions.hidden = false;
  instrumentInput.setAttribute('aria-expanded', 'true');
  instrumentInput.removeAttribute('aria-activedescendant');
}

function chooseOption(option) {
  closeSuggestions();
  selectInstrument(option.symbol, option.label ?? option.name);
  instrumentInput.blur();
}

function showOptions(results) {
  if (!results.length) return showSuggestionsMessage(`No matches. This page covers ${market.coverage}.`);

  options = results;
  activeOption = -1;
  suggestions.replaceChildren(
    ...results.map((option, index) =>
      el(
        'li',
        {
          id: `option-${index}`,
          role: 'option',
          'aria-selected': 'false',
          // Keeps focus in the input so its blur handler doesn't close the list before the click lands.
          onmousedown: (event) => event.preventDefault(),
          onclick: () => chooseOption(option),
        },
        el('span', { class: 'option-name' }, option.name),
        el('span', { class: 'option-meta' }, [option.symbol === option.name ? null : displaySymbol(option.symbol), option.exchange, option.type].filter(Boolean).join(' · ')),
      ),
    ),
  );
  suggestions.hidden = false;
  instrumentInput.setAttribute('aria-expanded', 'true');
  instrumentInput.removeAttribute('aria-activedescendant');
}

function highlightOption(index) {
  activeOption = index;
  [...suggestions.children].forEach((item, i) => {
    item.setAttribute('aria-selected', String(i === index));
    if (i === index) item.scrollIntoView({ block: 'nearest' });
  });
  instrumentInput.setAttribute('aria-activedescendant', `option-${index}`);
}

instrumentInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = instrumentInput.value.trim();
  if (!query) return closeSuggestions();
  searchTimer = setTimeout(() => showOptions(market.search(query)), SEARCH_DELAY_MS);
});

instrumentInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSuggestions();
  } else if (event.key === 'ArrowDown' && options.length) {
    event.preventDefault();
    highlightOption((activeOption + 1) % options.length);
  } else if (event.key === 'ArrowUp' && options.length) {
    event.preventDefault();
    highlightOption((activeOption - 1 + options.length) % options.length);
  } else if (event.key === 'Enter' && options.length) {
    event.preventDefault();
    chooseOption(options[Math.max(activeOption, 0)]);
  }
});

instrumentInput.addEventListener('focus', () => instrumentInput.select());

// Leaving the box without choosing puts back the instrument the page is showing.
instrumentInput.addEventListener('blur', () => {
  closeSuggestions();
  if (instrument) instrumentInput.value = instrument.label;
});

/* Views */

function moveMenuIndicator() {
  const active = menuLinks.find((link) => link.getAttribute('aria-current') === 'page');
  if (!active) return;
  menuIndicator.style.width = `${active.offsetWidth}px`;
  menuIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

async function loadIpos() {
  if (iposLoaded) return;
  iposLoaded = true;
  const host = views.ipos;
  setBusy(true);
  try {
    const response = await fetch(dataUrl('ipos.json'));
    if (!response.ok) throw new Error('IPO data unavailable');
    const data = await response.json();
    transition(() => {
      renderIpoView(host, data, {
        canOpen: (symbol) => market.has(symbol),
        open: (symbol) => {
          const entry = market.entry(symbol);
          location.hash = '#pivot';
          selectInstrument(symbol, entry.label ?? entry.name);
        },
      });
      const badge = updatedBadge(data.updatedAt ?? data.asOf);
      if (badge) host.querySelector('.ipo-hero')?.append(badge);
    });
  } catch {
    iposLoaded = false;
    host.replaceChildren(
      el(
        'article',
        { class: 'hero is-message' },
        el('p', { class: 'message-title' }, 'Couldn’t load IPO data'),
        el('p', { class: 'message-body' }, 'Check your internet connection and try again.'),
        el('div', { class: 'actions' }, el('button', { type: 'button', onclick: loadIpos }, 'Try again')),
      ),
    );
  } finally {
    setBusy(false);
  }
}

let heatmapLoaded = false;
const heatDays = new Map();

function loadHeatDay(date) {
  if (!heatDays.has(date)) {
    const request = fetch(dataUrl(`h/${date}.json`)).then((response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Status ${response.status}`);
      return response.json();
    });
    heatDays.set(date, request);
    request.catch(() => heatDays.delete(date));
  }
  return heatDays.get(date);
}

function readSaved(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function loadHeatmap() {
  if (heatmapLoaded) return;
  heatmapLoaded = true;
  const host = views.heatmap;
  setBusy(true);
  try {
    const response = await fetch(dataUrl('h/info.json'));
    if (!response.ok) throw new Error('Heatmap data unavailable');
    const info = await response.json();
    const tradingDays = market.tradingDays('NSE');
    renderHeatmapView(host, {
      info,
      loadDay: loadHeatDay,
      tradingDays,
      initialDate: tradingDays.at(-1),
      updatedAt: market.updatedAt,
      savedGroup: readSaved('heatGroup') ?? 'NIFTY 50',
      savedLayout: readSaved('heatLayout'),
      onChange: ({ group, layout }) => {
        if (group) saveChoice('heatGroup', group);
        if (layout) saveChoice('heatLayout', layout);
      },
      open: (symbol, date) => {
        const entry = market.entry(symbol);
        if (!entry) return;
        location.hash = '#pivot';
        dateTouched = true;
        dateInput.value = date;
        selectInstrument(symbol, entry.label ?? entry.name);
      },
    });
  } catch {
    heatmapLoaded = false;
    host.replaceChildren(
      el(
        'article',
        { class: 'hero is-message' },
        el('p', { class: 'message-title' }, 'Couldn’t load the heatmap'),
        el('p', { class: 'message-body' }, 'Check your internet connection and try again.'),
        el('div', { class: 'actions' }, el('button', { type: 'button', onclick: loadHeatmap }, 'Try again')),
      ),
    );
  } finally {
    setBusy(false);
  }
}

const VIEW_TITLES = { ipos: 'IPOs · Market Pivots and IPOs', heatmap: 'Heatmap · Market Pivots and IPOs' };

function showView(name) {
  transition(() => {
    for (const [viewName, node] of Object.entries(views)) node.hidden = viewName !== name;
    for (const link of menuLinks) {
      if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    moveMenuIndicator();
    document.title = VIEW_TITLES[name] ?? 'Market Pivots and IPOs';
    window.scrollTo({ top: 0 });
  });
  if (name === 'ipos') loadIpos();
  else if (name === 'heatmap') loadHeatmap();
  else drawChart?.();
}

const viewFromHash = () => ({ '#ipos': 'ipos', '#heatmap': 'heatmap' })[location.hash] ?? 'pivot';
window.addEventListener('hashchange', () => showView(viewFromHash()));
window.addEventListener('resize', moveMenuIndicator);

/* Theme */

const themeButton = document.querySelector('#theme-toggle');
themeButton.addEventListener('click', () => {
  const isDark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  transition(() => {
    document.documentElement.dataset.theme = next;
  });
  try {
    localStorage.setItem('theme', next);
  } catch {
    // Without storage the choice still lasts until the page closes.
  }
  drawChart?.();
});

/* Wiring */

function renderPresets() {
  presetsHost.replaceChildren(
    ...market.strip.map(({ symbol, label, close, changePercent, currency }) =>
      el(
        'button',
        { type: 'button', 'data-symbol': symbol, 'data-label': label, 'aria-pressed': 'false', onclick: () => selectInstrument(symbol, label) },
        el('span', { class: 'preset-name' }, label),
        el('span', { class: 'preset-close' }, formatNumber(close, currency)),
        changePercent === null ? null : el('span', { class: `preset-change ${directionClass(changePercent) ?? ''}` }, `${formatSigned(changePercent)}%`),
      ),
    ),
  );
}

/* NIFTY 50's expected range from India VIX. VIX is the yearly volatility the options market expects, as a
   percentage, so dividing by √365 gives one day's expected move and by √12 one month's. NIFTY stays inside
   each range about two times in three (one standard deviation). */

const VIX_HORIZONS = [
  { label: 'Next day', divisor: Math.sqrt(365), root: '√365' },
  { label: 'Next month', divisor: Math.sqrt(12), root: '√12' },
];

function renderVixRange() {
  const vix = market.strip.find(({ symbol }) => symbol === 'INDIA VIX');
  const nifty = market.strip.find(({ symbol }) => symbol === 'NIFTY 50');
  if (!vix?.close || !nifty?.close) return;
  const asOf = market.tradingDays('NSE').at(-1);
  const points = (value) => formatNumber(value, 'INR', 0);

  const horizon = ({ label, divisor, root }) => {
    const percent = vix.close / divisor;
    const move = (nifty.close * percent) / 100;
    return el(
      'div',
      { class: 'vix-band' },
      el('h3', {}, label),
      el('p', { class: 'vix-move' }, `±${formatNumber(percent)}%`, el('span', {}, ` ±${points(move)} points`)),
      el('p', { class: 'vix-span' }, `${points(nifty.close - move)} to ${points(nifty.close + move)}`),
      el('p', { class: 'vix-formula' }, `VIX ÷ ${root} = ${formatNumber(vix.close)} ÷ ${formatNumber(divisor)}`),
    );
  };

  vixRangeHost.replaceChildren(
    el(
      'div',
      { class: 'vix-head' },
      el('h2', { id: 'vix-range-title' }, 'NIFTY 50 expected range'),
      el(
        'p',
        {},
        'From India VIX ',
        el('button', { type: 'button', class: 'vix-link', onclick: () => selectInstrument(vix.symbol, vix.label) }, formatNumber(vix.close)),
        ` and NIFTY 50 at ${formatNumber(nifty.close)}, at the close on ${formatPlainDate(asOf)}.`,
      ),
    ),
    ...VIX_HORIZONS.map(horizon),
    el('p', { class: 'vix-note' }, 'VIX is the yearly move the options market expects, so NIFTY usually stays inside each range, about two times in three. An estimate, not a forecast.'),
    updatedBadge(market.updatedAt),
  );
  vixRangeHost.hidden = false;
}

document.querySelector('#controls').addEventListener('submit', (event) => event.preventDefault());
dateInput.addEventListener('change', () => {
  dateTouched = true;
  showCurrent();
});
previousDay.addEventListener('click', () => current?.previousSession && goToDate(current.previousSession));
nextDay.addEventListener('click', () => current?.nextSession && goToDate(current.nextSession));

let lastWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width !== lastWidth) {
    lastWidth = entry.contentRect.width;
    drawChart?.();
    moveMenuIndicator();
  }
}).observe(document.querySelector('main'));

instrumentInput.placeholder = `Search ${market.coverage}`;
dateInput.min = market.minDate;
dateInput.max = market.maxDate;

const status = document.querySelector('#data-status');
const dataAgeDays = (Date.now() - Date.parse(market.maxDate)) / 86_400_000;
const isStale = dataAgeDays > STALE_AFTER_DAYS;
status.replaceChildren(
  `Prices to ${formatPlainDate(market.maxDate)}`,
  isStale ? ' · Updates may have stopped' : el('span', { class: 'status-more' }, ' · Updates every evening'),
);
status.classList.toggle('is-stale', isStale);

renderPresets();
renderVixRange();
dateInput.value = market.maxDate;
const firstPreset = market.strip[0];
selectInstrument(firstPreset.symbol, firstPreset.label);
showView(viewFromHash());
