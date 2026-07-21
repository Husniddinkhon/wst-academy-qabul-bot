export const APPLICANT_LIMITS = {
  name: 100,
  region: 120,
  freeText: 500,
  message: 4_096,
  filename: 120,
  email: 254,
} as const;

export const APPLICANT_REQUIRED_FIELDS = ['fullName', 'phone', 'age', 'region', 'program'] as const;
export const APPLICANT_OPTIONAL_FIELDS = ['experience', 'preferredTime', 'notes', 'email'] as const;
export const APPLICANT_PROHIBITED_FIELDS = ['passport', 'passportNumber', 'paymentCard', 'cardNumber', 'credential', 'password', 'medical', 'biometric'] as const;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const MARKUP_INJECTION = /<\/?[a-z][^>]*>|\[[^\]]+\]\([^)]*\)|```|`[^`]+`/iu;
const COMMAND_INJECTION = /(?:\$\(|`|\|\||&&|\r|\n)/u;
const SAFE_NAME = /^[\p{L}\p{M}][\p{L}\p{M} '\u2018\u2019-]*[\p{L}\p{M}]$/u;
const SAFE_REGION = /^[\p{L}\p{M}\p{N} .,'\u2018\u2019()-]+$/u;
const SAFE_FILENAME = /^[\p{L}\p{M}\p{N}_. -]+$/u;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function normalizeApplicantText(value: string): string {
  return value.normalize('NFKC').trim().replace(/[ \t]+/g, ' ');
}

export function validateApplicantName(value: string): ValidationResult<string> {
  const normalized = normalizeApplicantText(value);
  if (normalized.length < 2 || normalized.length > APPLICANT_LIMITS.name) return invalid('name_length', `Ism 2-${APPLICANT_LIMITS.name} belgi bo\u2018lishi kerak.`);
  if (CONTROL_OR_FORMAT.test(normalized) || !SAFE_NAME.test(normalized)) return invalid('name_characters', 'Ismda faqat harflar, bo\u2018sh joy, apostrof va chiziqcha ishlating.');
  return valid(normalized);
}

export function validateApplicantAge(value: string): ValidationResult<string> {
  const normalized = normalizeApplicantText(value);
  if (!/^\d{2}$/.test(normalized)) return invalid('age_format', 'Yoshni 16 dan 80 gacha butun son bilan kiriting.');
  const age = Number(normalized);
  if (age < 16 || age > 80) return invalid('age_range', 'Yosh 16 dan 80 gacha bo\u2018lishi kerak.');
  return valid(String(age));
}

export function normalizeUzbekPhone(value: string): ValidationResult<string> {
  const normalized = value.normalize('NFKC').replace(/[\s().-]/g, '');
  if (CONTROL_OR_FORMAT.test(normalized)) return invalid('phone_control', 'Telefon raqamida yashirin belgilar bo\u2018lmasligi kerak.');
  const canonical = normalized.startsWith('+') ? normalized : normalized.startsWith('998') ? `+${normalized}` : '';
  if (!/^\+998\d{9}$/.test(canonical)) return invalid('phone_format', 'Telefon raqamini +998XXXXXXXXX formatida yuboring.');
  return valid(canonical);
}

export function validateApplicantEmail(value: string): ValidationResult<string> {
  const normalized = normalizeApplicantText(value).toLowerCase();
  if (normalized.length > APPLICANT_LIMITS.email || CONTROL_OR_FORMAT.test(normalized) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    return invalid('email_format', 'Email manzil noto\u2018g\u2018ri.');
  }
  return valid(normalized);
}

export function validateRegion(value: string): ValidationResult<string> {
  const normalized = normalizeApplicantText(value);
  if (normalized.length < 2 || normalized.length > APPLICANT_LIMITS.region) return invalid('region_length', `Hudud 2-${APPLICANT_LIMITS.region} belgi bo\u2018lishi kerak.`);
  if (CONTROL_OR_FORMAT.test(normalized) || !SAFE_REGION.test(normalized)) return invalid('region_characters', 'Hudud nomida ruxsat etilmagan belgilar bor.');
  return valid(normalized);
}

export function validateFreeText(value: string, options: { required?: boolean; maxLength?: number } = {}): ValidationResult<string> {
  const normalized = normalizeApplicantText(value);
  const max = options.maxLength ?? APPLICANT_LIMITS.freeText;
  if (options.required && !normalized) return invalid('text_required', 'Bu maydonni to\u2018ldiring.');
  if (normalized.length > max) return invalid('text_length', `Matn ${max} belgidan oshmasligi kerak.`);
  if (CONTROL_OR_FORMAT.test(normalized)) return invalid('text_control', 'Matnda boshqaruv yoki yashirin belgilar bo\u2018lmasligi kerak.');
  if (MARKUP_INJECTION.test(normalized)) return invalid('text_markup', 'Matnda markup yoki havola kodi qabul qilinmaydi.');
  if (COMMAND_INJECTION.test(normalized)) return invalid('text_command', 'Matnda buyruq operatorlari qabul qilinmaydi.');
  return valid(normalized);
}

export function validateApplicantMessage(value: string): ValidationResult<string> {
  return validateFreeText(value, { required: true, maxLength: APPLICANT_LIMITS.message });
}

export function validateProgram(value: string, allowed: readonly string[]): ValidationResult<string> {
  const normalized = normalizeApplicantText(value).toLowerCase();
  return allowed.includes(normalized) ? valid(normalized) : invalid('program_not_allowed', 'Kursni berilgan variantlardan tanlang.');
}

export function validateUpload(filename: string, mimeType: string): ValidationResult<{ filename: string; mimeType: string }> {
  const normalized = normalizeApplicantText(filename);
  if (!normalized || normalized.length > APPLICANT_LIMITS.filename || normalized === '.' || normalized === '..') return invalid('filename_length', 'Fayl nomi noto\u2018g\u2018ri.');
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('..') || pathLooksAbsolute(normalized) || CONTROL_OR_FORMAT.test(normalized) || !SAFE_FILENAME.test(normalized)) return invalid('filename_path', 'Fayl nomida yo\u2018l yoki ruxsat etilmagan belgilar bor.');
  const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
  const allowed: Record<string, readonly string[]> = {
    '.pdf': ['application/pdf'],
    '.png': ['image/png'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
  };
  if (!allowed[extension]?.includes(mimeType.toLowerCase())) return invalid('file_type', 'Fayl turi yoki kengaytmasi ruxsat etilmagan.');
  return valid({ filename: normalized, mimeType: mimeType.toLowerCase() });
}

export function maskPhone(value: string | undefined): string {
  if (!value) return '\u2014';
  const digits = value.replace(/\D/g, '');
  return digits.length < 4 ? '***' : `+${digits.slice(0, 3)} ** *** ** ${digits.slice(-2)}`;
}

export function enforceApplicantDataMinimization(input: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  const prohibited = APPLICANT_PROHIBITED_FIELDS.find((key) => key in input);
  if (prohibited) return invalid('prohibited_field', `Yuqori xavfli ${prohibited} maydonini yig\u2018ish taqiqlangan.`);
  const allowed = new Set<string>([...APPLICANT_REQUIRED_FIELDS, ...APPLICANT_OPTIONAL_FIELDS]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) return invalid('unknown_field', `Ruxsat etilmagan ${unknown} maydoni qabul qilinmaydi.`);
  const missing = APPLICANT_REQUIRED_FIELDS.find((key) => input[key] === undefined || input[key] === '');
  if (missing) return invalid('required_field', `${missing} maydoni majburiy.`);
  return valid(input);
}

function pathLooksAbsolute(value: string): boolean { return /^[a-z]:/iu.test(value) || value.startsWith('~'); }
function valid<T>(value: T): ValidationResult<T> { return { ok: true, value }; }
function invalid(code: string, message: string): ValidationResult<never> { return { ok: false, code, message }; }
