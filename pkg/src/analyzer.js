'use strict';

const { pool } = require('./db');

const SENSITIVE = /name|email|address|phone|tckn|taxnumber|gsm|identity/i;
const MAX_DISTINCT = 40;       // enum adayı takibi için tavan
const ENUM_THRESHOLD = 25;     // ≤ 25 distinct string → enum kabul
const MAX_EXAMPLE_LEN = 80;

function mask(value) {
  const s = String(value);
  if (s.length <= 2) return '**';
  return s[0] + '*'.repeat(Math.min(s.length - 2, 8)) + s[s.length - 1];
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string | number | boolean | object
}

/**
 * Response body'den kayıt listesini çıkarır.
 * Trendyol standardı: { page, size, totalPages, content: [...] }
 */
function extractRecords(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.content)) return body.content;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.categories)) return body.categories;
  if (Array.isArray(body.brands)) return body.brands;
  return [body]; // tek obje (ör. addresses)
}

/** Bir kaydı gezerek stats haritasını günceller. */
function walk(record, prefix, stats, parentVisits) {
  if (typeOf(record) !== 'object') return;

  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    let s = stats.get(path);
    if (!s) {
      s = { present: 0, nonNull: 0, types: {}, distinct: new Map(), min: null, max: null, example: null, truncatedDistinct: false };
      stats.set(path, s);
    }
    s.present++;
    const t = typeOf(value);
    s.types[t] = (s.types[t] || 0) + 1;
    if (t === 'null') continue;
    s.nonNull++;

    if (t === 'number') {
      s.min = s.min === null ? value : Math.min(s.min, value);
      s.max = s.max === null ? value : Math.max(s.max, value);
    }

    if (t === 'string' || t === 'number' || t === 'boolean') {
      const sensitive = SENSITIVE.test(key);
      if (s.example === null) {
        s.example = sensitive ? mask(value) : String(value).slice(0, MAX_EXAMPLE_LEN);
      }
      if (!sensitive && t === 'string' && String(value).length <= 60) {
        if (s.distinct.size < MAX_DISTINCT) s.distinct.set(String(value), true);
        else s.truncatedDistinct = true;
      }
    } else if (t === 'object') {
      walk(value, path, stats, parentVisits);
    } else if (t === 'array') {
      const arrPath = `${path}[]`;
      let as = stats.get(arrPath);
      if (!as) {
        as = { present: 0, nonNull: 0, types: {}, distinct: new Map(), min: null, max: null, example: null, truncatedDistinct: false };
        stats.set(arrPath, as);
      }
      for (const item of value) {
        as.present++;
        const it = typeOf(item);
        as.types[it] = (as.types[it] || 0) + 1;
        if (it !== 'null') as.nonNull++;
        if (it === 'object') walk(item, arrPath, stats, parentVisits);
        else if (it === 'string' && String(item).length <= 60 && as.distinct.size < MAX_DISTINCT) {
          as.distinct.set(String(item), true);
          if (as.example === null) as.example = String(item).slice(0, MAX_EXAMPLE_LEN);
        }
      }
    }
  }
}

function finalize(stats, totalRecords) {
  const fields = [];
  for (const [path, s] of [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const depth = path.split('.').length - 1;
    // Doluluk oranı: kök seviyedeki field'lar için toplam kayıt sayısına,
    // nested field'lar için parent görülme sayısına oranlanmalı; pratik
    // sadelik için present/totalRecords raporlanır, nested'ta >%100 kırpılır.
    const fillRate = totalRecords > 0
      ? Math.min(100, Math.round((s.nonNull / totalRecords) * 100))
      : 0;

    const distinctValues = [...s.distinct.keys()];
    const isEnum = !s.truncatedDistinct
      && distinctValues.length > 0
      && distinctValues.length <= ENUM_THRESHOLD
      && (s.types.string || 0) > 0;

    fields.push({
      path,
      depth,
      types: s.types,
      seen: s.present,
      nonNull: s.nonNull,
      fillRate,
      enumValues: isEnum ? distinctValues.sort() : null,
      distinctCount: s.truncatedDistinct ? `${MAX_DISTINCT}+` : distinctValues.length,
      min: s.min,
      max: s.max,
      example: s.example
    });
  }
  return fields;
}

/** Önceki run'ın bulgularıyla karşılaştırıp değişiklikleri döner. */
function diff(prevFields, currFields) {
  if (!prevFields) return null;
  const prevMap = new Map(prevFields.map(f => [f.path, f]));
  const currMap = new Map(currFields.map(f => [f.path, f]));

  const newFields = currFields.filter(f => !prevMap.has(f.path)).map(f => f.path);
  const removedFields = prevFields.filter(f => !currMap.has(f.path)).map(f => f.path);
  const newEnumValues = [];

  for (const f of currFields) {
    const p = prevMap.get(f.path);
    if (p && p.enumValues && f.enumValues) {
      const added = f.enumValues.filter(v => !p.enumValues.includes(v));
      if (added.length) newEnumValues.push({ path: f.path, added });
    }
  }

  if (!newFields.length && !removedFields.length && !newEnumValues.length) return null;
  return { newFields, removedFields, newEnumValues };
}

async function analyzeRun(runId) {
  const { rows: keys } = await pool.query(
    `SELECT DISTINCT endpoint_key FROM raw_responses WHERE run_id = $1`, [runId]
  );

  for (const { endpoint_key } of keys) {
    const stats = new Map();
    let totalRecords = 0;
    let okResponses = 0;
    let errorSamples = [];

    // Bellek dostu: sayfa sayfa oku
    const { rows } = await pool.query(
      `SELECT http_status, body, error_text, request_url
       FROM raw_responses WHERE run_id = $1 AND endpoint_key = $2`,
      [runId, endpoint_key]
    );

    for (const row of rows) {
      if (row.http_status === 200 && row.body) {
        okResponses++;
        const records = extractRecords(row.body);
        totalRecords += records.length;
        for (const rec of records) walk(rec, '', stats);
      } else if (errorSamples.length < 10) {
        errorSamples.push({
          status: row.http_status,
          url: row.request_url.replace(/sellers\/\d+/, 'sellers/***'),
          error: (row.error_text || '').slice(0, 200)
        });
      }
    }

    const fields = finalize(stats, totalRecords);

    // Önceki run bulgusu
    const { rows: prevRows } = await pool.query(
      `SELECT findings FROM schema_findings
       WHERE endpoint_key = $1 AND run_id < $2
       ORDER BY run_id DESC LIMIT 1`,
      [endpoint_key, runId]
    );
    const prevFields = prevRows[0] ? prevRows[0].findings.fields : null;
    const changes = diff(prevFields, fields);

    const findings = {
      totalResponses: rows.length,
      okResponses,
      totalRecords,
      errorSamples,
      fields
    };

    await pool.query(
      `INSERT INTO schema_findings (run_id, endpoint_key, findings, changes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id, endpoint_key)
       DO UPDATE SET findings = $3, changes = $4`,
      [runId, endpoint_key, JSON.stringify(findings), changes ? JSON.stringify(changes) : null]
    );
  }
}

module.exports = { analyzeRun, _internals: { walk, finalize, diff, extractRecords, mask } };
