'use strict';

const DROP_ALL_GLOBAL_ENV = true;

const FORBIDDEN_ENV_EXACT = Object.freeze([
  'ACADEMY_DATABASE_URL',
  'ACADEMY_JWT_SECRET',
  'AI_API_KEY',
  'AI_FALLBACK_API_KEY',
  'ALLOWED_HOSTS',
  'BOT_TOKEN',
  'DATABASE_URL',
  'ENVIRONMENT',
  'JWT_SECRET',
  'LEAD_WEBHOOK_SECRET',
  'POSTGRES_PASSWORD',
  'SECRET_KEY',
  'TRUSTED_HOSTS',
]);

const FORBIDDEN_ENV_PREFIXES = Object.freeze([
  'ACADEMY_',
  'DATABASE_',
  'ENVIRONMENT_',
  'JWT_',
  'PORTAL_',
  'POSTGRES_',
  'TRUSTED_',
  'WST_ACADEMY_',
]);

const SENSITIVE_NAME_PARTS = Object.freeze([
  '_API_KEY',
  '_PASSWORD',
  '_PRIVATE_KEY',
  '_SECRET',
  '_TOKEN',
]);

function isForbiddenEnvName(name) {
  return FORBIDDEN_ENV_EXACT.includes(name)
    || FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    || SENSITIVE_NAME_PARTS.some((part) => name.includes(part));
}

module.exports = {
  DROP_ALL_GLOBAL_ENV,
  FORBIDDEN_ENV_EXACT,
  FORBIDDEN_ENV_PREFIXES,
  SENSITIVE_NAME_PARTS,
  isForbiddenEnvName,
};
