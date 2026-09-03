// Self-contained HTML usage report, served by the daemon. Unlike the extensions'
// report (which inlines a history snapshot), this fetches /usage/<provider>/history
// live — exactly the one-line change the extensions' template anticipates.
// Dependency-free canvas chart; no external assets (CSP-safe).
//
// windows: [{id, label, color}] from the provider config — determines table columns
// and chart colors dynamically. No hardcoded window names.

export function reportHtml(provider, windows) {
  const p = JSON.stringify(provider);
  const w = JSON.stringify(windows);

  const th = windows.map((win) =>
    `<th class="w-${win.id}" style="color:${win.color}">${win.label} %</th>`
  ).join('');
  const css = windows.map((win) =>
    `.w-${win.id} { color: ${win.color}; }`
  ).join('\n  ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage report — ${provider}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 900px; }
  h1 { font-size: 1.2rem; }
  canvas { width: 100%; height: 280px; border: 1px solid #8884; border-radius: 6px; }
  table { border-collapse: collapse; margin-top: 1rem; width: 100%; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #8883; font-variant-numeric: tabular-nums; }
  .muted { opacity: .6; }
  ${css}
</style>
</head>
<body>
<h1>Usage report — <span style="text-transform:capitalize">${provider}</span></h1>
<p class="muted" id="meta">loading…</p>
<canvas id="c" width="880" height="280"></canvas>
<table id="t"><thead><tr><th>Time</th>${th}</tr></thead><tbody></tbody></table>
<script>
const provider = ${p};
const windows = ${w};
async function main() {
  const rows = await fetch('/usage/' + provider + '/history').then(r => r.json());
  const meta = document.getElementById('meta');
  if (!rows.length) { meta.textContent = 'No history yet.'; return; }
  meta.textContent = rows.length + ' samples, ' +
    new Date(rows[0].t).toLocaleString() + ' ' + new Date(rows.at(-1).t).toLocaleString();
  draw(rows);
  const tb = document.querySelector('#t tbody');
  for (const r of rows.slice(-50).reverse()) {
    let cells = '<td>' + new Date(r.t).toLocaleString() + '</td>';
    for (const w of windows) cells += '<td>' + (r[w.id] ?? '') + '</td>';
    const tr = document.createElement('tr');
    tr.innerHTML = cells;
    tb.appendChild(tr);
  }
}
function draw(rows) {
  const c = document.getElementById('c'), x = c.getContext('2d');
  const W = c.width, H = c.height, pad = 30;
  const t0 = rows[0].t, t1 = rows.at(-1).t || t0 + 1;
  const sx = t => pad + (W - 2*pad) * (t1 === t0 ? 0 : (t - t0) / (t1 - t0));
  const sy = v => H - pad - (H - 2*pad) * (v / 100);
  x.clearRect(0,0,W,H);
  x.strokeStyle = '#8886'; x.beginPath(); x.moveTo(pad,H-pad); x.lineTo(W-pad,H-pad); x.stroke();
  for (const w of windows) {
    x.strokeStyle = w.color; x.lineWidth = 2; x.beginPath();
    let started = false;
    for (const r of rows) {
      if (typeof r[w.id] !== 'number') continue;
      const px = sx(r.t), py = sy(r[w.id]);
      started ? x.lineTo(px, py) : x.moveTo(px, py); started = true;
    }
    x.stroke();
  }
}
main().catch(e => document.getElementById('meta').textContent = 'Error: ' + e.message);
</script>
</body>
</html>`;
}
