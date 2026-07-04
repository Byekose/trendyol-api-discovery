'use strict';

/**
 * Komisyon analizi — en son tamamlanmış run'ın ham verisinden hesaplanır.
 *
 * 1. commissionRate dağılımı (oran → satır sayısı, toplam komisyon)
 * 2. Barkod/SKU bazında ortalama oran + toplam komisyon
 * 3. Aynı barkodda oranın zaman içinde değişimi
 * 4. lines[].commission oran mı tutar mı? (sipariş ↔ settlement eşleştirme)
 * 5. transactionType bazında satır sayısı + toplam tutar
 */

const { pool } = require('./db');

const fmtTL = (n) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString('tr-TR') : '—';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function latestDoneRun() {
  const { rows } = await pool.query(`SELECT id FROM runs WHERE status='done' ORDER BY id DESC LIMIT 1`);
  return rows[0]?.id || null;
}

async function loadRecords(runId, endpointKeys) {
  const { rows } = await pool.query(
    `SELECT body FROM raw_responses
     WHERE run_id = $1 AND endpoint_key = ANY($2) AND http_status = 200 AND body IS NOT NULL`,
    [runId, endpointKeys]
  );
  const records = [];
  for (const { body } of rows) {
    const content = Array.isArray(body?.content) ? body.content
      : Array.isArray(body) ? body : [];
    records.push(...content);
  }
  return records;
}

