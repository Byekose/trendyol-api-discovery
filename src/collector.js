'use strict';

const { pool } = require('./db');
const client = require('./trendyol/client');
const endpoints = require('./trendyol/endpoints');
const { DAY } = require('./trendyol/endpoints');
const config = require('./config');
const analyzer = require('./analyzer');

// Basit in-memory progress durumu (/status endpoint'i okur)
const progress = {
  running: false,
  runId: null,
  startedAt: null,
  current: null,
  requestsDone: 0,
  errors: 0,
  log: []
};

function logLine(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log('[collector]', line);
  progress.log.push(line);
  if (progress.log.length > 200) progress.log.shift();
}

async function saveResponse(runId, key, result) {
  progress.requestsDone++;
  if (result.status >= 400 || result.status === 0) progress.errors++;
  await pool.query(
    `INSERT INTO raw_responses (run_id, endpoint_key, request_url, http_status, body, error_text)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, key, result.url, result.status, result.body === null ? null : JSON.stringify(result.body), result.errorText]
  );
}

/** Tek bir parametre kümesi için sayfalama yaparak çeker. */
async function fetchPaginated(runId, ep, baseParams) {
  let page = 0;
  while (page < (ep.maxPages || 10)) {
    const params = { ...baseParams, [ep.pageParam]: page, [ep.sizeParam]: ep.size };
    const result = await client.get(ep.path, params);
    await saveResponse(runId, ep.key, result);

    if (result.status !== 200 || !result.body) return; // hata da kanıttır, devam etme
    const content = Array.isArray(result.body.content) ? result.body.content
      : Array.isArray(result.body) ? result.body : null;
    if (!content || content.length === 0) return;

    const totalPages = result.body.totalPages;
    page++;
    if (typeof totalPages === 'number' && page >= totalPages) return;
  }
}

/** DISCOVERY_DAYS aralığını endpoint'in dateWindow'una göre pencerelere böler. */
function dateWindows(ep) {
  if (!ep.dateWindow) return [null];
  const windows = [];
  const now = Date.now();
  const from = now - config.discoveryDays * DAY;
  let end = now;
  while (end > from) {
    const start = Math.max(from, end - ep.dateWindow * DAY);
    windows.push({ [ep.dateParams[0]]: start, [ep.dateParams[1]]: end });
    end = start;
  }
  return windows;
}

async function collectEndpoint(runId, ep) {
  progress.current = ep.key;
  logLine(`→ ${ep.key} (${ep.name})`);

  const variants = ep.variants || [{ label: null, params: {} }];
  const windows = dateWindows(ep);

  for (const variant of variants) {
    for (const win of windows) {
      const baseParams = { ...(ep.params || {}), ...(variant.params || {}), ...(win || {}) };
      if (ep.pagination === 'page') {
        await fetchPaginated(runId, ep, baseParams);
      } else {
        const result = await client.get(ep.path, baseParams);
        await saveResponse(runId, ep.key, result);
      }
    }
    if (variant.label) logLine(`  ${ep.key} · variant ${variant.label} tamam`);
  }
}

async function runCollection() {
  if (progress.running) throw new Error('Zaten çalışan bir toplama var');

  const { rows } = await pool.query(
    `INSERT INTO runs (status) VALUES ('running') RETURNING id`
  );
  const runId = rows[0].id;

  Object.assign(progress, {
    running: true, runId, startedAt: new Date().toISOString(),
    requestsDone: 0, errors: 0, current: null, log: []
  });

  try {
    for (const ep of endpoints) {
      await collectEndpoint(runId, ep);
    }
    logLine('Toplama bitti, analiz başlıyor…');
    await analyzer.analyzeRun(runId);
    await pool.query(
      `UPDATE runs SET status='done', finished_at=now(),
       stats = $2 WHERE id=$1`,
      [runId, JSON.stringify({ requests: progress.requestsDone, errors: progress.errors })]
    );
    logLine(`Run #${runId} tamamlandı. ${progress.requestsDone} istek, ${progress.errors} hata.`);
  } catch (err) {
    logLine(`HATA: ${err.message}`);
    await pool.query(`UPDATE runs SET status='failed', finished_at=now() WHERE id=$1`, [runId]);
    throw err;
  } finally {
    progress.running = false;
    progress.current = null;
  }
}

module.exports = { runCollection, progress };
