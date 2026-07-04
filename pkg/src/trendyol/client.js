'use strict';

/**
 * READ-ONLY Trendyol HTTP client.
 *
 * GÜVENLİK GARANTİSİ: Bu modülün dışa açık tek fonksiyonu get()'tir ve
 * fetch çağrısında method sabit olarak 'GET' yazılıdır. POST/PUT/DELETE
 * bu kod tabanında fiziken mevcut değildir — mağaza verisine yazmak
 * bu servis üzerinden mümkün değildir.
 */

const config = require('../config');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function authHeader() {
  const token = Buffer
    .from(`${config.trendyol.apiKey}:${config.trendyol.apiSecret}`)
    .toString('base64');
  return `Basic ${token}`;
}

function buildUrl(path, params) {
  const filled = path.replace(':sellerId', config.trendyol.sellerId);
  const url = new URL(config.trendyol.baseUrl + filled);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Tek GET isteği. 429'da exponential backoff ile 3 deneme.
 * Dönüş: { url, status, body, errorText }
 */
async function get(path, params) {
  const url = buildUrl(path, params);
  let attempt = 0;

  while (true) {
    attempt++;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET', // sabit — asla değişmez
        headers: {
          Authorization: authHeader(),
          'User-Agent': `${config.trendyol.sellerId} - SelfIntegration`,
          Accept: 'application/json'
        }
      });
    } catch (err) {
      if (attempt < 3) { await sleep(1500 * attempt); continue; }
      return { url, status: 0, body: null, errorText: `network: ${err.message}` };
    }

    if (res.status === 429 && attempt < 4) {
      await sleep(2000 * attempt);
      continue;
    }

    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* JSON değil */ }

    // Nazik rate limiting — her istekten sonra bekle
    await sleep(config.requestDelayMs);

    return {
      url,
      status: res.status,
      body,
      errorText: res.ok ? null : (text || `HTTP ${res.status}`).slice(0, 500)
    };
  }
}

module.exports = { get };
