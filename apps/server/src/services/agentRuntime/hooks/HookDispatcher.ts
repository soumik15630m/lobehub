import type { ToolCallPreparation, ToolRunResult } from '@lobechat/agent-runtime';
import type { SerializedAgentHook } from '@lobechat/types';
import {
  agentHookMatcherSchema,
  agentHookTypeSchema,
  resolveToolCallHookErrorPolicy,
  serializedAgentHookSchema,
} from '@lobechat/types';
import debug from 'debug';

import { deliverWebhook, executeToolCallWebhook } from './httpWebhook';
import { matchesHook } from './matcher';
import type {
  AgentHook,
  AgentHookEvent,
  AgentHookType,
  AnyHookEvent,
  SerializedHook,
  ToolCallHookEvent,
} from './types';

const log = debug('lobe-server:hook-dispatcher');

export class CriticalHookDeliveryError extends Error {
  constructor(
    public readonly hookId: string,
    public readonly cause: unknown,
  ) {
    super(`Critical webhook delivery failed: ${hookId}`, { cause });
    this.name = 'CriticalHookDeliveryError';
  }
}

export { deliverWebhook } from './httpWebhook';

/** Validate persisted configurations on every worker restore. */
export function parseSerializedHooks(hooks: SerializedAgentHook[]): SerializedHook[] {
  const parsed = hooks.map((hook) => serializedAgentHookSchema.parse(hook));
  assertUniqueHookIds(parsed);
  return parsed;
}

function assertUniqueHookIds(hooks: { id: string }[]): void {
  const seen = new Set<string>();
  for (const hook of hooks) {
    if (seen.has(hook.id)) throw new Error(`Duplicate hook id: ${hook.id}`);
    seen.add(hook.id);
  }
}

function buildWebhookPayload(event: AnyHookEvent, eventFields?: string[]): Record<string, unknown> {
  if (eventFields) {
    const payload: Record<string, unknown> = {};
    for (const field of eventFields) {
      if (field === 'finalState') continue;
      if (field in event) payload[field] = (event as unknown as Record<string, unknown>)[field];
    }
    return payload;
  }

  const payload = { ...event };
  if ('mock' in payload) delete (payload as { mock?: unknown }).mock;
  if ('finalState' in payload) {
    delete (payload as { finalState?: unknown }).finalState;
  }
  return payload;
}

/**
 * HookDispatcher — central hub for registering and dispatching agent lifecycle hooks
 *
 * Each hook has one explicit target: an in-process handler or a webhook.
 * Webhooks persist in AgentState.host.hooks and can be restored by any worker.
 */
export class HookDispatcher {
  /** Durable webhooks are authoritative; process callbacks are never serialized. */
  private resolveHooks(operationId: string, serializedHooks?: SerializedAgentHook[]): AgentHook[] {
    const registered = this.hooks.get(operationId) ?? [];
    if (serializedHooks === undefined) return registered;
    // Cross-field schema validation narrows the control/notification union.
    const restored = parseSerializedHooks(serializedHooks) as AgentHook[];
    const hooks = [...restored, ...registered.filter((hook) => hook.handler)];
    assertUniqueHookIds(hooks);
    return hooks;
  }

  getContinuationHooks(
    operationId: string,
    serializedHooks?: SerializedAgentHook[],
    includeProcessHandlers = true,
  ): AgentHook[] {
    const hooks = this.resolveHooks(operationId, serializedHooks);
    return includeProcessHandlers ? hooks : hooks.filter((hook) => hook.webhook);
  }
  /**
   * In-memory registrations for the current process
   * Maps operationId → AgentHook[]
   */
  private hooks: Map<string, AgentHook[]> = new Map();

  /**
   * Dispatch hooks for a given event type
   *
   * Calls process handlers and delivers configured webhooks, independent of scheduling.
   */
  async dispatch(
    operationId: string,
    type: AgentHookType,
    event: AnyHookEvent,
    /**
     * Hooks persisted on `state.host.hooks` (wire shape). Narrowed here to the
     * runtime-precise {@link SerializedHook} once the type / webhook are checked.
     */
    serializedHooks?: SerializedAgentHook[],
  ): Promise<void> {
    return this.dispatchHooks(operationId, type, event, serializedHooks);
  }

