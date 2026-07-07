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

const HOT_PATTERNS = [
  /\b(narx|qancha|necha pul|to['‘’`]?lov|tolov|bo['‘’`]?lib|bolib|muddatli|rassrochka|boshlan|start)\b/i,
  /\b(yozilaman|kelaman|to['‘’`]?layman|tolayman|qayerda|manzil)\b/i,
  /(?:\+?998|8)?\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/,
];

const WARM_PATTERNS = [/\b(dastur|programma|nima o['‘’`]?rgatiladi|davomiy|qancha davom|ustoz|o['‘’`]?qituvchi|format|online|offline)\b/i];

const GUARANTEED_JOB_ANSWER =
  'Kurs yakunida faol o‘quvchilarga ishga yo‘naltirish va amaliy imkoniyatlar tavsiya qilinadi. Lekin ish kafolatlanadi deb va’da bermaymiz.';

const FALLBACK_ANSWER = 'Savolingiz qabul qilindi. Operatorimiz siz bilan bog‘lanadi: @hr_wst';

const PRICE_ANSWER = [
  'Kurs narxi 2 500 000 so‘m.',
  'To‘lovni 2 bo‘lib qilish mumkin:',
  '1 500 000 so‘m avval, qolgan qismi 1-hafta oxirigacha.',
  '',
  'Ro‘yxatdan o‘tish uchun pastdagi “Ro‘yxatdan o‘tish” tugmasini bosing.',
].join('\n');

export function scoreLead(message: string): { score: LeadScore; reason: string } {
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

  if (asksGuaranteedJob(message)) {
    return { answer: GUARANTEED_JOB_ANSWER, ...scored };
  }

  if (asksPrice(message)) {
    return { answer: PRICE_ANSWER, ...scored };
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
        { role: 'system', content: buildSystemPrompt() },
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

export function getAiFallbackAnswer(): string {
  return FALLBACK_ANSWER;
}

export function isAiReady(config: AiConfig): boolean {
  return Boolean(config.enabled && config.apiKey && config.baseUrl && config.model);
}

function asksGuaranteedJob(message: string): boolean {
  return /\b(ish\s*kafolat|kafolatlangan\s*ish|ishga\s*joylashtirasiz|ish\s*topib\s*berasiz)\b/i.test(message);
}

function asksPrice(message: string): boolean {
  return /\b(narx|necha pul|to['‘’`]?lov|tolov|bo['‘’`]?lib|bolib|muddatli|rassrochka)\b/i.test(message) || /\bqancha\b.*\b(turadi|pul|narx|so['‘’`]?m)\b/i.test(message);
}

function formatAiAnswer(answer?: string): string | undefined {
  return answer
    ?.replace(/UZS/gi, 'so‘m')
    .replace(/[*_#]/g, '')
    .trim();
}

function buildSystemPrompt(): string {
  return [
    'Siz WST Academy Telegram botidagi AI sales konsultantsiz.',
    'Faqat Uzbek Latin tilida, qisqa, aniq, muloyim va sotuvga yo‘naltirilgan javob bering.',
    'Markdown belgilaridan foydalanmang. Javobda **, _, # belgilarini ishlatmang.',
    'Narx valyutasini har doim so‘m deb yozing. UZS yozmang.',
    'Faqat WST Academy “0 dan ustagacha” videokuzatuv kursi haqida javob bering.',
    'Ruxsat etilgan mavzular: videokuzatuv, IP camera, DVR/NVR, cabling, IP network, security systems, course duration, price, installment, certificate, job guidance, registration.',
    'Aloqasiz savol bo‘lsa, suhbatni kurs mavzusiga qaytaring.',
    'Hallutsinatsiya qilmang va quyidagi faktlardan tashqariga chiqmang.',
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
    `Agar kafolatli ish haqida so‘ralsa, aynan shunday javob bering: “${GUARANTEED_JOB_ANSWER}”`,
    `Agar foydalanuvchi narx yoki to‘lov haqida so‘rasa, aynan shunday javob bering:\n${PRICE_ANSWER}`,
    'Agar foydalanuvchi qiziqsa, “Ro‘yxatdan o‘tish” tugmasini bosishni taklif qiling.',
    `Operator so‘ralsa, ${courseInfo.operator} va ${courseInfo.phone} ni ko‘rsating.`,
  ].join('\n');
}
