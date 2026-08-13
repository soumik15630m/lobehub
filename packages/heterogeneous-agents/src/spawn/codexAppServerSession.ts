import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';

import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';
import { isRecord } from '@lobechat/utils/object';
import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js';
import { ElicitRequestFormParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import { DEFAULT_ASK_USER_TIMEOUT_MS } from '../askUser/constants';
import type { UsageData } from '../types';
import { AgentStreamPipeline } from './agentStreamPipeline';
import type { HeterogeneousAgentRuntimeStatus } from './claudeAgentSdkSession';
import { resolveCliSpawnPlan } from './cliSpawn';
import type { CodexAppServerUserInput, CodexExecItem } from './codexAppServerProtocol';
import {
  isKnownCodexAppServerNotificationMethod,
  normalizeCodexAppServerItem,
} from './codexAppServerProtocol';
import { CodexAppServerSubagentRouter } from './codexAppServerSubagents';
import type { AgentInputPlan } from './input';

const APP_SERVER_RPC_TIMEOUT_MS = 30_000;
const APP_SERVER_UNSUPPORTED_REQUEST_CODE = -32_000;
const CODEX_APP_SERVER_TRANSPORT = 'codex-app-server' as const;
const CODEX_DANGEROUS_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const CODEX_FULL_AUTO_FLAG = '--full-auto';
const CODEX_APPROVAL_FLAGS = ['-a', '--ask-for-approval'] as const;
const CODEX_CONFIG_FLAGS = ['-c', '--config'] as const;
const CODEX_CWD_FLAGS = ['-C', '--cd'] as const;
const CODEX_MODEL_FLAGS = ['-m', '--model'] as const;
const CODEX_PROFILE_FLAGS = ['-p', '--profile'] as const;
const CODEX_SANDBOX_FLAGS = ['-s', '--sandbox'] as const;
const CODEX_EPHEMERAL_FLAG = '--ephemeral';
const CODEX_IGNORE_USER_CONFIG_FLAG = '--ignore-user-config';

export type { CodexAppServerUserInput } from './codexAppServerProtocol';

interface RpcError {
  code?: number;
  data?: unknown;
  message?: string;
}

interface RpcMessage {
  error?: RpcError;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface PendingRpcRequest {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CodexThreadResponse {
  model?: string;
  thread?: { id?: string };
}

interface CodexTurnResponse {
  turn?: { id?: string };
}

interface CodexTokenUsageBreakdown {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
}

interface CodexTurnPlanStep {
  status?: string;
  step?: string;
}

type CodexAppServerApprovalPolicy = 'never' | 'on-request' | 'untrusted';
type CodexAppServerSandboxMode = 'danger-full-access' | 'read-only' | 'workspace-write';

export interface CodexAppServerInterventionQuestion {
  allowCustom?: boolean;
  header: string;
  id?: string;
  multiSelect?: boolean;
  options: Array<{ description: string; label: string }>;
  question: string;
  required?: boolean;
}

export interface CodexAppServerInterventionRequest {
  arguments: {
    allowEscape?: boolean;
    deadline?: number;
    description?: string;
    questions: CodexAppServerInterventionQuestion[];
  };
  timeoutMs?: number | null;
  toolCallId: string;
}

export interface CodexAppServerInterventionAnswer {
  cancelled?: boolean;
  result?: unknown;
}

export interface CodexAppServerThreadParams {
  approvalPolicy: CodexAppServerApprovalPolicy;
  cwd: string;
  ephemeral?: boolean;
  model?: string;
  modelProvider?: string;
  sandbox: CodexAppServerSandboxMode;
  serviceTier?: string;
}

export interface CodexAppServerSessionOptions {
  args: string[];
  clientVersion: string;
  commandPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  initialCumulativeUsage?: UsageData | undefined;
  initialModel?: string | undefined;
  input: CodexAppServerUserInput[];
  onEvents: (events: AgentStreamEvent[]) => Promise<void> | void;
  onIntervention?: (
    request: CodexAppServerInterventionRequest,
    signal: AbortSignal,
  ) => Promise<CodexAppServerInterventionAnswer>;
  onModel?: (model: string) => void;
  onRawMessage: (line: string) => Promise<void> | void;
  onRuntimeStatus: (status: HeterogeneousAgentRuntimeStatus) => void;
  onSessionId: (sessionId: string) => void;
  onStderr: (data: string) => Promise<void> | void;
  operationId: string;
  resumeSessionId?: string;
  sessionId: string;
}

const getFlagValue = (arg: string, flags: readonly string[]) => {
  const flag = flags.find((candidate) => arg.startsWith(`${candidate}=`));
  return flag ? arg.slice(flag.length + 1) : undefined;
};

const parseConfigValue = (raw: string): unknown => {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  const number = Number(value);
  if (value && Number.isFinite(number)) return number;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      // Keep non-JSON TOML values as strings; app-server validates the config.
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
};

const parseConfigOverride = (raw: string) => {
  const separator = raw.indexOf('=');
  if (separator <= 0) return;
  const key = raw.slice(0, separator).trim();
  if (!key) return;
  return { key, value: parseConfigValue(raw.slice(separator + 1)) };
};

const isSandboxMode = (value: string): value is CodexAppServerSandboxMode =>
  value === 'danger-full-access' || value === 'read-only' || value === 'workspace-write';

/** App-server consumes global config overrides itself; preserve their raw TOML values. */
export const buildCodexAppServerArgs = (args: string[] = []): string[] => {
  const configArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (getFlagValue(arg, CODEX_CONFIG_FLAGS) !== undefined) {
      configArgs.push(arg);
      continue;
    }
    if (!CODEX_CONFIG_FLAGS.includes(arg as (typeof CODEX_CONFIG_FLAGS)[number])) continue;

    const value = args[index + 1];
    if (value) {
      configArgs.push(arg, value);
      index += 1;
    }
  }

  return [...configArgs, 'app-server'];
};

/**
 * Unknown or loader-only CLI arguments must use the existing `codex exec` path instead of being
 * silently discarded. Interactive approval modes also stay on that path until app-server has UI.
 */
export const getCodexAppServerUnsupportedArgs = (
  args: string[],
  options: { resume?: boolean } = {},
): string[] => {
  const unsupported: string[] = [];
  const hasSandboxFlag = args.some(
    (arg) =>
      CODEX_SANDBOX_FLAGS.includes(arg as (typeof CODEX_SANDBOX_FLAGS)[number]) ||
      getFlagValue(arg, CODEX_SANDBOX_FLAGS) !== undefined,
  );

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === CODEX_DANGEROUS_BYPASS_FLAG) {
      if (hasSandboxFlag) unsupported.push(arg);
      continue;
    }
    if (arg === CODEX_EPHEMERAL_FLAG) {
      if (options.resume) unsupported.push(arg);
      continue;
    }
    if (arg === CODEX_FULL_AUTO_FLAG || arg === CODEX_IGNORE_USER_CONFIG_FLAG) {
      unsupported.push(arg);
      continue;
    }

    const valueFlags = [
      ...CODEX_MODEL_FLAGS,
      ...CODEX_CONFIG_FLAGS,
      ...CODEX_CWD_FLAGS,
      ...CODEX_APPROVAL_FLAGS,
      ...CODEX_SANDBOX_FLAGS,
    ];
    const exactFlag = valueFlags.find((flag) => arg === flag);
    const inlineFlag = valueFlags.find((flag) => arg.startsWith(`${flag}=`));
    if (exactFlag || inlineFlag) {
      const value = inlineFlag ? arg.slice(inlineFlag.length + 1) : args[index + 1];
      if (!value || (!inlineFlag && value.startsWith('-'))) {
        unsupported.push(arg);
        continue;
      }
      if (!inlineFlag) index += 1;

      if (
        CODEX_APPROVAL_FLAGS.includes(
          (exactFlag ?? inlineFlag) as (typeof CODEX_APPROVAL_FLAGS)[number],
        ) &&
        value !== 'never'
      ) {
        unsupported.push(arg);
      }
      if (
        CODEX_SANDBOX_FLAGS.includes(
          (exactFlag ?? inlineFlag) as (typeof CODEX_SANDBOX_FLAGS)[number],
        ) &&
        !isSandboxMode(value)
      ) {
        unsupported.push(arg);
      }
      if (
        CODEX_CONFIG_FLAGS.includes(
          (exactFlag ?? inlineFlag) as (typeof CODEX_CONFIG_FLAGS)[number],
        )
      ) {
        const override = parseConfigOverride(value);
        if (override?.key === 'approval_policy' && override.value !== 'never') {
          unsupported.push(arg);
        }
      }
      continue;
    }

    if (
      CODEX_PROFILE_FLAGS.includes(arg as (typeof CODEX_PROFILE_FLAGS)[number]) ||
      getFlagValue(arg, CODEX_PROFILE_FLAGS) !== undefined
    ) {
      unsupported.push(arg);
      if (CODEX_PROFILE_FLAGS.includes(arg as (typeof CODEX_PROFILE_FLAGS)[number])) index += 1;
      continue;
    }

    unsupported.push(arg);
  }

  return unsupported;
};

