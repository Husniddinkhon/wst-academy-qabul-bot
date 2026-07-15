import type { AppConfig } from './config.js';

export interface SafeLaunchOptions {
  dropPendingUpdates: false;
}

export function getBotLaunchOptions(_config: Pick<AppConfig, 'isProduction'>): SafeLaunchOptions {
  return { dropPendingUpdates: false };
}
