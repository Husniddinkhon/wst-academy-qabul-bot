import { Markup } from 'telegraf';
import type { BotContext } from './types.js';

export const LESSON_BUTTON = 'Bepul CCTV mini-dars';
export const QUIZ_BUTTON = 'CCTV bilim testi';
export const CALCULATOR_BUTTON = 'Xotira kalkulyatori';
export const NEXT_BUTTON = 'Keyingi';
export const BACK_BUTTON = 'Orqaga';
export const MENU_BUTTON = 'Asosiy menyu';

export const LESSONS = [
  { title: '1/3. Analog va IP kamera', body: 'Analog kamera DVR bilan koaksial kabel orqali ishlaydi. IP kamera esa tarmoqqa ulanadi va NVR yoki serverga yozadi. IP tizim kengaytirish va yuqori aniqlik uchun qulay; analog tizim mavjud kabelni saqlab qolishda foydali.' },
  { title: '2/3. DVR, NVR va disk', body: 'DVR analog signalni qayta ishlaydi, NVR IP kameradan tayyor raqamli oqim oladi. Yozuv muddati kamera soni, bitrate, kunlar va disk hajmiga bog‘liq. Muhim obyektlarda surveillance turidagi HDD ishlatiladi.' },
  { title: '3/3. Kabel va quvvat', body: 'IP kamerada Cat5e/Cat6 va PoE bitta kabel orqali tarmoq hamda quvvat bera oladi. Kabel masofasi, ulagich sifati va quvvat zaxirasi tekshirilmasa uzilishlar paydo bo‘ladi. Montajdan keyin tungi tasvir va yozuvni sinang.' },
] as const;

export const QUIZ = [
  { question: 'IP kameralar yozuvi odatda qaysi qurilmaga tushadi?', options: ['A) NVR', 'B) DVR', 'C) Router xotirasi'], correct: 0, explanation: 'NVR IP kameralar tarmoq oqimini yozadi.' },
  { question: 'PoE nimani bitta Ethernet kabelida uzatadi?', options: ['A) Faqat video', 'B) Tarmoq va quvvat', 'C) Faqat quvvat'], correct: 1, explanation: 'PoE tarmoq ma’lumoti va quvvatni bir kabelda uzatadi.' },
  { question: 'Yozuv hajmiga eng bevosita ta’sir qiladigan qiymat qaysi?', options: ['A) Kamera rangi', 'B) Bitrate', 'C) Kronshteyn turi'], correct: 1, explanation: 'Bitrate oshsa bir soniyada ko‘proq ma’lumot yoziladi.' },
  { question: 'Analog kamera odatda qaysi yozuv qurilmasi bilan ishlaydi?', options: ['A) DVR', 'B) NVR', 'C) Wi-Fi router'], correct: 0, explanation: 'DVR analog video signalni qabul qilib yozadi.' },
  { question: 'Montajdan keyingi muhim tekshiruv qaysi?', options: ['A) Faqat korpus rangi', 'B) Tungi tasvir va yozuv', 'C) Faqat quti o‘lchami'], correct: 1, explanation: 'Tungi tasvir va real yozuvni tekshirish tizim ishlashini tasdiqlaydi.' },
] as const;

export function lessonText(index: number): string { const item = LESSONS[index]; return `${item.title}\n\n${item.body}`; }
export function lessonKeyboard(index: number) { return Markup.keyboard([[...(index > 0 ? [BACK_BUTTON] : []), ...(index < LESSONS.length - 1 ? [NEXT_BUTTON] : [])], [MENU_BUTTON]]).resize(); }
export function quizText(index: number): string { const item = QUIZ[index]; return `${index + 1}/5. ${item.question}`; }
export function quizKeyboard(index: number) { const rows: string[][] = QUIZ[index].options.map((option) => [option]); rows.push([MENU_BUTTON]); return Markup.keyboard(rows).resize(); }

export function storageTerabytes(cameras: number, bitrateMbps: number, days: number): number {
  validateCalculatorValue('cameras', cameras);
  validateCalculatorValue('bitrate', bitrateMbps);
  validateCalculatorValue('days', days);
  return cameras * bitrateMbps * 1_000_000 / 8 * 86_400 * days / 1_000_000_000_000;
}

export function validateCalculatorValue(field: 'cameras' | 'bitrate' | 'days', value: number): void {
  const bounds = { cameras: [1, 128], bitrate: [0.25, 32], days: [1, 365] } as const;
  const [min, max] = bounds[field];
  if (!Number.isFinite(value) || value < min || value > max || (field !== 'bitrate' && !Number.isInteger(value))) throw new RangeError(`${field} must be ${min}-${max}`);
}

export async function startLesson(ctx: BotContext): Promise<void> { ctx.session.lessonIndex = 0; ctx.session.quizIndex = undefined; ctx.session.calculator = undefined; await ctx.reply(lessonText(0), lessonKeyboard(0)); }
export async function startQuiz(ctx: BotContext): Promise<void> { ctx.session.quizIndex = 0; ctx.session.quizScore = 0; ctx.session.lessonIndex = undefined; ctx.session.calculator = undefined; await ctx.reply(quizText(0), quizKeyboard(0)); }
export async function startCalculator(ctx: BotContext): Promise<void> { ctx.session.calculator = { step: 'cameras' }; ctx.session.lessonIndex = undefined; ctx.session.quizIndex = undefined; await ctx.reply('Kamera sonini kiriting (1–128):', Markup.keyboard([[MENU_BUTTON]]).resize()); }
