export const courseInfo = {
  title: 'WST Academy “0 dan ustagacha” videokuzatuv kursi',
  duration: '1 oy',
  lessons: '12 ta dars',
  format: 'offline amaliy kurs',
  price: '2 500 000 UZS',
  installment: '1 500 000 UZS avval, qolgan summa 1-hafta oxirigacha',
  benefits: 'sertifikat va ishga yo‘naltirish bo‘yicha maslahat',
  channel: 'https://t.me/wstacademy_uz',
  operator: '@hr_wst',
  phone: '+998 33 301 15 11',
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
