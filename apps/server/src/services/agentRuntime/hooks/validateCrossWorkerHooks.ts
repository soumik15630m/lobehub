import type { AgentHook } from './types';

/** Fail before dispatching work whose callback cannot survive the process boundary. */
export function validateCrossWorkerHooks(hooks: AgentHook[] = []): void {
  for (const hook of hooks) {
    if (hook.handler) {
      throw new Error(
        'Cross-worker operations require webhook hooks; handler functions cannot be transferred',
      );
    }
    if (
      hook.webhook?.delivery === 'qstash' &&
      hook.webhook.fallback === 'none' &&
      !process.env.QSTASH_TOKEN
    ) {
      throw new Error('QSTASH_TOKEN is required for cross-worker hooks with fallback:none');
    }
  }
}