export const buildCodexAppServerThreadParams = (
  args: string[],
  cwd: string,
  initialModel?: string,
): CodexAppServerThreadParams => {
  const approvalPolicy: CodexAppServerApprovalPolicy = 'never';
  let effectiveCwd = cwd;
  let ephemeral = false;
  let model = initialModel;
  let modelProvider: string | undefined;
  let sandbox: CodexAppServerSandboxMode = 'danger-full-access';
  let serviceTier: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === CODEX_DANGEROUS_BYPASS_FLAG) {
      sandbox = 'danger-full-access';
      continue;
    }
    if (arg === CODEX_FULL_AUTO_FLAG) {
      sandbox = 'workspace-write';
      continue;
    }
    if (arg === CODEX_EPHEMERAL_FLAG) {
      ephemeral = true;
      continue;
    }

    const next = args[index + 1];
    const modelValue = getFlagValue(arg, CODEX_MODEL_FLAGS);
    if (modelValue !== undefined) {
      if (modelValue) model = modelValue;
      continue;
    }
    if (CODEX_MODEL_FLAGS.includes(arg as (typeof CODEX_MODEL_FLAGS)[number]) && next) {
      model = next;
      index += 1;
      continue;
    }

    const approvalValue = getFlagValue(arg, CODEX_APPROVAL_FLAGS);
    if (approvalValue !== undefined) {
      continue;
    }
    if (CODEX_APPROVAL_FLAGS.includes(arg as (typeof CODEX_APPROVAL_FLAGS)[number]) && next) {
      index += 1;
      continue;
    }

    const sandboxValue = getFlagValue(arg, CODEX_SANDBOX_FLAGS);
    if (sandboxValue !== undefined) {
      if (isSandboxMode(sandboxValue)) sandbox = sandboxValue;
      continue;
    }
    if (CODEX_SANDBOX_FLAGS.includes(arg as (typeof CODEX_SANDBOX_FLAGS)[number]) && next) {
      if (isSandboxMode(next)) sandbox = next;
      index += 1;
      continue;
    }

    const cwdValue = getFlagValue(arg, CODEX_CWD_FLAGS);
    if (cwdValue !== undefined) {
      if (cwdValue) effectiveCwd = path.resolve(cwd, cwdValue);
      continue;
    }
    if (CODEX_CWD_FLAGS.includes(arg as (typeof CODEX_CWD_FLAGS)[number]) && next) {
      effectiveCwd = path.resolve(cwd, next);
      index += 1;
      continue;
    }

    const configValue = getFlagValue(arg, CODEX_CONFIG_FLAGS);
    const isConfigFlag = CODEX_CONFIG_FLAGS.includes(arg as (typeof CODEX_CONFIG_FLAGS)[number]);
    if (configValue === undefined && !isConfigFlag) continue;
    if (configValue === undefined && next) index += 1;
    const configOverride = parseConfigOverride(configValue ?? next ?? '');
    if (!configOverride) continue;
    if (configOverride.key === 'model' && typeof configOverride.value === 'string') {
      model = configOverride.value;
    }
    if (configOverride.key === 'model_provider' && typeof configOverride.value === 'string') {
      modelProvider = configOverride.value;
    }
    if (
      configOverride.key === 'sandbox_mode' &&
      typeof configOverride.value === 'string' &&
      isSandboxMode(configOverride.value)
    )
      sandbox = configOverride.value;
    if (configOverride.key === 'service_tier' && typeof configOverride.value === 'string') {
      serviceTier = configOverride.value;
    }
  }

  return {
    approvalPolicy,
    cwd: effectiveCwd,
    ...(ephemeral ? { ephemeral } : {}),
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    sandbox,
    ...(serviceTier ? { serviceTier } : {}),
  };
};

