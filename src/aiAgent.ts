import { courseInfo } from './course.js';
import { AiReliabilityController, type AiProviderIdentity, type AiReliabilityControls, type AiTokenUsage } from './aiReliability.js';

export type LeadScore = 'HOT' | 'WARM' | 'COLD';

export interface AiProviderConfig {
  provider: 'openai_compatible';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature: number;
  requestTimeoutMs?: number;
  maxOutputTokens?: number;
  supportsMaxOutputTokens?: boolean;
}

export interface AiConfig extends AiProviderConfig {
  enabled: boolean;
  fallback?: AiProviderConfig;
  reliability?: Partial<AiReliabilityControls>;
}

export interface AiAgentResult {
  answer: string;
  score: LeadScore;
  reason: string;
}

export interface AiRequestContext {
  actorId?: string;
  reliability?: AiReliabilityController;
}

const PHONE_PATTERN = /(?:\+?998[\s()\-.]*)?(?:\d[\s()\-.]*){9}/;
export const DEFAULT_AI_RELIABILITY: AiReliabilityControls = {
  rateLimitMaxRequests: 6,
  rateLimitWindowMs: 60_000,
  circuitFailureThreshold: 3,
  circuitBaseBackoffMs: 30_000,
  circuitMaxBackoffMs: 300_000,
};
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 300;
const sharedReliability = new AiReliabilityController();

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

const PROGRAM_ANSWER_LATIN =
  'Kursda kamera turlari, kabel tortish, DVR/NVR sozlash, IP tarmoq, telefon orqali ko‘rish va nosozliklarni topishni amaliy o‘rganasiz.';
const PROGRAM_ANSWER_CYRILLIC =
  'Курсда камера турлари, кабель тортиш, DVR/NVR созлаш, IP тармоқ, телефон орқали кўриш ва носозликларни топишни амалий ўрганасиз.';

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

export async function answerWithAiAgent(message: string, config: AiConfig, context: AiRequestContext = {}): Promise<AiAgentResult> {
  const scored = scoreLead(message);
  const cyrillic = hasCyrillic(message);

  if (asksGuaranteedJob(message)) {
    return { answer: cyrillic ? GUARANTEED_JOB_ANSWER_CYRILLIC : GUARANTEED_JOB_ANSWER_LATIN, ...scored };
  }

  if (asksPrice(message)) {
    return { answer: cyrillic ? PRICE_ANSWER_CYRILLIC : PRICE_ANSWER_LATIN, ...scored };
  }

  if (asksProgram(message)) {
    return { answer: cyrillic ? PROGRAM_ANSWER_CYRILLIC : PROGRAM_ANSWER_LATIN, ...scored };
  }

  if (isUnrelatedTopic(message)) {
    return { answer: cyrillic ? UNRELATED_ANSWER_CYRILLIC : UNRELATED_ANSWER_LATIN, ...scored };
  }

  if (!config.enabled || !config.apiKey || !config.baseUrl || !config.model) {
    throw new Error('AI agent is not fully configured.');
  }

  const reliability = context.reliability ?? sharedReliability;
  const controls = normalizeReliability(config.reliability);
  reliability.consumeRateLimit(context.actorId, providerIdentity(config), controls);

  try {
    const answer = await requestProvider(message, cyrillic, config, reliability, controls);
    return { answer, ...scored };
  } catch (primaryError) {
    if (!isProviderReady(config.fallback)) throw primaryError;

    try {
      const answer = await requestProvider(message, cyrillic, config.fallback, reliability, controls);
      return { answer, ...scored };
    } catch {
      throw new Error('Primary and fallback AI providers are unavailable.');
    }
  }
}

