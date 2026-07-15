import 'dotenv/config';

export interface UnvCampaignConfig {
  brand: string;
  model: string;
  campaignId: string;
  salePriceUzs: number;
  regularPriceUzs: number;
  promotionStarts: string;
  promotionEnds: string;
  warrantyMonths: number;
  specifications: readonly string[];
}

const DEFAULT_SPECIFICATIONS = [
    '3 MP tasvir',
    '4G ulanish',
    '30 metrgacha tungi ko\'rish',
    'ikki tomonlama audio',
    '512 GB gacha microSD',
    'IP66 himoya',
] as const;

export function loadUnvCampaignConfig(env: NodeJS.ProcessEnv = process.env): UnvCampaignConfig {
  const campaign: UnvCampaignConfig = {
    brand: env.UNV_BRAND?.trim() || 'UNV',
    model: env.UNV_MODEL?.trim() || 'Uho-P1G-M3F4D-EU',
    campaignId: env.UNV_CAMPAIGN_ID?.trim() || 'unv_uho_p1g_m3f4d_eu_202607',
    salePriceUzs: parsePositiveInteger(env.UNV_PROMO_PRICE_UZS, 499_000, 'UNV_PROMO_PRICE_UZS'),
    regularPriceUzs: parsePositiveInteger(env.UNV_REGULAR_PRICE_UZS, 526_350, 'UNV_REGULAR_PRICE_UZS'),
    promotionStarts: parseIsoDate(env.UNV_PROMOTION_START_DATE, '2026-07-13', 'UNV_PROMOTION_START_DATE'),
    promotionEnds: parseIsoDate(env.UNV_PROMOTION_END_DATE, '2026-07-20', 'UNV_PROMOTION_END_DATE'),
    warrantyMonths: parsePositiveInteger(env.UNV_WARRANTY_MONTHS, 12, 'UNV_WARRANTY_MONTHS'),
    specifications: DEFAULT_SPECIFICATIONS,
  };
  if (campaign.promotionStarts > campaign.promotionEnds) {
    throw new Error('UNV_PROMOTION_START_DATE must not be after UNV_PROMOTION_END_DATE.');
  }
  if (campaign.salePriceUzs >= campaign.regularPriceUzs) {
    throw new Error('UNV_PROMO_PRICE_UZS must be lower than UNV_REGULAR_PRICE_UZS.');
  }
  return campaign;
}

export const UNV_PRODUCT = loadUnvCampaignConfig();
export const UNV_CAMPAIGN_ID = UNV_PRODUCT.campaignId;

export type ProductLeadTemperature = 'Warm' | 'Hot';

