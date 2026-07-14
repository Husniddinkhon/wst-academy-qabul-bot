export const UNV_CAMPAIGN_ID = 'unv_uho_p1g_m3f4d_eu_202607';

export const UNV_PRODUCT = {
  brand: 'UNV',
  model: 'Uho-P1G-M3F4D-EU',
  salePriceUzs: 499_000,
  previousPriceUzs: 526_350,
  promotionEnds: '2026-07-20',
  warrantyMonths: 12,
  specifications: [
    '3 MP tasvir',
    '4G ulanish',
    '30 metrgacha tungi ko\'rish',
    'ikki tomonlama audio',
    '512 GB gacha microSD',
    'IP66 himoya',
  ],
} as const;

export type ProductLeadTemperature = 'Warm' | 'Hot';

const PRODUCT_PATTERN = /\b(unv|uho|p1g|m3f4d|kamera|camera|videokuzatuv|cctv|4g|micro\s*sd|ip66)\b|камера|видеокузатув|тунги|кафолат|доставка|етказиб/i;
const COMMERCIAL_PATTERN = /\b(narx(?:i)?|qancha|aksiya|sotib|olmoq|olaman|buyurtma|zakaz|dostavka|yetkaz\w*|mavjud|ombor(?:da)?|telefon|aloqa|to['‘’`]?lov)\b|нарх|қанча|акция|сотиб|оламан|буюртма|заказ|доставка|етказ|мавжуд|омбор|телефон|алоқа|тўлов/i;
const SPEC_PATTERN = /\b(xususiyat|funksiya|sifat|megapiksel|mp|4g|wifi|audio|micro\s*sd|xotira|ip66|kafolat|tungi|night|vision)\b|хусусият|функция|сифат|мегапиксел|хотира|кафолат|тунги/i;

export function isProductSalesQuestion(message: string): boolean {
  const text = message.trim();
  if (text.length < 2) return false;
  return PRODUCT_PATTERN.test(text) || COMMERCIAL_PATTERN.test(text) || SPEC_PATTERN.test(text);
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

export function getProductSalesAnswer(message: string, operatorUsername: string, botUsername = 'wst_academy_qabul_bot'): string {
  const contact = operatorUsername.startsWith('@') ? operatorUsername : `@${operatorUsername}`;
  const privateBot = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
  const cta = `Buyurtma uchun ${contact} ga yozing. Telefon raqamingizni ochiq guruhga emas, ${privateBot} ga shaxsiy xabarda yuboring.`;

  if (/\b(narx(?:i)?|qancha|aksiya|to['‘’`]?lov)\b|нарх|қанча|акция|тўлов/i.test(message)) {
    return `UNV ${UNV_PRODUCT.model} aksiya narxi — 499 000 so‘m (oldingi narx 526 350 so‘m). Aksiya 20-iyul 2026 gacha. ${cta}`;
  }
  if (/\b(kafolat|garantiya|warranty)\b|кафолат|гарантия/i.test(message)) {
    return `UNV ${UNV_PRODUCT.model} uchun 12 oy kafolat beriladi. ${cta}`;
  }
  if (/\b(dostavka|yetkaz\w*)\b|доставка|етказ/i.test(message)) {
    return `Toshkent bo‘yicha yetkazib berish mavjud. Manzil va vaqt operator bilan buyurtma tasdiqlanganda kelishiladi. ${cta}`;
  }
  if (/\b(mavjud|ombor(?:da)?|stock)\b|мавжуд|омбор/i.test(message)) {
    return `UNV ${UNV_PRODUCT.model} mavjudligini buyurtma vaqtida operator aniq tasdiqlaydi. ${cta}`;
  }

  return `UNV ${UNV_PRODUCT.model}: 3 MP, 4G, 30 metrgacha tungi ko‘rish, ikki tomonlama audio, 512 GB gacha microSD va IP66 himoya. Aksiya narxi 499 000 so‘m, kafolat 12 oy. ${cta}`;
}
