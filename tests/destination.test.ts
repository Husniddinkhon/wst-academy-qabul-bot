import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCourseIntro, formatLocationAndSchedule, formatPrivacyInfo } from '../src/course.js';

test('start destination exposes paid-course terms and practical access details', () => {
  const text = formatCourseIntro();
  for (const expected of ['1 oy', '12 ta dars', 'offline', '2 500 000 so‘m', '1 500 000 so‘m', 'haftasiga 3 kun', 'Manzil:', 'Operator:', 'Telefon:']) {
    assert.match(text, new RegExp(expected));
  }
  assert.match(text, /ishga joylashish kafolatlanmaydi/i);
  assert.match(text, /shaxsiy ma’lumot yuborish shart emas/i);
});

test('location disclosure is honest when exact address is not configured', () => {
  const text = formatLocationAndSchedule();
  assert.match(text, /aniq o‘quv manzili.*operator tomonidan tasdiqlanadi/i);
  assert.match(text, /haftasiga 3 kun/i);
});

test('privacy text makes registration optional and explains fields and purpose', () => {
  const text = formatPrivacyInfo();
  assert.match(text, /Ro‘yxatdan o‘tish ixtiyoriy/i);
  assert.match(text, /ism-familiya, telefon, yosh, hudud, tajriba/i);
  assert.match(text, /faqat arizani ko‘rib chiqish, siz bilan bog‘lanish/i);
  assert.match(text, /Ma’lumot yubormasdan/i);
});
