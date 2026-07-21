import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enforceApplicantDataMinimization, maskPhone, normalizeApplicantText, normalizeUzbekPhone, validateApplicantAge,
  validateApplicantEmail, validateApplicantMessage, validateApplicantName, validateFreeText, validateProgram,
  validateRegion, validateUpload,
} from '../src/applicantValidation.js';

test('normalizes Unicode without silently truncating material input', () => {
  assert.equal(normalizeApplicantText('  Ａli   Valiyev  '), 'Ali Valiyev');
  assert.equal(validateApplicantName('O\u2018tkir Yoqubov').ok, true);
  assert.equal(validateApplicantName(`A${'b'.repeat(100)}`).ok, false);
});

test('validates bounded age, region, email and allowlisted program values', () => {
  assert.deepEqual(validateApplicantAge('25'), { ok: true, value: '25' });
  assert.equal(validateApplicantAge('15').ok, false);
  assert.equal(validateApplicantAge('25 years').ok, false);
  assert.equal(validateRegion('Toshkent shahri').ok, true);
  assert.equal(validateRegion('Toshkent\u0000').ok, false);
  assert.equal(validateApplicantEmail('Talaba@example.uz').ok, true);
  assert.equal(validateApplicantEmail('bad@local').ok, false);
  assert.equal(validateProgram('CCTV', ['cctv', 'networking']).ok, true);
  assert.equal(validateProgram('unknown', ['cctv']).ok, false);
});

test('normalizes only valid Uzbek phones and never treats text as ownership proof', () => {
  assert.deepEqual(normalizeUzbekPhone('998 90 123-45-67'), { ok: true, value: '+998901234567' });
  assert.equal(normalizeUzbekPhone('+99890123').ok, false);
  assert.equal(normalizeUzbekPhone('+1 202 555 0100').ok, false);
  assert.equal(maskPhone('+998901234567'), '+998 ** *** ** 67');
});

test('rejects control characters, markup and command operators', () => {
  assert.equal(validateFreeText('Oddiy xavfsiz javob', { required: true }).ok, true);
  assert.equal(validateApplicantMessage('x\u0000y').ok, false);
  assert.equal(validateFreeText('<script>alert(1)</script>').ok, false);
  assert.equal(validateFreeText('[link](https://evil.invalid)').ok, false);
  assert.equal(validateFreeText('hello && shutdown').ok, false);
  assert.equal(validateFreeText('x'.repeat(501)).ok, false);
});

test('rejects traversal filenames and MIME-extension mismatches', () => {
  assert.equal(validateUpload('application.pdf', 'application/pdf').ok, true);
  assert.equal(validateUpload('../secret.pdf', 'application/pdf').ok, false);
  assert.equal(validateUpload('C:\\secret.pdf', 'application/pdf').ok, false);
  assert.equal(validateUpload('photo.jpg', 'application/pdf').ok, false);
  assert.equal(validateUpload('payload.exe', 'application/octet-stream').ok, false);
});

test('enforces required, optional and prohibited applicant fields', () => {
  const allowed = { fullName: 'Ali Valiyev', phone: '+998901234567', age: '25', region: 'Toshkent', program: 'cctv', notes: 'yo\u2018q' };
  assert.equal(enforceApplicantDataMinimization(allowed).ok, true);
  assert.equal(enforceApplicantDataMinimization({ ...allowed, passportNumber: 'AA123' }).ok, false);
  assert.equal(enforceApplicantDataMinimization({ ...allowed, unknownTracking: 'x' }).ok, false);
  assert.equal(enforceApplicantDataMinimization({ ...allowed, phone: '' }).ok, false);
});