  private async dispatchHooks(
    operationId: string,
    type: AgentHookType,
    event: AnyHookEvent,
    serializedHooks?: SerializedAgentHook[],
    stopAfterHandler?: () => boolean,
  ): Promise<void> {
    const hooks = this.resolveHooks(operationId, serializedHooks);
    let criticalError: CriticalHookDeliveryError | undefined;
    for (const hook of hooks.filter(
      (h) =>
        h.type === type &&
        h.webhook?.responseHandling !== 'toolCall' &&
        matchesHook(h.matcher, event),
    )) {
      const handler = hook.handler;
      const useHandler = !!handler;
      // Preserve first-mock handler semantics without dropping independent HTTP callbacks.
      if (useHandler && stopAfterHandler?.()) continue;
      try {
        if (useHandler) {
          await handler(event as AgentHookEvent);
        } else if (hook.webhook) {
          await deliverWebhook(hook.webhook, {
            ...buildWebhookPayload(event, hook.webhook.eventFields),
            hookId: hook.id,
            hookType: type,
            ...hook.webhook.body,
          });
        }
      } catch (error) {
        if (!useHandler && hook.webhook?.fallback === 'none') {
          console.error(
            '[HookDispatcher] Critical webhook delivery failed',
            { operationId, hookId: hook.id, hookType: type },
            error,
          );
          criticalError ??= new CriticalHookDeliveryError(hook.id, error);
        } else if (!useHandler) {
          console.error(
            '[HookDispatcher] Webhook delivery failed (non-fatal)',
            { operationId, hookId: hook.id, hookType: type },
            error,
          );
        } else {
          log('[%s][%s] Hook failed (non-fatal): %s', operationId, type, hook.id);
        }
      }
    }
    // Independent critical callbacks all get a chance to run before surfacing the failure.
    if (criticalError) throw criticalError;
  }

  /** Ordered synchronous controls. Cancellation never goes through onError. */
  async prepareToolCall(
    operationId: string,
    event: Omit<ToolCallHookEvent, 'mock'>,
    serializedHooks?: SerializedAgentHook[],
    signal?: AbortSignal,
  ): Promise<ToolCallPreparation> {
    const originalArgs = structuredClone(event.originalArgs ?? event.args);
    const ready: ToolCallPreparation = {
      originalArgs,
      additionalContexts: [],
      status: 'ready',
    };
    const hooks = this.resolveHooks(operationId, serializedHooks);
    for (const hook of hooks) {
      if (signal?.aborted) return { originalArgs, status: 'cancelled' };
      if (
        hook.type !== 'beforeToolCall' ||
        hook.webhook?.responseHandling !== 'toolCall' ||
        !matchesHook(hook.matcher, event)
      )
        continue;
      const response = await executeToolCallWebhook(
        hook.webhook,
        {
          ...event,
          args: structuredClone(ready.effectiveArgs ?? originalArgs),
          originalArgs: structuredClone(originalArgs),
          hookId: hook.id,
          hookType: 'beforeToolCall',
        },
        { signal },
      );
      if (signal?.aborted || response.status === 'cancelled')
        return { originalArgs, status: 'cancelled' };
      if (response.status === 'error') {
        if (resolveToolCallHookErrorPolicy(hook.webhook.onError).action === 'block') {
          return {
            ...ready,
            status: 'blocked',
            reason: 'hook_control_error',
          };
        }
        continue;
      }
      if (response.decision?.additionalContext !== undefined) {
        ready.additionalContexts = ready.additionalContexts!.filter(
          ({ hookId }) => hookId !== hook.id,
        );
        ready.additionalContexts.push({
          hookId: hook.id,
          text: response.decision.additionalContext,
        });
      }
      if (response.decision?.permissionDecision === 'deny') {
        return {
          ...ready,
          status: 'blocked',
          reason: response.decision.permissionDecisionReason ?? 'Blocked by beforeToolCall hook.',
        };
      }
      if (response.decision?.permissionDecision === 'allow' && response.decision.updatedInput) {
        ready.effectiveArgs = structuredClone(response.decision.updatedInput);
      }
    }
    return signal?.aborted ? { originalArgs, status: 'cancelled' } : ready;
  }