export const buildCodexAppServerInput = (plan: AgentInputPlan): CodexAppServerUserInput[] => {
  const input: CodexAppServerUserInput[] = [];
  if (plan.stdin) input.push({ text: plan.stdin, text_elements: [], type: 'text' });

  for (let index = 0; index < plan.args.length; index += 1) {
    if (plan.args[index] !== '--image') continue;
    const imagePath = plan.args[index + 1];
    if (imagePath) input.push({ path: imagePath, type: 'localImage' });
    index += 1;
  }

  return input;
};

const toExecUsage = (usage: CodexTokenUsageBreakdown | undefined) =>
  usage
    ? {
        cached_input_tokens: usage.cachedInputTokens,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
      }
    : undefined;

const readInterventionResult = (result: unknown): Record<string, unknown> =>
  isRecord(result) ? result : {};

const getQuestionAnswer = (result: Record<string, unknown>, key: string): string[] => {
  const value = result[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' && value ? [value] : [];
};

interface SchemaOption {
  description: string;
  label: string;
  value: string;
}

const getSchemaOptions = (schema: PrimitiveSchemaDefinition): SchemaOption[] => {
  if (schema.type === 'array') {
    if ('enum' in schema.items) {
      return schema.items.enum.map((value) => ({ description: '', label: value, value }));
    }

    return schema.items.anyOf.map(({ const: value, title: label }) => ({
      description: '',
      label,
      value,
    }));
  }

  if (schema.type === 'string' && 'enum' in schema) {
    const names = 'enumNames' in schema ? schema.enumNames : undefined;
    return schema.enum.map((value, index) => ({
      description: '',
      label: names?.[index] ?? value,
      value,
    }));
  }

  if (schema.type === 'string' && 'oneOf' in schema) {
    return schema.oneOf.map(({ const: value, title: label }) => ({
      description: '',
      label,
      value,
    }));
  }

  if (schema.type === 'boolean') {
    return [
      { description: '', label: 'true', value: 'true' },
      { description: '', label: 'false', value: 'false' },
    ];
  }

  return [];
};

type SchemaCoercionResult = { error: string; success: false } | { success: true; value: unknown };

const coerceSchemaAnswer = (
  answer: string[],
  schema: PrimitiveSchemaDefinition,
  options: SchemaOption[],
): SchemaCoercionResult => {
  const valuesByLabel = new Map(options.map(({ label, value }) => [label, value]));
  const optionValues = new Set(options.map(({ value }) => value));
  const resolveOption = (value: string): SchemaCoercionResult => {
    const resolved = valuesByLabel.get(value) ?? (optionValues.has(value) ? value : undefined);
    return resolved === undefined
      ? { error: `must be one of: ${options.map(({ label }) => label).join(', ')}`, success: false }
      : { success: true, value: resolved };
  };

  if (schema.type === 'array') {
    const values: string[] = [];
    for (const value of answer) {
      const resolved = resolveOption(value);
      if (!resolved.success) return resolved;
      values.push(String(resolved.value));
    }
    return { success: true, value: values };
  }

  const rawValue = answer[0];
  if (options.length > 0) {
    const resolved = resolveOption(rawValue);
    if (!resolved.success) return resolved;
    if (schema.type === 'boolean') {
      return { success: true, value: resolved.value === 'true' };
    }
    return resolved;
  }

  if (schema.type === 'boolean') {
    return rawValue === 'true' || rawValue === 'false'
      ? { success: true, value: rawValue === 'true' }
      : { error: 'must be true or false', success: false };
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    const value = Number(rawValue.trim());
    if (
      !rawValue.trim() ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value))
    ) {
      return { error: `must be a valid ${schema.type}`, success: false };
    }
    return { success: true, value };
  }

  return { success: true, value: rawValue };
};

const elicitationSchemaValidator = new AjvJsonSchemaValidator();

