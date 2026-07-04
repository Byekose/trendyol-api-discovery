'use strict';

const { pool } = require('./db');
const endpoints = require('./trendyol/endpoints');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function typeLabel(types) {
  return Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}`)
    .join(', ');
}

function fieldRow(f) {
  const indent = f.path.split('.').length - 1;
  const enumHtml = f.enumValues
    ? `<div class="enum">${f.enumValues.map(v => `<code>${esc(v)}</code>`).join(' ')}</div>`
    : '';
  return `<tr>
    <td class="path" style="padding-left:${12 + indent * 16}px"><code>${esc(f.path)}</code></td>
    <td class="type">${esc(typeLabel(f.types))}</td>
    <td class="fill"><div class="bar"><i style="width:${f.fillRate}%"></i></div><span>${f.fillRate}%</span></td>
    <td class="num">${f.distinctCount}</td>
    <td class="sample">${enumHtml}${f.example !== null && !f.enumValues ? `<code>${esc(f.example)}</code>` : ''}</td>
  </tr>`;
}

function changesBlock(changes) {
  if (!changes) return '';
  const parts = [];
  if (changes.newFields?.length)
    parts.push(`<p class="chg new">＋ Yeni field: ${changes.newFields.map(esc).join(', ')}</p>`);
  if (changes.removedFields?.length)
    parts.push(`<p class="chg rem">－ Kaybolan field: ${changes.removedFields.map(esc).join(', ')}</p>`);
  if (changes.newEnumValues?.length)
    parts.push(changes.newEnumValues.map(e =>
      `<p class="chg enumchg">◆ <code>${esc(e.path)}</code> yeni değer: ${e.added.map(esc).join(', ')}</p>`).join(''));
  return `<div class="changes"><h4>Önceki koşuya göre değişiklikler</h4>${parts.join('')}</div>`;
}

function errorsBlock(samples) {
  if (!samples?.length) return '';
  return `<details class="errors"><summary>${samples.length} hata örneği</summary>
    ${samples.map(e => `<div><b>${e.status}</b> ${esc(e.url)}<br><small>${esc(e.error)}</small></div>`).join('')}
  </details>`;
}

async function buildReport() {
  const { rows: runs } = await pool.query(
    `SELECT id, started_at, finished_at, status, stats FROM runs ORDER BY id DESC LIMIT 10`
  );
  if (!runs.length) {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:monospace;padding:40px">
      Henüz veri yok. Önce <code>/run?password=…</code> ile ilk toplamayı başlat.</body>`;
  }
  const latestDone = runs.find(r => r.status === 'done') || runs[0];

  const { rows: findings } = await pool.query(
    `SELECT endpoint_key, findings, changes FROM schema_findings WHERE run_id = $1`,
    [latestDone.id]
  );
  const byKey = new Map(findings.map(f => [f.endpoint_key, f]));

  const sections = endpoints.map(ep => {
    const f = byKey.get(ep.key);
    if (!f) {
      return `<section id="${ep.key}"><h2>${esc(ep.name)}</h2>
        <p class="meta">Bu koşuda veri toplanmadı.</p></section>`;
    }
    const d = f.findings;
    return `<section id="${ep.key}">
      <h2>${esc(ep.name)}</h2>
      <p class="meta">
        <span>${d.totalRecords} kayıt</span> ·
        <span>${d.okResponses}/${d.totalResponses} başarılı response</span> ·
        <a href="${esc(ep.docs)}" target="_blank">doküman</a>
      </p>
      ${changesBlock(f.changes)}
      ${errorsBlock(d.errorSamples)}
      ${d.fields.length ? `<table>
        <thead><tr><th>Field</th><th>Tip</th><th>Doluluk</th><th>Distinct</th><th>Enum / Örnek</th></tr></thead>
        <tbody>${d.fields.map(fieldRow).join('')}</tbody>
      </table>` : '<p class="meta">Kayıt bulunamadı — bu endpoint bu hesapta boş dönüyor olabilir.</p>'}
    </section>`;
  }).join('');

  const toc = endpoints.map(ep => {
    const f = byKey.get(ep.key);
    const n = f ? f.findings.totalRecords : 0;
    return `<a href="#${ep.key}">${esc(ep.name)} <b>${n}</b></a>`;
  }).join('');

  const runHistory = runs.map(r =>
    `<tr><td>#${r.id}</td><td>${new Date(r.started_at).toLocaleString('tr-TR')}</td>
     <td class="st-${r.status}">${r.status}</td>
     <td>${r.stats?.requests ?? '—'} istek / ${r.stats?.errors ?? '—'} hata</td></tr>`
  ).join('');

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pazaryeri API Gözlemevi — Trendyol</title>
<style>
  :root {
    --ink:#1c2430; --paper:#f6f4ee; --line:#d8d3c6; --dim:#6b6f76;
    --accent:#0e7c66; --warn:#b3541e; --card:#fffdf8;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font:14px/1.55 "iA Writer Quattro","Iosevka",ui-monospace,"SF Mono",Consolas,monospace; }
  header { border-bottom:3px double var(--ink); padding:28px 32px 20px; }
  header h1 { margin:0; font-size:22px; letter-spacing:.02em; font-weight:600; }
  header h1 em { font-style:normal; color:var(--accent); }
  header p { margin:6px 0 0; color:var(--dim); }
  .layout { display:grid; grid-template-columns:280px 1fr; gap:0; }
  nav { border-right:1px solid var(--line); padding:20px 16px; position:sticky; top:0;
    align-self:start; max-height:100vh; overflow:auto; }
  nav a { display:flex; justify-content:space-between; gap:8px; color:var(--ink);
    text-decoration:none; padding:6px 8px; border-radius:4px; font-size:13px; }
  nav a b { color:var(--accent); font-weight:600; }
  nav a:hover { background:var(--card); }
  main { padding:24px 32px 80px; min-width:0; }
  section { margin-bottom:44px; }
  h2 { font-size:16px; border-bottom:1px solid var(--line); padding-bottom:6px; margin:0 0 6px; }
  .meta { color:var(--dim); margin:4px 0 12px; font-size:13px; }
  .meta a { color:var(--accent); }
  table { width:100%; border-collapse:collapse; background:var(--card);
    border:1px solid var(--line); font-size:12.5px; }
  th { text-align:left; padding:8px 12px; border-bottom:2px solid var(--ink);
    font-weight:600; background:var(--paper); position:sticky; top:0; }
  td { padding:5px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.path code { color:var(--ink); }
  td.type { color:var(--dim); white-space:nowrap; }
  td.num { text-align:right; color:var(--dim); }
  td.fill { white-space:nowrap; }
  .bar { display:inline-block; width:70px; height:8px; background:var(--line);
    border-radius:4px; overflow:hidden; vertical-align:middle; margin-right:6px; }
  .bar i { display:block; height:100%; background:var(--accent); }
  .enum code, td.sample code { background:var(--paper); border:1px solid var(--line);
    border-radius:3px; padding:0 4px; margin:1px 2px 1px 0; display:inline-block; font-size:11.5px; }
  .changes { background:#eef6f3; border:1px solid var(--accent); border-radius:6px;
    padding:10px 14px; margin:10px 0; }
  .changes h4 { margin:0 0 6px; font-size:13px; color:var(--accent); }
  .chg { margin:2px 0; font-size:13px; }
  .chg.rem { color:var(--warn); }
  details.errors { margin:8px 0; font-size:12.5px; color:var(--warn); }
  details.errors div { margin:6px 0; }
  .runs { margin-top:8px; }
  .runs table { font-size:12.5px; }
  .st-done { color:var(--accent); } .st-failed { color:var(--warn); }
  @media (max-width:800px){ .layout{grid-template-columns:1fr;} nav{position:static;max-height:none;} }
</style></head>
<body>
<header>
  <h1>Pazaryeri API Gözlemevi <em>/ Trendyol</em></h1>
  <p>Run #${latestDone.id} · ${new Date(latestDone.started_at).toLocaleString('tr-TR')} ·
     read-only keşif — gerçek response'lardan çıkarılan şema</p>
</header>
<div class="layout">
<nav>${toc}
  <div class="runs"><h2 style="font-size:13px;margin-top:20px">Koşu geçmişi</h2>
  <table><tbody>${runHistory}</tbody></table></div>
</nav>
<main>${sections}</main>
</div>
</body></html>`;
}

module.exports = { buildReport };
