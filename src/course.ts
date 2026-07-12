import dotenv from 'dotenv';

dotenv.config();

export const courseInfo = {
  title: 'WST Academy “0 dan ustagacha” videokuzatuv kursi',
  duration: '1 oy',
  lessons: '12 ta dars',
  format: 'offline amaliy kurs',
  schedule: 'haftasiga 3 kun; aniq kun va vaqt guruh shakllanganda operator bilan kelishiladi',
  location: process.env.COURSE_LOCATION || 'aniq o‘quv manzili guruh tanlanganda operator tomonidan tasdiqlanadi',
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
    `• Jadval: ${courseInfo.schedule}`,
    `• Manzil: ${courseInfo.location}`,
    `• Narx: ${courseInfo.price}`,
    `• Bo‘lib to‘lash: ${courseInfo.installment}`,
    `• Yakunda: ${courseInfo.benefits}`,
    '',
    '⚠️ Eslatma: ishga joylashish kafolatlanmaydi, lekin yo‘nalish va tayyorgarlik bo‘yicha yordam beriladi.',
    '',
    `📣 Kanal: ${courseInfo.channel}`,
    `👨‍💼 Operator: ${courseInfo.operator}`,
    `📞 Telefon: ${courseInfo.phone}`,
    '',
    '🔐 Kurs ma’lumotlarini ko‘rish uchun shaxsiy ma’lumot yuborish shart emas. Ro‘yxatdan o‘tish ixtiyoriy.',
  ].join('\n');
}

export function formatLocationAndSchedule(): string {
  return [
    '📍 Manzil va jadval',
    '',
    `Format: ${courseInfo.format}.`,
    `Jadval: ${courseInfo.schedule}.`,
    `Manzil: ${courseInfo.location}.`,
    '',
    `Aniqlashtirish uchun operator: ${courseInfo.operator}`,
    `Telefon: ${courseInfo.phone}`,
  ].join('\n');
}

export function formatPrivacyInfo(): string {
  return [
    '🔐 Maxfiylik va ma’lumotlardan foydalanish',
    '',
    'Kurs haqida ma’lumot olish uchun ism yoki telefon yuborish shart emas.',
    'Ro‘yxatdan o‘tish ixtiyoriy. Arizada ism-familiya, telefon, yosh, hudud, tajriba va qulay dars vaqti so‘raladi.',
    'Bu ma’lumotlar faqat arizani ko‘rib chiqish, siz bilan bog‘lanish va mos guruhni taklif qilish uchun ishlatiladi.',
    'Ma’lumot yubormasdan menyu orqali kurs dasturi, narx, jadval va aloqa ma’lumotlarini ko‘rishingiz mumkin.',
    `Savol yoki ma’lumotni yangilash bo‘yicha operator: ${courseInfo.operator}, ${courseInfo.phone}.`,
  ].join('\n');
}

export function formatCourseProgram(): string {
  return [
    '📚 Kurs dasturi',
    '',
    '• Videokuzatuv tizimining asosiy qismlari',
    '• Analog va IP kameralarni tanlash va ulash',
    '• DVR va NVR qurilmalarini sozlash',
    '• Kabel, quvvat va tarmoq bilan ishlash',
    '• Masofadan kuzatishni sozlash',
    '• Nosozliklarni aniqlash va bartaraf etish',
    '• Real uskunalarda amaliy mashg‘ulotlar',
    '',
    `Davomiyligi: ${courseInfo.duration}, ${courseInfo.lessons}.`,
  ].join('\n');
}

export function formatPriceInfo(): string {
  return [
    '💳 Narx va to‘lov',
    '',
    `Kurs narxi: ${courseInfo.price}.`,
    `Bo‘lib to‘lash: ${courseInfo.installment}.`,
    '',
    'Ro‘yxatdan o‘tish tugmasi orqali ariza qoldirishingiz mumkin.',
  ].join('\n');
}
