import { courseInfo } from './course.js';

export type LeadScore = 'HOT' | 'WARM' | 'COLD';

export interface AiConfig {
  enabled: boolean;
  provider: 'openai_compatible';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature: number;
}

export interface AiAgentResult {
  answer: string;
  score: LeadScore;
  reason: string;
}

const PHONE_PATTERN = /(?:\+?998|8)?[\s()\-.]*(?:\d[\s()\-.]*){9}/;

const HOT_PATTERNS = [
  /\b(narx|qancha|necha pul|to['‘’`]?lov|tolov|bo['‘’`]?lib|bolib|muddatli|rassrochka|boshlan|start)\b/i,
  /\b(yozilaman|kelaman|to['‘’`]?layman|tolayman|qayerda|manzil)\b/i,
  PHONE_PATTERN,
];

const WARM_PATTERNS = [/\b(dastur|programma|nima o['‘’`]?rgatiladi|davomiy|qancha davom|ustoz|o['‘’`]?qituvchi|format|online|offline)\b/i];

const CALL_REQUEST_PATTERNS = [
  /menga\s+qo['‘’`]?ng['‘’`]?iroq\s+qiling/i,
  /menga\s+qungiroq\s+qiling/i,
  /qo['‘’`]?ng['‘’`]?iroq\s+qilinglar/i,
  /qungiroq\s+qilinglar/i,
  /qo['‘’`]?ng['‘’`]?iroq\s+qiling/i,
  /qungiroq\s+qiling/i,
  /telefon\s+qiling/i,
  /aloqaga\s+chiqing/i,
  /bog['‘’`]?laning/i,
  /менга\s+қўнғироқ\s+қилинг/i,
  /қўнғироқ\s+қилинглар/i,
  /телефон\s+қилинг/i,
  /алоқага\s+чиқинг/i,
  /свяжитесь/i,
  /позвоните/i,
  /call\s+me/i,
];

const UNRELATED_PATTERNS = [
  /\b(haydov|mashina|avto|dehqon|fermer|ekin|paxta|bug['‘’`]?doy|kino|serial|musiqa|qo['‘’`]?shiq|oyin|o['‘’`]?yin|futbol)\b/i,
  /\b(driving|farming|farm|movie|music|game|football|entertainment)\b/i,
  /\b(водит|машин|авто|ферм|урожай|кино|сериал|музык|игр|футбол|развлеч)\b/i,
];

const GUARANTEED_JOB_ANSWER_LATIN =
  'Kurs yakunida faol o‘quvchilarga ishga yo‘naltirish va amaliy imkoniyatlar tavsiya qilinadi. Lekin ish kafolatlanadi deb va’da bermaymiz.';
const GUARANTEED_JOB_ANSWER_CYRILLIC =
  'Курс якунида фаол ўқувчиларга ишга йўналтириш ва амалий имкониятлар тавсия қилинади. Лекин иш кафолатланади деб ваъда бермаймиз.';

const PHONE_REQUEST_ANSWER = 'Albatta. Operatorimiz siz bilan bog‘lanishi uchun telefon raqamingizni yuboring. Masalan: +998 90 123 45 67';
const PHONE_REQUEST_ANSWER_CYRILLIC = 'Албатта. Операторимиз сиз билан боғланиши учун телефон рақамингизни юборинг. Масалан: +998 90 123 45 67';
export const UNRELATED_ANSWER_LATIN = 'Bu bot faqat WST Academy videokuzatuv kursi bo‘yicha yordam beradi. Kurs haqida ma’lumot yoki ro‘yxatdan o‘tishni xohlaysizmi?';
export const UNRELATED_ANSWER_CYRILLIC = 'Бу бот фақат WST Academy видеокузатув курси бўйича ёрдам беради. Курс ҳақида маълумот ёки рўйхатдан ўтишни хоҳлайсизми?';

const PRICE_ANSWER_LATIN = [
  'Kurs narxi 2 500 000 so‘m.',
  'To‘lovni 2 bo‘lib qilish mumkin:',
  '1 500 000 so‘m avval, qolgan qismi 1-hafta oxirigacha.',
  '',
  'Ro‘yxatdan o‘tish uchun pastdagi “Ro‘yxatdan o‘tish” tugmasini bosing.',
].join('\n');

const PRICE_ANSWER_CYRILLIC = [
  'Курс нархи 2 500 000 сўм.',
  'Тўловни 2 бўлиб қилиш мумкин:',
  '1 500 000 сўм аввал, қолган қисми 1-ҳафта охиригача.',
  '',
  'Рўйхатдан ўтиш учун пастдаги “Рўйхатдан ўтиш” тугмасини босинг.',
].join('\n');

export function scoreLead(message: string): { score: LeadScore; reason: string } {
  if (isCallRequest(message)) return { score: 'HOT', reason: 'User asked for a call.' };

  if (HOT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { score: 'HOT', reason: 'Narx, to‘lov, boshlanish, telefon, manzil yoki ro‘yxatdan o‘tish niyati aniqlandi.' };
  }

  if (WARM_PATTERNS.some((pattern) => pattern.test(message))) {
    return { score: 'WARM', reason: 'Kurs dasturi, davomiyligi, ustoz yoki format bo‘yicha qiziqish aniqlandi.' };
  }

  return { score: 'COLD', reason: 'Kuchsiz yoki kursga aloqasiz qiziqish.' };
}

export async function answerWithAiAgent(message: string, config: AiConfig): Promise<AiAgentResult> {
  const scored = scoreLead(message);
  const cyrillic = hasCyrillic(message);

  if (asksGuaranteedJob(message)) {
    return { answer: cyrillic ? GUARANTEED_JOB_ANSWER_CYRILLIC : GUARANTEED_JOB_ANSWER_LATIN, ...scored };
  }

  if (asksPrice(message)) {
    return { answer: cyrillic ? PRICE_ANSWER_CYRILLIC : PRICE_ANSWER_LATIN, ...scored };
  }

  if (isUnrelatedTopic(message)) {
    return { answer: cyrillic ? UNRELATED_ANSWER_CYRILLIC : UNRELATED_ANSWER_LATIN, ...scored };
  }

  if (!config.enabled || !config.apiKey || !config.baseUrl || !config.model) {
    throw new Error('AI agent is not fully configured.');
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: [
        { role: 'system', content: buildSystemPrompt(cyrillic) },
        { role: 'user', content: message },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`AI provider returned ${response.status}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const answer = formatAiAnswer(data.choices?.[0]?.message?.content);

  if (!answer) {
    throw new Error('AI provider returned an empty answer.');
  }

  return { answer, ...scored };
}

export function getAiFallbackAnswer(message = ''): string {
  return hasCyrillic(message) ? `Саволингиз қабул қилинди. Операторимиз сиз билан боғланади: ${courseInfo.operator}` : `Savolingiz qabul qilindi. Operatorimiz siz bilan bog‘lanadi: ${courseInfo.operator}`;
}

export function getPhoneRequestAnswer(message: string): string {
  return hasCyrillic(message) ? PHONE_REQUEST_ANSWER_CYRILLIC : PHONE_REQUEST_ANSWER;
}


export function getUnrelatedTopicAnswer(message: string): string {
  return hasCyrillic(message) ? UNRELATED_ANSWER_CYRILLIC : UNRELATED_ANSWER_LATIN;
}

export function isAiReady(config: AiConfig): boolean {
  return Boolean(config.enabled && config.apiKey && config.baseUrl && config.model);
}

export function isCallRequest(message: string): boolean {
  return CALL_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

export function extractPhoneNumber(message: string): string | undefined {
  return message.match(PHONE_PATTERN)?.[0].trim();
}

function hasCyrillic(message: string): boolean {
  return /[А-Яа-яЁёЎўҚқҒғҲҳ]/.test(message);
}

export function isUnrelatedTopic(message: string): boolean {
  return UNRELATED_PATTERNS.some((pattern) => pattern.test(message));
}

function asksGuaranteedJob(message: string): boolean {
  return /\b(ish\s*kafolat|kafolatlangan\s*ish|ishga\s*joylashtirasiz|ish\s*topib\s*berasiz)\b/i.test(message) || /\b(иш\s*кафолат|кафолатланган\s*иш|ишга\s*жойлаштирасиз|иш\s*топиб\s*берасиз)\b/i.test(message);
}

function asksPrice(message: string): boolean {
  return /\b(narx|necha pul|to['‘’`]?lov|tolov|bo['‘’`]?lib|bolib|muddatli|rassrochka)\b/i.test(message) || /\bqancha\b.*\b(turadi|pul|narx|so['‘’`]?m)\b/i.test(message) || /\b(нарх|неча пул|тўлов|толов|бўлиб|муддатли|рассрочка|қанча)\b/i.test(message);
}

function formatAiAnswer(answer?: string): string | undefined {
  return answer
    ?.replace(/UZS/gi, 'so‘m')
    .replace(/[*_#]/g, '')
    .trim();
}

function buildSystemPrompt(cyrillic: boolean): string {
  return [
    'Siz WST Academy Telegram botidagi AI sales konsultantsiz.',
    cyrillic ? 'Foydalanuvchi Cyrillic yozdi. Faqat Uzbek Cyrillic tilida javob bering.' : 'Faqat Uzbek Latin tilida javob bering.',
    'Juda qisqa, aniq, muloyim va sotuvga yo‘naltirilgan javob bering.',
    'Markdown belgilaridan foydalanmang. Javobda **, _, # belgilarini ishlatmang.',
    'Narx valyutasini har doim so‘m deb yozing. UZS yozmang.',
    'Faqat WST Academy “0 dan ustagacha” videokuzatuv kursi haqida javob bering.',
    'Aloqasiz savol bo‘lsa, bot faqat WST Academy videokuzatuv kursi bo‘yicha yordam berishini ayting va kurs ma’lumoti yoki ro‘yxatdan o‘tishni qisqa taklif qiling.',
    `Kurs: ${courseInfo.title}.`,
    `Format: ${courseInfo.format}.`,
    `Davomiyligi: ${courseInfo.duration}.`,
    `Darslar: ${courseInfo.lessons}.`,
    'Jadval: haftasiga 3 kun.',
    `Narx: ${courseInfo.price}.`,
    `Bo‘lib to‘lash: ${courseInfo.installment}.`,
    `Kanal: ${courseInfo.channel}.`,
    `Operator: ${courseInfo.operator}.`,
    `Telefon: ${courseInfo.phone}.`,
    'Natija: sertifikat va ishga yo‘naltirish.',
    'Ish kafolatlanadi deb hech qachon va’da bermang. “ishga yo‘naltirish” iborasidan foydalaning.',
    'Agar foydalanuvchi qo‘ng‘iroq so‘rasa, telefon raqamini yuborishini so‘rang va operator bog‘lanishini ayting.',
    'Agar foydalanuvchi qiziqsa, “Ro‘yxatdan o‘tish” tugmasini bosishni taklif qiling.',
    `Operator so‘ralsa, ${courseInfo.operator} va ${courseInfo.phone} ni ko‘rsating.`,
  ].join('\n');
}