export class CodexAppServerSession {
  private readonly pipeline: AgentStreamPipeline;
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly pendingServerRequests = new Map<string, AbortController>();
  private readonly reportedDiagnostics = new Set<string>();
  private readonly subagentRouter: CodexAppServerSubagentRouter;
  private readonly threadParams: CodexAppServerThreadParams;
  private activeFileChangeItemId?: string;
  private child?: ChildProcess;
  private closedByHost = false;
  private completedItemIds = new Set<string>();
  private fatalError?: Error;
  private latestTokenUsage?: CodexThreadTokenUsage;
  private latestPlanItem?: CodexExecItem;
  private notificationQueue = Promise.resolve();
  private nextRequestId = 0;
  private stdoutBuffer = '';
  private threadId?: string;
  private turnId?: string;
  private turnCompletion?: Promise<void>;
  private rejectTurn?: (error: Error) => void;
  private resolveTurn?: () => void;

  constructor(private readonly options: CodexAppServerSessionOptions) {
    this.threadParams = buildCodexAppServerThreadParams(
      options.args,
      options.cwd,
      options.initialModel,
    );
    this.pipeline = new AgentStreamPipeline({
      agentType: 'codex',
      cwd: this.threadParams.cwd,
      initialCumulativeUsage: options.initialCumulativeUsage,
      initialModel: options.initialModel,
      operationId: options.operationId,
    });
    this.subagentRouter = new CodexAppServerSubagentRouter({
      cwd: this.threadParams.cwd,
      onDiagnostic: (key, message) => this.reportDiagnostic(key, message),
      onEvents: (events) => this.emitEvents(events),
      operationId: options.operationId,
    });
  }

