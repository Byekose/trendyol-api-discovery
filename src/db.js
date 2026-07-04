'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id           SERIAL PRIMARY KEY,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at  TIMESTAMPTZ,
      status       TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
      stats        JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS raw_responses (
      id           BIGSERIAL PRIMARY KEY,
      run_id       INTEGER NOT NULL REFERENCES runs(id),
      endpoint_key TEXT NOT NULL,
      request_url  TEXT NOT NULL,
      http_status  INTEGER NOT NULL,
      body         JSONB,
      error_text   TEXT,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_raw_endpoint ON raw_responses(endpoint_key, run_id);

    CREATE TABLE IF NOT EXISTS schema_findings (
      id           SERIAL PRIMARY KEY,
      run_id       INTEGER NOT NULL REFERENCES runs(id),
      endpoint_key TEXT NOT NULL,
      findings     JSONB NOT NULL,
      changes      JSONB,             -- önceki run'a göre farklar
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id, endpoint_key)
    );
  `);
}

module.exports = { pool, init };
