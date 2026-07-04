'use strict';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required env var: ${name}`);
  }
  return v || '';
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  databaseUrl: required('DATABASE_URL'),

  trendyol: {
    sellerId: required('TRENDYOL_SUPPLIER_ID'),
    apiKey: required('TRENDYOL_API_KEY'),
    apiSecret: required('TRENDYOL_API_SECRET'),
    baseUrl: process.env.TRENDYOL_BASE_URL || 'https://apigw.trendyol.com/integration',
    // Trendyol zorunlu User-Agent formatı: {sellerId} - SelfIntegration
    userAgent: null // client.js içinde sellerId ile oluşturulur
  },

  // Rapor ekranı ve /run tetikleyicisi için şifre
  dashboardPassword: required('DASHBOARD_PASSWORD'),

  // Kaç günlük geçmiş çekilecek (nadir statusların yakalanması için 90 önerilir)
  discoveryDays: parseInt(process.env.DISCOVERY_DAYS || '90', 10),

  // İstekler arası bekleme (ms) — rate limit'e saygı
  requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || '350', 10),

  // Günlük otomatik toplama (Railway'de sürekli izleme için)
  cronEnabled: process.env.CRON_ENABLED === 'true',
  cronSchedule: process.env.CRON_SCHEDULE || '0 5 * * *' // her gün 05:00
};