  /** Deliver each observation once; only local handlers can supply a mock. */
  async dispatchBeforeToolCall(
    operationId: string,
    event: Omit<ToolCallHookEvent, 'mock' | 'operationId'>,
    serializedHooks?: SerializedAgentHook[],
  ): Promise<{ isMocked: true; result: ToolRunResult } | null> {
    let mockedResult: ToolRunResult | undefined;
    const toolCallEvent: ToolCallHookEvent = {
      ...event,
      mock: (result) => {
        if (mockedResult) return false;
        mockedResult = result;
        return true;
      },
      operationId,
    };
    await this.dispatchHooks(
      operationId,
      'beforeToolCall',
      toolCallEvent,
      serializedHooks,
      () => !!mockedResult,
    );
    return mockedResult ? { isMocked: true, result: mockedResult } : null;
  }

  /**
   * Get webhook configurations for durable operation state
   */
  getSerializedHooks(operationId: string): SerializedHook[] | undefined {
    const hooks = this.hooks.get(operationId);
    if (!hooks) return undefined;

    return parseSerializedHooks(
      hooks
        .filter((h) => h.webhook)
        .map((h) => ({
          id: h.id,
          matcher: h.matcher,
          type: h.type,
          webhook: h.webhook!,
        })),
    );
  }

  /**
   * Check if any hooks are registered for an operation
   */
  hasHooks(operationId: string): boolean {
    return (this.hooks.get(operationId)?.length ?? 0) > 0;
  }

  hasHook(operationId: string, hookId: string): boolean {
    return this.hooks.get(operationId)?.some((hook) => hook.id === hookId) ?? false;
  }

  /**
   * Whether a registered handler or webhook consumes this event.
   *
   * Callers that ALSO surface the same failure themselves (the IM bot bridge
   * reports a startup failure inline) ask this before deciding whether their own
   * report would be a duplicate — a failure the hooks will announce must not be
   * announced twice, and one they cannot announce must not vanish.
   */
  canDeliver(operationId: string, type: AgentHookType): boolean {
    const hooks = this.hooks.get(operationId)?.filter((hook) => hook.type === type) ?? [];

    return hooks.length > 0;
  }

  /**
   * Register hooks for an operation
   *
   * Stores explicit targets in memory. Callers persist getSerializedHooks() to state.host.hooks.
   */
  register(operationId: string, hooks: AgentHook[]): void {
    if (hooks.length === 0) return;

    // Validate the entire batch before mutating registration state.
    const validatedHooks = hooks.map((hook) => {
      agentHookTypeSchema.parse(hook.type);
      if (typeof hook.id !== 'string') throw new Error('Hook id must be a string');
      if (hook.matcher !== undefined) {
        agentHookMatcherSchema.parse(hook.matcher);
        if (!['beforeToolCall', 'afterToolCall', 'onToolCallError'].includes(hook.type)) {
          throw new Error('Matchers are only supported for tool events');
        }
      }
      if (hook.handler !== undefined && typeof hook.handler !== 'function') {
        throw new Error('Hook handler must be a function');
      }
      if (hook.webhook !== undefined && hook.handler !== undefined) {
        throw new Error('A hook requires exactly one of handler or webhook');
      }
      if (hook.webhook !== undefined) {
        const parsed = serializedAgentHookSchema.parse({
          id: hook.id,
          matcher: hook.matcher,
          type: hook.type,
          webhook: hook.webhook,
        });
        return parsed as AgentHook;
      } else if (!hook.handler) {
        throw new Error('A hook requires a handler or webhook');
      }
      return {
        ...hook,
        matcher:
          hook.matcher !== undefined ? agentHookMatcherSchema.parse(hook.matcher) : undefined,
      };
    });
    const existing = this.hooks.get(operationId) || [];
    const combined = [...existing, ...validatedHooks];
    assertUniqueHookIds(combined);
    this.hooks.set(operationId, combined);

    log(
      '[%s] Registered %d hooks: %s',
      operationId,
      hooks.length,
      hooks.map((h) => `${h.type}:${h.id}`).join(', '),
    );
  }

  /**
   * Unregister all hooks for an operation (cleanup)
   */
  unregister(operationId: string): void {
    this.hooks.delete(operationId);
    log('[%s] Unregistered all hooks', operationId);
  }
}

/**
 * Singleton instance — shared across the application
 */
export const hookDispatcher = new HookDispatcher();
