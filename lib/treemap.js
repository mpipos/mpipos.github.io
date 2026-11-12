// Heatmap geometry and colour bands, shared by the page and its tests.

// The colour band for a day's move: -4 (fell 3% or more) to 4 (rose 3% or more), 0 for no change.
export function heatBand(percent) {
  if (percent === null || percent === undefined || percent === 0) return 0;
  const band = Math.min(4, Math.ceil(Math.abs(percent)));
  return percent > 0 ? band : -band;
}

const worstRatio = (areas, side) => {
  const sum = areas.reduce((total, area) => total + area, 0);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  return Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
};

// Places one row of rectangles along the shorter side, and returns the space left over.
function placeRow(row, space, out) {
  const sum = row.reduce((total, { area }) => total + area, 0);
  if (space.width >= space.height) {
    const width = sum / space.height;
    let y = space.y;
    for (const { key, area } of row) {
      const height = area / width;
      out.push({ key, x: space.x, y, width, height });
      y += height;
    }
    return { x: space.x + width, y: space.y, width: space.width - width, height: space.height };
  }
  const height = sum / space.width;
  let x = space.x;
  for (const { key, area } of row) {
    const width = area / height;
    out.push({ key, x, y: space.y, width, height });
    x += width;
  }
  return { x: space.x, y: space.y + height, width: space.width, height: space.height - height };
}

// Lays out rectangles whose areas follow their values, kept as close to square as possible
// (the squarified treemap of Bruls, Huizing and van Wijk). Items are { key, value }.
export function squarify(items, x, y, width, height) {
  const kept = items.filter(({ value }) => value > 0).sort((a, b) => b.value - a.value || String(a.key).localeCompare(String(b.key)));
  const total = kept.reduce((sum, { value }) => sum + value, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const queue = kept.map(({ key, value }) => ({ key, area: value * scale }));

  const out = [];
  let space = { x, y, width, height };
  let row = [];
  for (let i = 0; i < queue.length; ) {
    const side = Math.min(space.width, space.height);
    const grown = [...row.map(({ area }) => area), queue[i].area];
    if (!row.length || worstRatio(grown, side) <= worstRatio(row.map(({ area }) => area), side)) {
      row.push(queue[i]);
      i++;
    } else {
      space = placeRow(row, space, out);
      row = [];
    }
  }
  if (row.length) placeRow(row, space, out);
  return out;
}

// Equal tiles in reading order, as NSE's own heatmap shows them.
export function tileGrid(keys, width, { minWidth = 96, height = 58 } = {}) {
  const columns = Math.max(3, Math.floor(width / minWidth));
  const tileWidth = width / columns;
  return {
    height: Math.ceil(keys.length / columns) * height,
    rects: keys.map((key, i) => ({ key, x: (i % columns) * tileWidth, y: Math.floor(i / columns) * height, width: tileWidth, height })),
  };
}
