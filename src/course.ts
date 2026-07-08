import dotenv from 'dotenv';

dotenv.config();

export const courseInfo = {
  title: 'WST Academy “0 dan ustagacha” videokuzatuv kursi',
  duration: '1 oy',
  lessons: '12 ta dars',
  format: 'offline amaliy kurs',
  price: '2 500 000 so‘m',
  installment: '1 500 000 so‘m avval, qolgan qismi 1-hafta oxirigacha',
  benefits: 'sertifikat va ishga yo‘naltirish bo‘yicha maslahat',
  channel: 'https://t.me/wstacademy_uz',
  operator: process.env.OPERATOR_USERNAME || '@hr_wst',
  phone: process.env.OPERATOR_PHONE || '+998333011511',
} as const;

export function formatCourseIntro(): string {
  return [
    `👋 Assalomu alaykum! ${courseInfo.title}ga qabul botiga xush kelibsiz.`,
    '',
    '📌 Kurs haqida:',
    `• Davomiyligi: ${courseInfo.duration}`,
    `• Darslar: ${courseInfo.lessons}`,
    `• Format: ${courseInfo.format}`,
    `• Narx: ${courseInfo.price}`,
    `• Bo‘lib to‘lash: ${courseInfo.installment}`,
    `• Yakunda: ${courseInfo.benefits}`,
    '',
    '⚠️ Eslatma: ishga joylashish kafolatlanmaydi, lekin yo‘nalish va tayyorgarlik bo‘yicha yordam beriladi.',
    '',
    `📣 Kanal: ${courseInfo.channel}`,
    `👨‍💼 Operator: ${courseInfo.operator}`,
    `📞 Telefon: ${courseInfo.phone}`,
  ].join('\n');
}
