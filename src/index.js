'use strict';

const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const collector = require('./collector');
const reporter = require('./reporter');

const app = express();

// ── Şifre koruması ────────────────────────────────────────────────────
function guard(req, res, next) {
  const supplied = req.query.password
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!config.dashboardPassword || supplied !== config.dashboardPassword) {
    return res.status(401).send('Yetkisiz. ?password=… parametresi gerekli.');
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/run', guard, (req, res) => {
  if (collector.progress.running) {
    return res.status(409).json({
      message: 'Zaten çalışan bir toplama var',
      progress: publicProgress()
    });
  }
  collector.runCollection().catch(err =>
    console.error('[run] toplama hatası:', err.message)
  );
  res.json({
    message: `Toplama başladı (son ${config.discoveryDays} gün). /status ile izleyebilirsin.`,
  });
});

function publicProgress() {
  const p = collector.progress;
  return {
    running: p.running,
    runId: p.runId,
    startedAt: p.startedAt,
    currentEndpoint: p.current,
    requestsDone: p.requestsDone,
    errors: p.errors,
    lastLog: p.log.slice(-15)
  };
}

app.get('/status', guard, (_req, res) => res.json(publicProgress()));

app.get('/report', guard, async (_req, res) => {
  try {
    const html = await reporter.buildReport();
    res.type('html').send(html);
  } catch (err) {
    console.error('[report]', err);
    res.status(500).send('Rapor üretilemedi: ' + err.message);
  }
});

app.get('/analysis', guard, async (_req, res) => {
  try {
    const html = await require('./analysis').buildAnalysis();
    res.type('html').send(html);
  } catch (err) {
    console.error('[analysis]', err);
    res.status(500).send('Analiz üretilemedi: ' + err.message);
  }
});

app.get('/', (_req, res) => res.redirect('/report'));

// ── Başlatma ──────────────────────────────────────────────────────────
(async () => {
  await db.init();

  if (config.cronEnabled) {
    cron.schedule(config.cronSchedule, () => {
      if (!collector.progress.running) {
        console.log('[cron] günlük toplama başlıyor');
        collector.runCollection().catch(err =>
          console.error('[cron] hata:', err.message)
        );
      }
    });
    console.log(`[cron] aktif: ${config.cronSchedule}`);
  }

  app.listen(config.port, () =>
    console.log(`trendyol-api-discovery :${config.port} — read-only harness hazır`)
  );
})();