const PRODUCT_PATTERN = /\b(unv|uho|p1g|m3f4d|kamera|camera|videokuzatuv|cctv|4g|micro\s*sd|ip66)\b|камера|видеокузатув|тунги|кафолат|доставка|етказиб/i;
const COMMERCIAL_PATTERN = /\b(narx(?:i)?|qancha|aksiya|sotib|olmoq|olaman|buyurtma|zakaz|dostavka|yetkaz\w*|mavjud|ombor(?:da)?|telefon|aloqa|to['‘’`]?lov)\b|нарх|қанча|акция|сотиб|оламан|буюртма|заказ|доставка|етказ|мавжуд|омбор|телефон|алоқа|тўлов/i;
const SPEC_PATTERN = /\b(xususiyat|funksiya|sifat|megapiksel|mp|4g|wifi|audio|micro\s*sd|xotira|ip66|kafolat|tungi|night|vision)\b|хусусият|функция|сифат|мегапиксел|хотира|кафолат|тунги/i;

export function isProductSalesQuestion(message: string, now = new Date(), campaign: UnvCampaignConfig = UNV_PRODUCT): boolean {
  const text = message.trim();
  if (text.length < 2) return false;
  return isUnvPromotionActive(now, campaign) && (PRODUCT_PATTERN.test(text) || COMMERCIAL_PATTERN.test(text) || SPEC_PATTERN.test(text));
}

export function classifyProductLead(message: string): ProductLeadTemperature {
  return COMMERCIAL_PATTERN.test(message) ? 'Hot' : 'Warm';
}

export function productLeadReason(message: string): string {
  if (/\b(buyurtma|zakaz|sotib|olaman|olmoq)\b|буюртма|заказ|сотиб|оламан/i.test(message)) return 'Buyurtma yoki xarid niyati bildirildi.';
  if (/\b(narx(?:i)?|qancha|aksiya|to['‘’`]?lov)\b|нарх|қанча|акция|тўлов/i.test(message)) return 'Narx yoki to‘lov haqida so‘radi.';
  if (/\b(dostavka|yetkaz\w*|mavjud|ombor(?:da)?)\b|доставка|етказ|мавжуд|омбор/i.test(message)) return 'Yetkazib berish yoki mavjudlik haqida so‘radi.';
  return 'Mahsulot xususiyatlariga qiziqdi.';
}

export function getProductSalesAnswer(message: string, operatorUsername: string, botUsername = 'wst_academy_qabul_bot', now = new Date(), campaign: UnvCampaignConfig = UNV_PRODUCT): string {
  const contact = operatorUsername.startsWith('@') ? operatorUsername : `@${operatorUsername}`;
  const privateBot = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
  const cta = `Buyurtma uchun ${contact} ga yozing. Telefon raqamingizni ochiq guruhga emas, ${privateBot} ga shaxsiy xabarda yuboring.`;
  if (!isUnvPromotionActive(now, campaign)) {
    return `${campaign.brand} ${campaign.model} aksiyasi ${formatUzbekDate(campaign.promotionEnds)} kuni yakunlangan. Amaldagi narx va mavjudlikni ${contact} orqali aniqlashtiring.`;
  }
  const promoPrice = formatUzs(campaign.salePriceUzs);
  const regularPrice = formatUzs(campaign.regularPriceUzs);
  const promotionEnd = formatUzbekDate(campaign.promotionEnds);

  if (/\b(narx(?:i)?|qancha|aksiya|to['‘’`]?lov)\b|нарх|қанча|акция|тўлов/i.test(message)) {
    return `${campaign.brand} ${campaign.model} aksiya narxi — ${promoPrice} so‘m (odatiy narx ${regularPrice} so‘m). Aksiya ${promotionEnd} gacha. ${cta}`;
  }
  if (/\b(kafolat|garantiya|warranty)\b|кафолат|гарантия/i.test(message)) {
    return `${campaign.brand} ${campaign.model} uchun ${campaign.warrantyMonths} oy kafolat beriladi. ${cta}`;
  }
  if (/\b(dostavka|yetkaz\w*)\b|доставка|етказ/i.test(message)) {
    return `Toshkent bo‘yicha yetkazib berish mavjud. Manzil va vaqt operator bilan buyurtma tasdiqlanganda kelishiladi. ${cta}`;
  }
  if (/\b(mavjud|ombor(?:da)?|stock)\b|мавжуд|омбор/i.test(message)) {
    return `${campaign.brand} ${campaign.model} mavjudligini buyurtma vaqtida operator aniq tasdiqlaydi. ${cta}`;
  }

  return `${campaign.brand} ${campaign.model}: ${campaign.specifications.join(', ')}. Aksiya narxi ${promoPrice} so‘m, kafolat ${campaign.warrantyMonths} oy. ${cta}`;
}

export function isUnvPromotionActive(now = new Date(), campaign: UnvCampaignConfig = UNV_PRODUCT): boolean {
  const today = getTashkentDateKey(now);
  return today >= campaign.promotionStarts && today <= campaign.promotionEnds;
}

function getTashkentDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not determine the Tashkent calendar date.');
  return `${year}-${month}-${day}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseIsoDate(value: string | undefined, fallback: string, name: string): string {
  const parsed = value?.trim() || fallback;
  const date = new Date(`${parsed}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== parsed) {
    throw new Error(`${name} must use a valid YYYY-MM-DD date.`);
  }
  return parsed;
}

function formatUzs(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatUzbekDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const months = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
  return `${day}-${months[month - 1]} ${year}`;
}
