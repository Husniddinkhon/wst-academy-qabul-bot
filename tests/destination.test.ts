import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { courseInfo, formatCourseIntro, formatLocationAndSchedule, formatPrivacyInfo } from '../src/course.js';

test('start destination exposes paid terms and verified logistics', () => {
  const text = formatCourseIntro();
  for (const expected of ['1 oy', '12 ta dars', 'offline', 'real uskunalarda', '2 500 000 so‘m', '1 500 000 so‘m', '2026-08-04', 'Toshkent shahri, Arnasoy ko‘chasi, 33-uy', '10:00–16:00', 'Operator:', 'Telefon:']) assert.match(text, new RegExp(expected));
  assert.match(text, /1–2 kun siljishi mumkin/i);
  assert.match(text, /guruh talabiga qarab belgilanadi/i);
  assert.match(text, /6 soat uzluksiz dars degani emas/i);
  assert.match(text, /ishga joylashish kafolatlanmaydi/i);
  assert.match(text, /shaxsiy ma’lumot yuborish shart emas/i);
});

test('location and schedule avoid unsupported fixed-day or continuous-class claims', () => {
  const text = formatLocationAndSchedule();
  assert.equal(courseInfo.location, 'Toshkent shahri, Arnasoy ko‘chasi, 33-uy');
  assert.equal(courseInfo.plannedStart, '2026-08-04');
  assert.match(text, /Qabul holatiga qarab.*1–2 kun siljishi mumkin/i);
  assert.doesNotMatch(text, /haftasiga 3 kun|dushanba|seshanba|chorshanba|payshanba|juma|shanba/i);
  assert.doesNotMatch(text, /6 soatlik dars|10:00 dan 16:00 gacha uzluksiz/i);
});

test('privacy text makes registration optional and explains fields and purpose', () => {
  const text = formatPrivacyInfo();
  assert.match(text, /Ro‘yxatdan o‘tish ixtiyoriy/i);
  assert.match(text, /ism-familiya, telefon, yosh, hudud, tajriba/i);
  assert.match(text, /faqat arizani ko‘rib chiqish, siz bilan bog‘lanish/i);
  assert.match(text, /Ma’lumot yubormasdan/i);
});

test('AI prompt contains verified logistics and no stale fixed-day claim', async () => {
  const source = await readFile(new URL('../src/aiAgent.ts', import.meta.url), 'utf8');
  assert.match(source, /courseInfo\.plannedStart/);
  assert.match(source, /courseInfo\.lessonWindow/);
  assert.match(source, /courseInfo\.location/);
  assert.doesNotMatch(source, /haftasiga 3 kun/i);
});