async function requestProvider(message: string, cyrillic: boolean, config: AiProviderConfig, reliability: AiReliabilityController, controls: AiReliabilityControls): Promise<string> {
  if (!isProviderReady(config)) {
    throw new Error('AI provider is not fully configured.');
  }

  const identity = providerIdentity(config);
  const attempt = reliability.beforeProvider(identity);
  const requestBody: Record<string, unknown> = {
    model: config.model,
    temperature: config.temperature,
    messages: [
      { role: 'system', content: buildSystemPrompt(cyrillic) },
      { role: 'user', content: message },
    ],
  };
  if (config.supportsMaxOutputTokens !== false) {
    requestBody.max_tokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  // DeepSeek V4 defaults to thinking mode. A short Telegram sales reply does
  // not need chain-of-thought; disabling it reduces latency/cost and ensures
  // the final answer is returned in the OpenAI-compatible `content` field.
  if (isDeepSeekBaseUrl(config.baseUrl)) {
    requestBody.thinking = { type: 'disabled' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      reliability.finishProvider(identity, attempt, 'timeout', controls);
      throw new Error('AI provider request timed out.');
    }
    reliability.finishProvider(identity, attempt, 'network_error', controls);
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    reliability.finishProvider(identity, attempt, 'http_error', controls);
    throw new Error(`AI provider returned ${response.status}`);
  }

  let data: { choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    reliability.finishProvider(identity, attempt, 'empty_response', controls);
    throw new Error('AI provider returned an invalid response.');
  }
  const answer = formatAiAnswer(data.choices?.[0]?.message?.content);

  if (!answer) {
    reliability.finishProvider(identity, attempt, 'empty_response', controls, tokenUsage(data.usage));
    throw new Error('AI provider returned an empty answer.');
  }

  reliability.finishProvider(identity, attempt, 'success', controls, tokenUsage(data.usage));
  return answer;
}

export function getTruthfulFallbackAnswer(message = ''): string {
  return hasCyrillic(message)
    ? `AI жавоби ҳозир мавжуд эмас. Операторга ${courseInfo.operator} орқали ёзинг ёки “Operator bilan bog‘lanish” тугмасини босинг. Бу хабар операторга ариза юборилганини англатмайди.`
    : `AI javobi hozir mavjud emas. Operatorga ${courseInfo.operator} orqali yozing yoki “Operator bilan bog‘lanish” tugmasini bosing. Bu xabar operatorga ariza yuborilganini anglatmaydi.`;
}

export function getAiReliabilitySnapshot() { return sharedReliability.snapshot(); }
export function resetAiReliabilityState(): void { sharedReliability.reset(); }

export function getPhoneRequestAnswer(message: string): string {
  return hasCyrillic(message) ? PHONE_REQUEST_ANSWER_CYRILLIC : PHONE_REQUEST_ANSWER;
}


export function getUnrelatedTopicAnswer(message: string): string {
  return hasCyrillic(message) ? UNRELATED_ANSWER_CYRILLIC : UNRELATED_ANSWER_LATIN;
}

export function isAiReady(config: AiConfig): boolean {
  return Boolean(config.enabled && isProviderReady(config));
}

function isProviderReady(config?: AiProviderConfig): config is AiProviderConfig & Required<Pick<AiProviderConfig, 'apiKey' | 'baseUrl' | 'model'>> {
  return Boolean(config?.apiKey && config.baseUrl && config.model);
}

export function isCallRequest(message: string): boolean {
  return CALL_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

export function extractPhoneNumber(message: string): string | undefined {
  const match = message.match(PHONE_PATTERN)?.[0].trim();
  if (!match) return undefined;

  const digits = match.replace(/\D/g, '');
  if (digits.length === 9 || (digits.length === 12 && digits.startsWith('998'))) return match;

  return undefined;
}

export function isCallRequestCancel(message: string): boolean {
  return /\b(bekor|yo['‘’`]?q|keyin|hozir\s+emas)\b/i.test(message) || /\b(кейин|хозир\s+эмас|ҳозир\s+эмас|йўқ|йук|бекор)\b/i.test(message);
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

function asksProgram(message: string): boolean {
  return /\b(dastur|programma|nima\s+o['‘’`]?rgan|nimalarni\s+o['‘’`]?rgan|yana\s+nimalarni|kamera|dvr|nvr|ip\s+tarmoq|kabel|nosozlik)\b/i.test(message) || /\b(дастур|программа|нима\s+ўрган|нималарни\s+ўрган|камера|кабель|носозлик)\b/i.test(message);
}

function formatAiAnswer(answer?: string | null): string | undefined {
  return answer
    ?.replace(/UZS/gi, 'so‘m')
    .replace(/[*_#]/g, '')
    .trim();
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com');
  } catch {
    return false;
  }
}

function normalizeReliability(value: Partial<AiReliabilityControls> | undefined): AiReliabilityControls {
  return { ...DEFAULT_AI_RELIABILITY, ...value };
}

function providerIdentity(config: AiProviderConfig): AiProviderIdentity {
  let provider = 'openai_compatible';
  try {
    const hostname = new URL(config.baseUrl ?? '').hostname.toLowerCase();
    if (hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com')) provider = 'deepseek';
    else if (hostname === 'dashscope.aliyuncs.com' || hostname.endsWith('.dashscope.aliyuncs.com') || hostname.endsWith('.maas.aliyuncs.com')) provider = 'qwen';
  } catch { /* A malformed URL is rejected by fetch without being logged. */ }
  return { provider, model: config.model || 'unconfigured' };
}

function tokenUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): AiTokenUsage | undefined {
  if (!usage) return undefined;
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
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
    `Rejalashtirilgan start: ${courseInfo.plannedStart}. Qabulga qarab 1–2 kun siljishi mumkin.`,
    `Dars kunlari: ${courseInfo.schedule}.`,
    `Vaqt oralig‘i: ${courseInfo.lessonWindow}.`,
    `Manzil: ${courseInfo.location}.`,
    `Narx: ${courseInfo.price}.`,
    `Bo‘lib to‘lash: ${courseInfo.installment}.`,
    `Kanal: ${courseInfo.channel}.`,
    `Operator: ${courseInfo.operator}.`,
    `Telefon: ${courseInfo.phone}.`,
    'Dastur: kamera turlari, kabel tortish, DVR/NVR sozlash, IP tarmoq, telefon orqali ko‘rish, nosozliklarni topish.',
    'Natija: sertifikat va ishga yo‘naltirish.',
    'Ish kafolatlanadi deb hech qachon va’da bermang. “ishga yo‘naltirish” iborasidan foydalaning.',
    'Agar foydalanuvchi qo‘ng‘iroq so‘rasa, telefon raqamini yuborishini so‘rang va operator bog‘lanishini ayting.',
    'Agar foydalanuvchi qiziqsa, “Ro‘yxatdan o‘tish” tugmasini bosishni taklif qiling.',
    `Operator so‘ralsa, ${courseInfo.operator} va ${courseInfo.phone} ni ko‘rsating.`,
  ].join('\n');
}
