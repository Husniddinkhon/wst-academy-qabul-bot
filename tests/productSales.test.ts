import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProductLead, getProductSalesAnswer, isProductSalesQuestion, isUnvPromotionActive, loadUnvCampaignConfig, productLeadReason, UNV_CAMPAIGN_ID, UNV_PRODUCT } from '../src/productSales.js';

const ACTIVE_NOW = new Date('2026-07-15T07:00:00.000Z');
const BEFORE_PROMO = new Date('2026-07-12T18:59:59.999Z');
const AFTER_PROMO = new Date('2026-07-20T19:00:00.000Z');

test('UNV campaign facts stay exact', () => {
  assert.equal(UNV_CAMPAIGN_ID, 'unv_uho_p1g_m3f4d_eu_202607');
  assert.equal(UNV_PRODUCT.model, 'Uho-P1G-M3F4D-EU');
  assert.equal(UNV_PRODUCT.salePriceUzs, 499_000);
  assert.equal(UNV_PRODUCT.regularPriceUzs, 526_350);
  assert.equal(UNV_PRODUCT.promotionStarts, '2026-07-13');
  assert.equal(UNV_PRODUCT.promotionEnds, '2026-07-20');
  assert.equal(UNV_PRODUCT.warrantyMonths, 12);
});

test('recognizes Uzbek Cyrillic and Latin product questions', () => {
  assert.equal(isProductSalesQuestion('Бу камера нархи қанча?', ACTIVE_NOW), true);
  assert.equal(isProductSalesQuestion('UNV Uho-P1G-M3F4D-EU da 4G bormi?', ACTIVE_NOW), true);
  assert.equal(isProductSalesQuestion('Bugun ob-havo qanday?', ACTIVE_NOW), false);
});

test('commercial intent becomes a hot lead', () => {
  assert.equal(classifyProductLead('Narxi qancha, buyurtma bermoqchiman'), 'Hot');
  assert.equal(classifyProductLead('IP66 nima degani?'), 'Warm');
  assert.match(productLeadReason('Буюртма бермоқчиман'), /Buyurtma/);
});

test('answers with verified price and safe private-message CTA', () => {
  const answer = getProductSalesAnswer('Narxi qancha?', '@hr_wst', 'wst_academy_qabul_bot', ACTIVE_NOW);
  assert.match(answer, /499 000 so‘m/);
  assert.match(answer, /526 350 so‘m/);
  assert.match(answer, /20-iyul 2026/);
  assert.match(answer, /@hr_wst/);
  assert.match(answer, /ochiq guruhga emas/);
});

test('does not promise unverified stock or delivery terms', () => {
  assert.match(getProductSalesAnswer('Omborda bormi?', '@hr_wst', 'wst_academy_qabul_bot', ACTIVE_NOW), /operator aniq tasdiqlaydi/);
  assert.match(getProductSalesAnswer('Dostavka bormi?', '@hr_wst', 'wst_academy_qabul_bot', ACTIVE_NOW), /kelishiladi/);
});

test('campaign activation uses inclusive Asia/Tashkent calendar dates', () => {
  assert.equal(isUnvPromotionActive(BEFORE_PROMO), false);
  assert.equal(isUnvPromotionActive(new Date('2026-07-12T19:00:00.000Z')), true);
  assert.equal(isUnvPromotionActive(new Date('2026-07-20T18:59:59.999Z')), true);
  assert.equal(isUnvPromotionActive(AFTER_PROMO), false);
});

test('expired or not-yet-active promotion cannot match and create a promotional lead', () => {
  assert.equal(isProductSalesQuestion('Narxi qancha, buyurtma bermoqchiman', BEFORE_PROMO), false);
  assert.equal(isProductSalesQuestion('Narxi qancha, buyurtma bermoqchiman', AFTER_PROMO), false);
});

test('expired promotion answer never advertises the old promotional price', () => {
  const answer = getProductSalesAnswer('Narxi qancha?', '@hr_wst', 'wst_academy_qabul_bot', AFTER_PROMO);
  assert.match(answer, /aksiyasi 20-iyul 2026 kuni yakunlangan/);
  assert.doesNotMatch(answer, /499 000|526 350|aksiya narxi/i);
});

test('campaign facts are loaded from validated environment configuration', () => {
  const campaign = loadUnvCampaignConfig({
    UNV_BRAND: 'UNV',
    UNV_MODEL: 'Custom-model',
    UNV_CAMPAIGN_ID: 'custom-campaign',
    UNV_PROMOTION_START_DATE: '2026-08-01',
    UNV_PROMOTION_END_DATE: '2026-08-05',
    UNV_PROMO_PRICE_UZS: '450000',
    UNV_REGULAR_PRICE_UZS: '500000',
    UNV_WARRANTY_MONTHS: '24',
  });
  assert.equal(campaign.model, 'Custom-model');
  assert.equal(campaign.campaignId, 'custom-campaign');
  assert.equal(campaign.salePriceUzs, 450_000);
  assert.equal(campaign.regularPriceUzs, 500_000);
  assert.equal(campaign.warrantyMonths, 24);
  assert.throws(() => loadUnvCampaignConfig({ UNV_PROMOTION_START_DATE: '2026-02-31' }), /valid YYYY-MM-DD/);
  assert.throws(() => loadUnvCampaignConfig({ UNV_PROMO_PRICE_UZS: '600000', UNV_REGULAR_PRICE_UZS: '500000' }), /must be lower/);
});