function dedupeById(records) {
  const seen = new Set();
  return records.filter(r => {
    const id = r.id ?? JSON.stringify(r).slice(0, 120);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function buildAnalysis() {
  const runId = await latestDoneRun();
  if (!runId) return '<body style="font-family:monospace;padding:40px">Tamamlanmış run yok.</body>';

  const settlements = dedupeById(await loadRecords(runId, ['settlements']));
  const orderPackages = dedupeById(await loadRecords(runId, ['orders', 'orders_by_status']));

  // Barkod → merchantSku haritası (settlements'ta SKU yok, siparişten eşlenir)
  const barcodeToSku = new Map();
  // orderNumber|barcode → sipariş satırı (analiz 4 için)
  const orderLineIndex = new Map();
  for (const pkg of orderPackages) {
    for (const line of pkg.lines || []) {
      if (line.barcode) barcodeToSku.set(String(line.barcode), line.merchantSku || line.stockCode || '');
      const key = `${pkg.orderNumber}|${line.barcode}`;
      if (!orderLineIndex.has(key)) orderLineIndex.set(key, { pkg, line });
    }
  }

  const sales = settlements.filter(s => s.transactionType === 'Satış');

  // ── 1. commissionRate dağılımı ─────────────────────────────────────
  const rateDist = new Map();
  for (const s of sales) {
    const r = s.commissionRate;
    if (r === null || r === undefined) continue;
    const cur = rateDist.get(r) || { count: 0, totalCommission: 0 };
    cur.count++;
    cur.totalCommission += s.commissionAmount || 0;
    rateDist.set(r, cur);
  }

  // ── 2 & 3. Barkod bazında oran + zaman içinde değişim ──────────────
  const byBarcode = new Map();
  for (const s of sales) {
    const b = String(s.barcode || '?');
    let cur = byBarcode.get(b);
    if (!cur) { cur = { rows: 0, totalCommission: 0, rateSum: 0, ratePoints: [] }; byBarcode.set(b, cur); }
    cur.rows++;
    cur.totalCommission += s.commissionAmount || 0;
    cur.rateSum += s.commissionRate || 0;
    cur.ratePoints.push({ rate: s.commissionRate, date: s.transactionDate });
  }
  const skuTable = [...byBarcode.entries()].map(([barcode, v]) => {
    const rates = new Map();
    for (const p of v.ratePoints) {
      if (p.rate === null || p.rate === undefined) continue;
      let r = rates.get(p.rate);
      if (!r) { r = { first: p.date, last: p.date, n: 0 }; rates.set(p.rate, r); }
      r.n++;
      if (p.date < r.first) r.first = p.date;
      if (p.date > r.last) r.last = p.date;
    }
    const timeline = [...rates.entries()]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([rate, r]) => `%${rate} (${fmtDate(r.first)}–${fmtDate(r.last)}, ${r.n} satır)`);
    return {
      barcode,
      sku: barcodeToSku.get(barcode) || '—',
      rows: v.rows,
      avgRate: v.rows ? (v.rateSum / v.rows) : 0,
      totalCommission: v.totalCommission,
      rateChanged: rates.size > 1,
      timeline
    };
  }).sort((a, b) => b.totalCommission - a.totalCommission);

  // ── 4. lines[].commission: oran mı tutar mı? ───────────────────────
  const TOL_AMOUNT = 0.05; // TL toleransı (kuruş yuvarlaması)
  const TOL_RATE = 0.011;
  const verdict = { amount: 0, amountTimesQty: 0, rate: 0, neither: 0, noOrderMatch: 0, nullLineCommission: 0 };
  const examples = [];
  for (const s of sales) {
    const key = `${s.orderNumber}|${s.barcode}`;
    const hit = orderLineIndex.get(key);
    if (!hit) { verdict.noOrderMatch++; continue; }
    const lc = hit.line.commission;
    if (lc === null || lc === undefined) { verdict.nullLineCommission++; continue; }
    const qty = hit.line.quantity || 1;
    let v;
    if (Math.abs(lc - (s.commissionAmount || 0)) <= TOL_AMOUNT) v = 'amount';
    else if (Math.abs(lc - (s.commissionAmount || 0) * qty) <= TOL_AMOUNT * qty) v = 'amountTimesQty';
    else if (Math.abs(lc - (s.commissionRate || 0)) <= TOL_RATE) v = 'rate';
    else v = 'neither';
    verdict[v]++;
    if (examples.length < 12) {
      examples.push({
        orderNumber: s.orderNumber, barcode: s.barcode, qty,
        lineCommission: lc, settlementAmount: s.commissionAmount,
        settlementRate: s.commissionRate, verdict: v
      });
    }
  }

  // ── 5. transactionType özeti (tüm settlement satırları) ────────────
  const typeSummary = new Map();
  for (const s of settlements) {
    const t = s.transactionType || '?';
    let cur = typeSummary.get(t);
    if (!cur) { cur = { count: 0, credit: 0, debt: 0 }; typeSummary.set(t, cur); }
    cur.count++;
    cur.credit += s.credit || 0;
    cur.debt += s.debt || 0;
  }

  // ── HTML ────────────────────────────────────────────────────────────
  const rateRows = [...rateDist.entries()].sort((a, b) => a[0] - b[0]).map(([rate, v]) =>
    `<tr><td>%${rate}</td><td class="num">${v.count}</td><td class="num">${fmtTL(v.totalCommission)} ₺</td></tr>`).join('');

  const skuRows = skuTable.map(r =>
    `<tr class="${r.rateChanged ? 'changed' : ''}">
      <td><code>${esc(r.barcode)}</code></td><td><code>${esc(r.sku)}</code></td>
      <td class="num">${r.rows}</td><td class="num">%${r.avgRate.toFixed(2)}</td>
      <td class="num">${fmtTL(r.totalCommission)} ₺</td>
      <td>${r.rateChanged ? '⚠ ' : ''}${r.timeline.join(' → ')}</td>
    </tr>`).join('');

  const changedCount = skuTable.filter(r => r.rateChanged).length;

  const matched = verdict.amount + verdict.amountTimesQty + verdict.rate + verdict.neither;
  const pct = (n) => matched ? `%${Math.round(n / matched * 100)}` : '—';
  const exampleRows = examples.map(e =>
    `<tr><td>${esc(e.orderNumber)}</td><td><code>${esc(e.barcode)}</code></td><td class="num">${e.qty}</td>
     <td class="num">${e.lineCommission}</td><td class="num">${e.settlementAmount}</td>
     <td class="num">%${e.settlementRate}</td><td><b>${e.verdict}</b></td></tr>`).join('');

  const typeRows = [...typeSummary.entries()].sort((a, b) => b[1].count - a[1].count).map(([t, v]) =>
    `<tr><td>${esc(t)}</td><td class="num">${v.count}</td>
     <td class="num">${fmtTL(v.credit)} ₺</td><td class="num">${fmtTL(v.debt)} ₺</td>
     <td class="num">${fmtTL(v.credit - v.debt)} ₺</td></tr>`).join('');

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Komisyon Analizi — Trendyol</title>
<style>
  :root { --ink:#1c2430; --paper:#f6f4ee; --line:#d8d3c6; --dim:#6b6f76; --accent:#0e7c66; --warn:#b3541e; --card:#fffdf8; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font:14px/1.55 ui-monospace,"SF Mono",Consolas,monospace; padding:28px 32px 80px; }
  h1 { font-size:20px; border-bottom:3px double var(--ink); padding-bottom:10px; }
  h2 { font-size:15px; margin-top:36px; border-bottom:1px solid var(--line); padding-bottom:5px; }
  p.note { color:var(--dim); font-size:13px; }
  table { border-collapse:collapse; background:var(--card); border:1px solid var(--line); font-size:12.5px; margin-top:8px; min-width:60%; }
  th { text-align:left; padding:7px 12px; border-bottom:2px solid var(--ink); background:var(--paper); }
  td { padding:5px 12px; border-bottom:1px solid var(--line); }
  td.num { text-align:right; white-space:nowrap; }
  tr.changed td { background:#fdf3ec; }
  .verdict { display:inline-block; background:var(--card); border:1px solid var(--line); border-radius:6px; padding:10px 16px; margin:6px 8px 6px 0; }
  .verdict b { font-size:18px; color:var(--accent); display:block; }
</style></head><body>
<h1>Komisyon Analizi <small style="color:var(--dim)">— Run #${runId} · ${sales.length} satış satırı / ${settlements.length} toplam settlement</small></h1>

<h2>1 · commissionRate dağılımı (Satış satırları)</h2>
<table><thead><tr><th>Oran</th><th>Satır</th><th>Toplam komisyon</th></tr></thead><tbody>${rateRows}</tbody></table>

<h2>2 &amp; 3 · Barkod/SKU bazında komisyon ${changedCount ? `— <span style="color:var(--warn)">${changedCount} üründe oran değişimi tespit edildi</span>` : '— oran değişimi yok'}</h2>
<table><thead><tr><th>Barkod</th><th>SKU</th><th>Satır</th><th>Ort. oran</th><th>Toplam komisyon</th><th>Oran zaman çizgisi</th></tr></thead>
<tbody>${skuRows}</tbody></table>

<h2>4 · lines[].commission: oran mı, tutar mı?</h2>
<p class="note">Aynı orderNumber + barcode ile sipariş satırı ↔ settlement satırı eşleştirildi (${matched} eşleşme,
${verdict.noOrderMatch} settlement satırı sipariş penceresinde bulunamadı, ${verdict.nullLineCommission} satırda lines[].commission null).</p>
<div>
  <span class="verdict"><b>${pct(verdict.amount)}</b>tutar ile örtüşüyor<br><small>lines[].commission ≈ commissionAmount</small></span>
  <span class="verdict"><b>${pct(verdict.amountTimesQty)}</b>tutar × adet<br><small>≈ commissionAmount × quantity</small></span>
  <span class="verdict"><b>${pct(verdict.rate)}</b>oran ile örtüşüyor<br><small>≈ commissionRate</small></span>
  <span class="verdict"><b>${pct(verdict.neither)}</b>hiçbiri<br><small>ayrıca incelenmeli</small></span>
</div>
<table><thead><tr><th>Sipariş</th><th>Barkod</th><th>Adet</th><th>lines[].commission</th><th>settlement tutar</th><th>settlement oran</th><th>Sonuç</th></tr></thead>
<tbody>${exampleRows}</tbody></table>

<h2>5 · transactionType özeti (tüm settlement satırları)</h2>
<table><thead><tr><th>Tip</th><th>Satır</th><th>Alacak (credit)</th><th>Borç (debt)</th><th>Net</th></tr></thead>
<tbody>${typeRows}</tbody></table>
</body></html>`;
}

module.exports = { buildAnalysis };
