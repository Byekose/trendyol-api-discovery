'use strict';

/**
 * Trendyol Satıcı API — READ-ONLY endpoint envanteri.
 *
 * Kaynak: https://developers.trendyol.com (llms.txt + OpenAPI referansları, Temmuz 2026)
 * Base URL: https://apigw.trendyol.com/integration
 *
 * Alanlar:
 *  - path: :sellerId placeholder'ı client tarafında doldurulur
 *  - pagination: 'page' (page/size), 'none' (tek istek)
 *  - dateWindow: gün cinsinden maksimum pencere. Tanımlıysa collector
 *    DISCOVERY_DAYS aralığını bu pencerelere böler.
 *  - dateParams: [startParam, endParam] — Unix timestamp (ms)
 *  - variants: her biri için ayrı çekim yapılacak zorunlu/ayrıştırıcı
 *    parametre kümeleri (ör. settlements'ta transactionType zorunlu).
 *    Geçersiz variant 400 dönerse harness bunu bulgu olarak kaydeder, durmaz.
 *  - maxPages: güvenlik tavanı (sonsuz döngü/kota koruması)
 */

const DAY = 24 * 60 * 60 * 1000;

const SETTLEMENT_TYPES = [
  'Sale', 'Return', 'Discount', 'DiscountCancel', 'Coupon', 'CouponCancel',
  'ProvisionPositive', 'ProvisionNegative', 'ManualRefund', 'ManualRefundCancel',
  'TYDiscount', 'TYDiscountCancel', 'TYCoupon', 'TYCouponCancel',
  'SellerRevenuePositive', 'SellerRevenueNegative',
  'CommissionPositive', 'CommissionNegative',
  'SellerRevenuePositiveCancel', 'SellerRevenueNegativeCancel',
  'CommissionPositiveCancel', 'CommissionNegativeCancel'
];

// Dokümantasyonda dağınık listelenen tipler; geçersiz olanlar 400 döner ve
// rapora "bu type bu hesapta geçersiz/boş" bulgusu olarak düşer.
const OTHER_FINANCIAL_TYPES = [
  'CashAdvance', 'WireTransfer', 'IncomingTransfer', 'ReturnInvoice',
  'CommissionAgreementInvoice', 'PaymentOrder', 'DeductionInvoices',
  'FinancialItem', 'Stoppage'
];

module.exports = [
  // ─── SİPARİŞ ─────────────────────────────────────────────────────────
  {
    key: 'orders',
    name: 'Sipariş Paketleri (getShipmentPackages)',
    path: '/order/sellers/:sellerId/orders',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 200, maxPages: 50,
    dateWindow: 14, dateParams: ['startDate', 'endDate'],
    docs: 'https://developers.trendyol.com/reference/getshipmentpackages'
  },
  {
    key: 'orders_by_status',
    name: 'Sipariş Paketleri — nadir statuslar',
    path: '/order/sellers/:sellerId/orders',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 200, maxPages: 5,
    // Tarih filtresi olmadan, nadir statusların şemasını garanti yakalamak için
    variants: ['UnSupplied', 'UnDelivered', 'Returned', 'AtCollectionPoint', 'Awaiting']
      .map(s => ({ label: s, params: { status: s } })),
    docs: 'https://developers.trendyol.com/reference/getshipmentpackages'
  },

  // ─── İADE ────────────────────────────────────────────────────────────
  {
    key: 'claims',
    name: 'İadeler (getClaims)',
    path: '/order/sellers/:sellerId/claims',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 50, maxPages: 50,
    dateWindow: 14, dateParams: ['startDate', 'endDate'],
    docs: 'https://developers.trendyol.com/reference/getclaims'
  },
  {
    key: 'claim_issue_reasons',
    name: 'İade Red Sebepleri (getClaimIssueReasons)',
    path: '/order/claim-issue-reasons',
    pagination: 'none',
    docs: 'https://developers.trendyol.com/reference/getclaimissuereasons'
  },

  // ─── ÜRÜN ────────────────────────────────────────────────────────────
  {
    key: 'products_approved',
    name: 'Onaylı Ürünler (filterApprovedProducts v2)',
    path: '/product/sellers/:sellerId/products',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 100, maxPages: 100,
    params: { approved: true },
    docs: 'https://developers.trendyol.com/reference/filterapprovedproducts'
  },
  {
    key: 'products_unapproved',
    name: 'Onaysız Ürünler (filterUnapprovedProducts v2)',
    path: '/product/sellers/:sellerId/products',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 100, maxPages: 20,
    params: { approved: false },
    docs: 'https://developers.trendyol.com/reference/filterunapprovedproducts'
  },

  // ─── MÜŞTERİ SORULARI ────────────────────────────────────────────────
  {
    key: 'questions',
    name: 'Müşteri Soruları (getQuestionFilter)',
    path: '/qna/sellers/:sellerId/questions/filter',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 50, maxPages: 30,
    dateWindow: 14, dateParams: ['startDate', 'endDate'],
    docs: 'https://developers.trendyol.com/reference/getquestionfilter'
  },

  // ─── FİNANS / CARİ HESAP ─────────────────────────────────────────────
  {
    key: 'settlements',
    name: 'Cari Hesap — Settlements (satış/iade/komisyon)',
    path: '/finance/che/sellers/:sellerId/settlements',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 500, maxPages: 20,
    dateWindow: 15, dateParams: ['startDate', 'endDate'], dateRequired: true,
    variants: SETTLEMENT_TYPES.map(t => ({ label: t, params: { transactionType: t } })),
    docs: 'https://developers.trendyol.com/reference/getsettlements'
  },
  {
    key: 'other_financials',
    name: 'Cari Hesap — Other Financials (hakediş/faturalar/virman)',
    path: '/finance/che/sellers/:sellerId/otherfinancials',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 500, maxPages: 20,
    dateWindow: 15, dateParams: ['startDate', 'endDate'], dateRequired: true,
    variants: OTHER_FINANCIAL_TYPES.map(t => ({ label: t, params: { transactionType: t } })),
    docs: 'https://developers.trendyol.com/reference/getotherfinancials'
  },

  // ─── STATİK / KATALOG REFERANSLARI ───────────────────────────────────
  {
    key: 'addresses',
    name: 'İade/Sevkiyat/Fatura Adresleri (getSuppliersAddresses)',
    path: '/sellers/:sellerId/addresses',
    pagination: 'none',
    docs: 'https://developers.trendyol.com/reference/getsuppliersaddresses'
  },
  {
    key: 'cargo_providers',
    name: 'Kargo Firmaları (getProviders)',
    path: '/shipment-providers',
    pagination: 'none',
    docs: 'https://developers.trendyol.com/docs/trendyol-kargo-şirketleri-listesi-getproviders-1'
  },
  {
    key: 'brands',
    name: 'Marka Listesi (getBrands) — örneklem',
    path: '/product/brands',
    pagination: 'page',
    sizeParam: 'size', pageParam: 'page', size: 1000, maxPages: 2, // şema için örneklem yeter
    docs: 'https://developers.trendyol.com/reference/getbrands'
  },
  {
    key: 'category_tree',
    name: 'Kategori Ağacı (getCategoryTree)',
    path: '/product/product-categories',
    pagination: 'none',
    docs: 'https://developers.trendyol.com/reference/getcategorytree'
  },
  {
    key: 'webhooks',
    name: 'Tanımlı Webhook Listesi (getWebhooks)',
    path: '/webhook/sellers/:sellerId/webhooks',
    pagination: 'none',
    docs: 'https://developers.trendyol.com/reference/getwebhooks'
  }
];

module.exports.DAY = DAY;
