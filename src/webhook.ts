import type { Lead } from './types.js';

export async function sendLeadWebhook(webhookUrl: string | undefined, lead: Lead): Promise<void> {
  if (!webhookUrl) return;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ lead }),
  });

  if (!response.ok) {
    throw new Error(`Lead webhook failed with status ${response.status}`);
  }
}