  async run(): Promise<void> {
    this.emitStatus('starting');

    try {
      await this.startProcess();
      await this.request('initialize', {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: 'lobehub-desktop',
          title: 'LobeHub Desktop',
          version: this.options.clientVersion,
        },
      });
      this.sendNotification('initialized', {});

      const resumeThreadParams = { ...this.threadParams };
      delete resumeThreadParams.ephemeral;
      const thread = this.options.resumeSessionId
        ? await this.request<CodexThreadResponse>('thread/resume', {
            ...resumeThreadParams,
            threadId: this.options.resumeSessionId,
          })
        : await this.request<CodexThreadResponse>('thread/start', this.threadParams);
      const threadId = thread.thread?.id;
      if (!threadId) throw new Error('Codex app-server returned no thread id');

      this.threadId = threadId;
      if (!this.threadParams.ephemeral) this.options.onSessionId(threadId);
      await this.emitSynthetic({ thread_id: threadId, type: 'thread.started' });
      if (thread.model) {
        this.options.onModel?.(thread.model);
        await this.emitEvents(this.pipeline.configureSession({ model: thread.model }));
      }

      this.turnCompletion = new Promise<void>((resolve, reject) => {
        this.resolveTurn = resolve;
        this.rejectTurn = reject;
      });
      void this.turnCompletion.catch(() => {});
      const turn = await this.request<CodexTurnResponse>('turn/start', {
        input: this.options.input,
        threadId,
      });
      this.turnId = turn.turn?.id;
      this.emitStatus('running');

      await this.turnCompletion;
      await this.notificationQueue;
      await this.emitEvents(await this.pipeline.flush());
      this.emitStatus('idle');
    } catch (error) {
      if (this.closedByHost) {
        this.emitStatus('closed');
        return;
      }

      this.emitStatus('error');
      throw error;
    } finally {
      this.shutdownProcess('SIGTERM');
      if (!this.closedByHost) this.emitStatus('closed');
    }
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) {
      this.close();
      return;
    }

    await this.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    });
  }

  close(): void {
    this.closedByHost = true;
    this.rejectTurn?.(new Error('Codex app-server session closed by host'));
    this.rejectPendingRequests(new Error('Codex app-server session closed by host'));
    this.abortServerRequests();
    this.shutdownProcess('SIGTERM');
    this.emitStatus('closed');
  }

  private async startProcess(): Promise<void> {
    const spawnPlan = await resolveCliSpawnPlan(
      this.options.commandPath,
      buildCodexAppServerArgs(this.options.args),
    );
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: this.options.cwd,
      detached: process.platform !== 'win32',
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdin?.on('error', () => {
      // The process error/exit listener reports the actionable failure. Swallow
      // a racing EPIPE from an RPC write so it cannot crash Electron main.
    });
    child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      void this.options.onStderr(chunk.toString('utf8'));
    });
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      if (this.closedByHost) return;
      this.fail(
        new Error(
          `Codex app-server exited before the turn completed (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
        ),
      );
    });
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');

    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      void this.options.onRawMessage(`${line}\n`);
      try {
        this.handleRpcMessage(JSON.parse(line) as RpcMessage);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleRpcMessage(message: RpcMessage): void {
    if (message.method) {
      if (message.id !== undefined) {
        void this.handleServerRequest(message).catch((error) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      this.notificationQueue = this.notificationQueue
        .then(() => this.handleNotification(message.method!, message.params ?? {}))
        .catch((error) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }

    if (message.id === undefined) return;
    const pending = this.pendingRequests.get(String(message.id));
    if (!pending) return;

    this.pendingRequests.delete(String(message.id));
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'serverRequest/resolved') {
      this.resolveServerRequest(params.requestId);
      return;
    }

    if (this.threadId && typeof params.threadId === 'string' && params.threadId !== this.threadId) {
      await this.subagentRouter.routeNotification(params.threadId, method, params);
      return;
    }

    switch (method) {
      case 'turn/started': {
        const turn = params.turn as { id?: string } | undefined;
        this.turnId = turn?.id ?? this.turnId;
        this.completedItemIds.clear();
        await this.emitSynthetic({ turn, type: 'turn.started' });
        return;
      }
      case 'item/started':
      case 'item/completed': {
        await this.emitAppServerItem(
          (params.item ?? {}) as CodexExecItem,
          method === 'item/started' ? 'item.started' : 'item.completed',
        );
        return;
      }
      case 'item/agentMessage/delta': {
        await this.emitSynthetic({
          delta: params.delta,
          item_id: params.itemId,
          type: 'item.agent_message.delta',
        });
        return;
      }
      case 'item/plan/delta': {
        await this.emitSynthetic({
          delta: params.delta,
          item_id: params.itemId,
          type: 'item.plan.delta',
        });
        return;
      }
      case 'item/reasoning/summaryPartAdded': {
        if (typeof params.summaryIndex !== 'number' || params.summaryIndex <= 0) return;
        await this.emitSynthetic({
          delta: '\n\n',
          item_id: params.itemId,
          type: 'item.reasoning.delta',
        });
        return;
      }
      case 'item/reasoning/summaryTextDelta': {
        await this.emitSynthetic({
          delta: params.delta,
          item_id: params.itemId,
          type: 'item.reasoning.delta',
        });
        return;
      }
      case 'item/reasoning/textDelta': {
        await this.reportDiagnostic(
          'raw-reasoning-omitted',
          'Codex app-server raw reasoning is omitted; readable reasoning summaries remain enabled.',
        );
        return;
      }
      case 'item/commandExecution/outputDelta': {
        await this.emitSynthetic({
          delta: params.delta,
          item_id: params.itemId,
          type: 'item.command_execution.output_delta',
        });
        return;
      }
      case 'item/commandExecution/terminalInteraction': {
        await this.emitSynthetic({
          item_id: params.itemId,
          process_id: params.processId,
          stdin: params.stdin,
          type: 'item.command_execution.terminal_interaction',
        });
        return;
      }
      case 'item/fileChange/patchUpdated': {
        const normalized = normalizeCodexAppServerItem({
          changes: Array.isArray(params.changes) ? params.changes : [],
          id: typeof params.itemId === 'string' ? params.itemId : undefined,
          status: 'inProgress',
          type: 'fileChange',
        });
        if (normalized.disposition === 'emit') {
          await this.emitSynthetic({ item: normalized.item, type: 'item.updated' });
        }
        return;
      }
      case 'item/fileChange/outputDelta': {
        if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return;
        await this.emitSynthetic({
          item: {
            changes: [{ diffText: params.delta }],
            id: params.itemId,
            status: 'in_progress',
            type: 'file_change',
          },
          type: 'item.updated',
        });
        return;
      }
      case 'item/mcpToolCall/progress': {
        await this.emitSynthetic({
          item_id: params.itemId,
          message: params.message,
          type: 'item.mcp_tool_call.progress',
        });
        return;
      }
      case 'turn/diff/updated': {
        if (!this.activeFileChangeItemId || typeof params.diff !== 'string') return;
        await this.emitSynthetic({
          item: {
            changes: [{ diffText: params.diff }],
            id: this.activeFileChangeItemId,
            status: 'in_progress',
            type: 'file_change',
          },
          type: 'item.updated',
        });
        return;
      }
      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? (params.plan as CodexTurnPlanStep[]) : [];
        const planItemId = `turn-plan-${String(params.turnId ?? this.turnId ?? 'current')}`;
        const item: CodexExecItem = {
          id: planItemId,
          items: plan
            .filter((step) => typeof step.step === 'string' && step.step.trim())
            .map((step) => ({ completed: step.status === 'completed', text: step.step })),
          status: 'in_progress',
          type: 'todo_list',
        };
        const type = this.latestPlanItem?.id === planItemId ? 'item.updated' : 'item.started';
        this.latestPlanItem = item;
        await this.emitSynthetic({ item, type });
        return;
      }
      case 'thread/tokenUsage/updated': {
        this.latestTokenUsage = params.tokenUsage as CodexThreadTokenUsage;
        return;
      }
      case 'error': {
        const error = params.error as { message?: string } | undefined;
        if (params.willRetry === true) {
          await this.emitSynthetic({
            message: error?.message ?? 'Codex is retrying after a transient error',
            type: 'stream.retry',
          });
          return;
        }
        await this.emitSynthetic({
          message: error?.message ?? 'Codex execution failed',
          type: 'error',
        });
        return;
      }
      case 'model/rerouted': {
        if (typeof params.toModel === 'string' && params.toModel) {
          this.options.onModel?.(params.toModel);
          await this.emitEvents(this.pipeline.configureSession({ model: params.toModel }));
        }
        await this.reportDiagnostic(
          `model-rerouted:${String(params.fromModel)}:${String(params.toModel)}`,
          `Codex app-server rerouted the model from ${String(params.fromModel)} to ${String(params.toModel)}.`,
        );
        return;
      }
      case 'warning':
      case 'guardianWarning': {
        await this.reportDiagnostic(
          `${method}:${String(params.message)}`,
          `Codex app-server ${method}: ${String(params.message ?? 'unknown warning')}`,
        );
        return;
      }
      case 'configWarning':
      case 'deprecationNotice': {
        const details = typeof params.details === 'string' ? ` ${params.details}` : '';
        await this.reportDiagnostic(
          `${method}:${String(params.summary)}:${details}`,
          `Codex app-server ${method}: ${String(params.summary ?? 'unknown warning')}${details}`,
        );
        return;
      }
      case 'thread/compacted':
      case 'hook/started':
      case 'hook/completed':
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
      case 'model/verification':
      case 'model/safetyBuffering/updated':
      case 'turn/moderationMetadata': {
        await this.reportDiagnostic(
          `acknowledged-notification:${method}`,
          `Codex app-server notification acknowledged without an exec JSON equivalent: ${method}`,
        );
        return;
      }
      case 'turn/completed': {
        const turn = params.turn as {
          error?: { message?: string };
          id?: string;
          items?: CodexExecItem[];
          status?: string;
        };
        this.turnId = turn.id ?? this.turnId;
        for (const item of turn.items ?? []) {
          if (item.id && this.completedItemIds.has(item.id)) continue;
          await this.emitAppServerItem(item, 'item.completed');
        }
        if (turn.status === 'completed') {
          if (this.latestPlanItem) {
            await this.emitSynthetic({
              item: { ...this.latestPlanItem, status: 'completed' },
              type: 'item.completed',
            });
          }
          await this.emitSynthetic({
            type: 'turn.completed',
            usage: toExecUsage(this.latestTokenUsage?.total),
          });
        } else if (turn.status === 'interrupted') {
          await this.emitSynthetic({
            reason: 'interrupted',
            type: 'turn.completed',
            usage: toExecUsage(this.latestTokenUsage?.total),
          });
        } else {
          await this.emitSynthetic({
            message:
              turn.error?.message ??
              (turn.status === 'failed'
                ? 'Codex execution failed'
                : `Codex app-server returned unexpected turn status: ${turn.status ?? 'unknown'}`),
            type: 'turn.failed',
          });
        }
        this.latestPlanItem = undefined;
        this.resolveTurn?.();
        return;
      }
      default: {
        await this.reportDiagnostic(
          `${isKnownCodexAppServerNotificationMethod(method) ? 'acknowledged' : 'unknown'}-notification:${method}`,
          isKnownCodexAppServerNotificationMethod(method)
            ? `Codex app-server notification acknowledged without an exec JSON equivalent: ${method}`
            : `Unknown Codex app-server notification: ${method}`,
        );
      }
    }
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    if (!this.child?.stdin || message.id === undefined) return;

    if (
      message.method === 'item/commandExecution/requestApproval' ||
      message.method === 'item/fileChange/requestApproval'
    ) {
      // This transport only starts non-interactive (`never`) threads. A request is therefore an
      // unexpected escalation; decline it rather than silently bypassing the configured boundary.
      this.writeRpc({ id: message.id, result: { decision: 'decline' } });
      return;
    }

    if (message.method === 'applyPatchApproval' || message.method === 'execCommandApproval') {
      this.writeRpc({
        id: message.id,
        result: {
          decision: {
            denied: { rejection: 'Approval UI is unavailable in this client.' },
          },
        },
      });
      return;
    }

    if (message.method === 'item/permissions/requestApproval') {
      // The response union has no decline variant. An empty successful grant is still an
      // approval, so fail closed instead of manufacturing a permission profile.
      this.writeUnsupportedRequest(
        message.id,
        'Permission approval is unavailable in this client.',
      );
      return;
    }

    if (message.method === 'item/tool/requestUserInput') {
      await this.handleToolRequestUserInput(message);
      return;
    }

    if (message.method === 'mcpServer/elicitation/request') {
      await this.handleMcpElicitation(message);
      return;
    }

    if (message.method === 'item/tool/call') {
      this.writeRpc({
        id: message.id,
        result: {
          contentItems: [
            {
              text: `Dynamic tool '${String(message.params?.tool ?? 'unknown')}' is not registered by LobeHub.`,
              type: 'inputText',
            },
          ],
          success: false,
        },
      });
      await this.reportDiagnostic(
        `unsupported-dynamic-tool:${String(message.params?.tool)}`,
        `Codex app-server requested an unregistered dynamic tool: ${String(message.params?.tool ?? 'unknown')}`,
      );
      return;
    }

    if (message.method === 'currentTime/read') {
      this.writeRpc({ id: message.id, result: { currentTimeAt: Date.now() } });
      return;
    }

    if (
      message.method === 'account/chatgptAuthTokens/refresh' ||
      message.method === 'attestation/generate'
    ) {
      this.writeUnsupportedRequest(
        message.id,
        `Codex app-server request is unavailable in this client: ${message.method}`,
      );
      await this.reportDiagnostic(
        `unsupported-server-request:${message.method}`,
        `Unsupported Codex app-server request: ${message.method}`,
      );
      return;
    }

    this.writeRpc({
      error: { code: -32_601, message: `Unsupported Codex app-server request: ${message.method}` },
      id: message.id,
    });
    await this.reportDiagnostic(
      `unsupported-server-request:${String(message.method)}`,
      `Unsupported Codex app-server request: ${String(message.method)}`,
    );
  }

  private async handleToolRequestUserInput(message: RpcMessage): Promise<void> {
    if (message.id === undefined) return;
    const rawQuestions = Array.isArray(message.params?.questions) ? message.params.questions : [];
    const questionEntries = rawQuestions.flatMap((value) => {
      if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') {
        return [];
      }
      return [
        {
          id: value.id,
          isSecret: value.isSecret === true,
          question: {
            allowCustom: value.isOther !== false,
            header: typeof value.header === 'string' ? value.header : '',
            id: value.id,
            options: Array.isArray(value.options)
              ? value.options.flatMap((option) =>
                  isRecord(option) && typeof option.label === 'string'
                    ? [
                        {
                          description:
                            typeof option.description === 'string' ? option.description : '',
                          label: option.label,
                        },
                      ]
                    : [],
                )
              : [],
            question: value.question,
          } satisfies CodexAppServerInterventionQuestion,
        },
      ];
    });

    if (questionEntries.length === 0) {
      this.writeUnsupportedRequest(
        message.id,
        'Codex requested user input with no valid questions.',
      );
      await this.reportDiagnostic(
        'invalid-user-input-request',
        'Codex app-server requested user input with no valid questions.',
      );
      return;
    }

    if (questionEntries.some(({ isSecret }) => isSecret)) {
      this.writeUnsupportedRequest(message.id, 'Secret user input is unavailable in this client.');
      await this.reportDiagnostic(
        'secret-user-input-declined',
        'Codex app-server secret input was declined because the shared intervention UI persists drafts.',
      );
      return;
    }

    const itemId =
      typeof message.params?.itemId === 'string'
        ? message.params.itemId
        : `request-user-input-${String(message.id)}`;
    const autoResolutionMs =
      typeof message.params?.autoResolutionMs === 'number' && message.params.autoResolutionMs > 0
        ? message.params.autoResolutionMs
        : undefined;
    const timeoutMs =
      autoResolutionMs ??
      (message.params?.isBlocking === true ? null : DEFAULT_ASK_USER_TIMEOUT_MS);
    const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
    const outcome = await this.requestIntervention(message.id, {
      arguments: {
        allowEscape: false,
        ...(deadline === undefined ? {} : { deadline }),
        questions: questionEntries.map(({ question }) => question),
      },
      timeoutMs,
      toolCallId: itemId,
    });
    if (!outcome.active) return;

    if (outcome.answer.cancelled) {
      this.writeUnsupportedRequest(message.id, 'User input was cancelled.');
      return;
    }

    const result = readInterventionResult(outcome.answer.result);
    const answers = Object.fromEntries(
      questionEntries.map(({ id }) => [id, { answers: getQuestionAnswer(result, id) }]),
    );
    this.writeRpc({ id: message.id, result: { answers } });
  }

  private async handleMcpElicitation(message: RpcMessage): Promise<void> {
    if (message.id === undefined) return;
    const mode = message.params?.mode;
    if (mode === 'url') {
      this.writeRpc({
        id: message.id,
        result: { _meta: null, action: 'cancel', content: null },
      });
      await this.reportDiagnostic(
        'mcp-url-elicitation-cancelled',
        'Codex app-server MCP URL elicitation was cancelled because no safe in-app URL consent surface is available.',
      );
      return;
    }

    const parsedSchema = ElicitRequestFormParamsSchema.shape.requestedSchema.safeParse(
      message.params?.requestedSchema,
    );
    if (!parsedSchema.success || Object.keys(parsedSchema.data.properties).length === 0) {
      this.writeRpc({
        id: message.id,
        result: { _meta: null, action: 'cancel', content: null },
      });
      await this.reportDiagnostic(
        `unsupported-mcp-elicitation:${String(mode)}`,
        `Codex app-server MCP elicitation has no renderable form schema: ${String(mode ?? 'unknown')}`,
      );
      return;
    }

    const schema = parsedSchema.data;
    const properties = schema.properties;
    const requiredFields = new Set(schema.required ?? []);
    const fields: Array<{
      name: string;
      question: CodexAppServerInterventionQuestion;
      schema: PrimitiveSchemaDefinition;
      schemaOptions: SchemaOption[];
    }> = [];
    for (const [name, fieldSchema] of Object.entries(properties)) {
      const schemaOptions = getSchemaOptions(fieldSchema);
      const question =
        typeof fieldSchema.description === 'string'
          ? fieldSchema.description
          : typeof fieldSchema.title === 'string'
            ? fieldSchema.title
            : name;
      fields.push({
        name,
        question: {
          allowCustom: schemaOptions.length === 0,
          header: typeof fieldSchema.title === 'string' ? fieldSchema.title : name,
          id: name,
          multiSelect: fieldSchema.type === 'array',
          options: schemaOptions.map(({ description, label }) => ({ description, label })),
          question,
          required: requiredFields.has(name),
        } satisfies CodexAppServerInterventionQuestion,
        schema: fieldSchema,
        schemaOptions,
      });
    }
    const itemId = `mcp-elicitation-${String(message.id)}`;
    const timeoutMs = DEFAULT_ASK_USER_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const description =
      typeof message.params?.message === 'string' ? message.params.message : undefined;
    const outcome = await this.requestIntervention(message.id, {
      arguments: {
        allowEscape: false,
        deadline,
        ...(description === undefined ? {} : { description }),
        questions: fields.map(({ question }) => question),
      },
      timeoutMs,
      toolCallId: itemId,
    });
    if (!outcome.active) return;

    if (outcome.answer.cancelled) {
      this.writeRpc({
        id: message.id,
        result: { _meta: null, action: 'cancel', content: null },
      });
      return;
    }

    const result = readInterventionResult(outcome.answer.result);
    const content: Record<string, unknown> = {};
    for (const { name, schema: fieldSchema, schemaOptions } of fields) {
      const answer = getQuestionAnswer(result, name);
      if (answer.length === 0) {
        if (requiredFields.has(name)) {
          const errorMessage = `MCP elicitation required field '${name}' was not answered.`;
          this.writeUnsupportedRequest(message.id, errorMessage);
          await this.reportDiagnostic(`invalid-mcp-elicitation-answer:${name}`, errorMessage);
          return;
        }
        continue;
      }

      const coerced = coerceSchemaAnswer(answer, fieldSchema, schemaOptions);
      if ('error' in coerced) {
        const errorMessage = `Invalid MCP elicitation value for '${name}': ${coerced.error}`;
        this.writeUnsupportedRequest(message.id, errorMessage);
        await this.reportDiagnostic(`invalid-mcp-elicitation-answer:${name}`, errorMessage);
        return;
      }
      content[name] = coerced.value;
    }

    const validationResult = elicitationSchemaValidator.getValidator(schema)(content);
    if (!validationResult.valid) {
      const errorMessage = `Invalid MCP elicitation response: ${validationResult.errorMessage}`;
      this.writeUnsupportedRequest(message.id, errorMessage);
      await this.reportDiagnostic('invalid-mcp-elicitation-response', errorMessage);
      return;
    }
    this.writeRpc({
      id: message.id,
      result: { _meta: null, action: 'accept', content },
    });
  }

  private async requestIntervention(
    requestId: number | string,
    request: CodexAppServerInterventionRequest,
  ): Promise<{ active: boolean; answer: CodexAppServerInterventionAnswer }> {
    const key = String(requestId);
    const controller = new AbortController();
    this.pendingServerRequests.set(key, controller);
    await this.emitSynthetic({
      item: {
        arguments: request.arguments,
        id: request.toolCallId,
        status: 'in_progress',
        type: 'askUserQuestion',
      },
      type: 'item.started',
    });

    const timeoutMs =
      request.arguments.deadline === undefined
        ? request.timeoutMs
        : Math.max(1, request.arguments.deadline - Date.now());
    const interventionRequest = { ...request, timeoutMs };
    const answer = this.options.onIntervention
      ? await this.options.onIntervention(interventionRequest, controller.signal)
      : { cancelled: true };
    const active = this.pendingServerRequests.get(key) === controller;
    if (!active) return { active: false, answer };

    this.pendingServerRequests.delete(key);
    await this.emitSynthetic({
      item: {
        arguments: request.arguments,
        id: request.toolCallId,
        output: answer.cancelled ? 'User input cancelled.' : 'User input submitted.',
        status: answer.cancelled ? 'cancelled' : 'completed',
        type: 'askUserQuestion',
      },
      type: 'item.completed',
    });
    return { active: true, answer };
  }

  private async emitAppServerItem(
    rawItem: CodexExecItem,
    eventType: 'item.completed' | 'item.started',
  ): Promise<void> {
    const registeredSubagentThreadIds = this.subagentRouter.captureParentItem(rawItem, eventType);
    const flushRegisteredSubagents = () =>
      this.subagentRouter.flushPending(registeredSubagentThreadIds);
    const normalized = normalizeCodexAppServerItem(rawItem);
    if (normalized.disposition === 'unknown') {
      await this.reportDiagnostic(
        `unknown-item:${normalized.itemType}`,
        `Unsupported Codex app-server item type: ${normalized.itemType}`,
      );
      await flushRegisteredSubagents();
      return;
    }
    if (normalized.disposition === 'acknowledged') {
      if (normalized.itemType !== 'subAgentActivity') {
        await this.reportDiagnostic(
          `acknowledged-item:${normalized.itemType}`,
          `Codex app-server item acknowledged without an exec JSON equivalent: ${normalized.itemType}`,
        );
      }
      await flushRegisteredSubagents();
      return;
    }

    const { item } = normalized;
    if (eventType === 'item.completed' && item.id) {
      if (this.completedItemIds.has(item.id)) {
        await flushRegisteredSubagents();
        return;
      }
      this.completedItemIds.add(item.id);
    }
    if (eventType === 'item.started' && item.type === 'file_change' && item.id) {
      this.activeFileChangeItemId = item.id;
    }

    await this.emitSynthetic({ item, type: eventType });
    if (eventType === 'item.completed' && item.id === this.activeFileChangeItemId) {
      this.activeFileChangeItemId = undefined;
    }
    await flushRegisteredSubagents();
  }

  private async reportDiagnostic(key: string, message: string): Promise<void> {
    if (this.reportedDiagnostics.has(key)) return;
    this.reportedDiagnostics.add(key);
    await this.options.onStderr(`[codex-app-server] ${message}\n`);
  }

  private resolveServerRequest(requestId: unknown): void {
    if (typeof requestId !== 'number' && typeof requestId !== 'string') return;
    const controller = this.pendingServerRequests.get(String(requestId));
    if (!controller) return;

    this.pendingServerRequests.delete(String(requestId));
    controller.abort();
  }

  private abortServerRequests(): void {
    for (const [, controller] of this.pendingServerRequests) controller.abort();
    this.pendingServerRequests.clear();
  }

  private writeUnsupportedRequest(id: number | string, message: string): void {
    this.writeRpc({ error: { code: APP_SERVER_UNSUPPORTED_REQUEST_CODE, message }, id });
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.child?.stdin)
      return Promise.reject(new Error('Codex app-server stdin is unavailable'));

    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, APP_SERVER_RPC_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingRequests.set(String(id), {
        reject,
        resolve: (result) => resolve(result as T),
        timeout,
      });
      this.writeRpc({ id, method, params });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.writeRpc({ method, params });
  }

  private writeRpc(message: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private async emitSynthetic(payload: Record<string, unknown>): Promise<void> {
    await this.emitEvents(await this.pipeline.push(`${JSON.stringify(payload)}\n`));
  }

  private async emitEvents(events: AgentStreamEvent[]): Promise<void> {
    if (events.length > 0) await this.options.onEvents(events);
  }

  private emitStatus(state: HeterogeneousAgentRuntimeStatus['state']): void {
    this.options.onRuntimeStatus({
      activeTasks: [],
      lastEventAt: Date.now(),
      operationId: this.options.operationId,
      sessionId: this.options.sessionId,
      state,
      transport: CODEX_APP_SERVER_TRANSPORT,
    });
  }

  private fail(error: Error): void {
    this.fatalError ??= error;
    this.rejectTurn?.(error);
    this.rejectPendingRequests(error);
    this.abortServerRequests();
  }

  private rejectPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private shutdownProcess(signal: NodeJS.Signals): void {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.killed) return;

    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}
