import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProductLead, getProductSalesAnswer, isProductSalesQuestion, productLeadReason, UNV_CAMPAIGN_ID, UNV_PRODUCT } from '../src/productSales.js';

test('UNV campaign facts stay exact', () => {
  assert.equal(UNV_CAMPAIGN_ID, 'unv_uho_p1g_m3f4d_eu_202607');
  assert.equal(UNV_PRODUCT.model, 'Uho-P1G-M3F4D-EU');
  assert.equal(UNV_PRODUCT.salePriceUzs, 499_000);
  assert.equal(UNV_PRODUCT.previousPriceUzs, 526_350);
  assert.equal(UNV_PRODUCT.warrantyMonths, 12);
});

test('recognizes Uzbek Cyrillic and Latin product questions', () => {
  assert.equal(isProductSalesQuestion('Бу камера нархи қанча?'), true);
  assert.equal(isProductSalesQuestion('UNV Uho-P1G-M3F4D-EU da 4G bormi?'), true);
  assert.equal(isProductSalesQuestion('Bugun ob-havo qanday?'), false);
});

test('commercial intent becomes a hot lead', () => {
  assert.equal(classifyProductLead('Narxi qancha, buyurtma bermoqchiman'), 'Hot');
  assert.equal(classifyProductLead('IP66 nima degani?'), 'Warm');
  assert.match(productLeadReason('Буюртма бермоқчиман'), /Buyurtma/);
});

test('answers with verified price and safe private-message CTA', () => {
  const answer = getProductSalesAnswer('Narxi qancha?', '@hr_wst');
  assert.match(answer, /499 000 so‘m/);
  assert.match(answer, /526 350 so‘m/);
  assert.match(answer, /20-iyul 2026/);
  assert.match(answer, /@hr_wst/);
  assert.match(answer, /ochiq guruhga emas/);
});

test('does not promise unverified stock or delivery terms', () => {
  assert.match(getProductSalesAnswer('Omborda bormi?', '@hr_wst'), /operator aniq tasdiqlaydi/);
  assert.match(getProductSalesAnswer('Dostavka bormi?', '@hr_wst'), /kelishiladi/);
});
