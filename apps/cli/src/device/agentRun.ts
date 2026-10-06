import { spawn } from 'node:child_process';

import {
  buildHeteroExecStdinPayload,
  HETERO_EXEC_INHERIT_PROCESS_GROUP_ENV,
  type HeteroExecImageRef,
} from '@lobechat/heterogeneous-agents/protocol';
import { resolveHeteroSpawnCwd } from '@lobechat/heterogeneous-agents/workingDirectory';

import { getTask, removeTask, saveTask } from '../daemon/taskRegistry';
import { registerAgentRun } from './agentRunRegistry';

/** Immutable execution context for one gateway-dispatched agent operation. */
export interface SpawnHeteroAgentRunParams {
  /** Conversation agent identity; omitted requests never inherit the connector's agent. */
  agentId?: string;
  /** Native CLI runtime selected by the dispatch request. */
  agentType: string;
  /** Resolved `lh hetero exec` wrapper args. */
  args?: string[];
  /** Assistant message receiving this operation's ingested events. */
  assistantMessageId?: string;
  /** Native working directory. @default process.cwd() */
  cwd?: string;
  /** Image attachments (signed URLs) appended as image content blocks. */
  imageList?: HeteroExecImageRef[];
  /** Operation-scoped credential used by the wrapper's ingest requests. */
  jwt: string;
  /** Unique execution identity and cancellation lookup key. */
  operationId: string;
  /** User input delivered through stdin without shell interpolation. */
  prompt: string;
  /** System context used only by the automatic retry without native resume. */
  resumeFallbackSystemContext?: string;
  /** Native session to continue; absence starts a new session. */
  resumeSessionId?: string;
  /** Backend origin receiving execution events. */
  serverUrl: string;
  /** Conversation context prepended when starting a native session. */
  systemContext?: string;
  /** Persisted conversation owning the operation. */
  topicId: string;
  /** Topic/run workspace — forwarded as `LOBEHUB_WORKSPACE_ID` for ingest. */
  workspaceId?: string;
}

/** Whether the device successfully started the operation wrapper process. */
export interface AgentRunAckResult {
  /** Spawn failure explanation, present for rejected requests. */
  reason?: string;
  /** Spawn outcome only; accepted does not mean execution completed. */
  status: 'accepted' | 'rejected';
}

interface SpawnHeteroAgentRunLogger {
  error?: (msg: string) => void;
  info?: (msg: string) => void;
}

/**
 * Spawn `lh hetero exec` for a gateway-dispatched agent run. Mirrors the
 * desktop app's `spawnLhHeteroExec`: the spawned CLI owns the full pipeline
 * (spawn -> adapt -> BatchIngester -> server ingest), so the connect daemon
 * needs no local stream handling — it only kicks off the process.
 *
 * Re-invokes the current CLI entry (`process.execPath` + `process.argv[1]`)
 * instead of relying on `lh` being on `PATH`, so it also works inside the
 * detached `lh connect --daemon` child where `PATH` may be minimal.
 *
 * Resolves only once the child's outcome is known: `accepted` on the `spawn`
 * event, `rejected` on an early wrapper-process `error`. A missing target cwd
 * is handled inside `lh hetero exec`, which can classify it and emit
 * `heteroFinish`; other wrapper spawn failures flow back as rejected dispatches.
 *
 * Use when:
 * - A connected device receives an authorized agent run from its gateway.
 *
 * Expects:
 * - Request-scoped identity and credentials belong to this operation.
 * - Native resume IDs identify the requested conversation, not the connector.
 *
 * Returns:
 * - A spawn acknowledgement; execution output is delivered by the wrapper's ingest pipeline.
 *
 * Call stack:
 *
 * connect gateway agent_run_request
 *   -> {@link spawnHeteroAgentRun}
 *     -> lh hetero exec -> native agent CLI -> server ingest
 *     -> {@link registerAgentRun} / {@link saveTask}
 */
export function spawnHeteroAgentRun(
  params: SpawnHeteroAgentRunParams,
  logger?: SpawnHeteroAgentRunLogger,
): Promise<AgentRunAckResult> {
  const {
    agentId,
    agentType,
    assistantMessageId,
    args: extraArgs,
    cwd,
    imageList,
    jwt,
    operationId,
    prompt,
    resumeFallbackSystemContext,
    resumeSessionId,
    serverUrl,
    systemContext,
    topicId,
    workspaceId,
  } = params;
  const workDir = cwd ?? process.cwd();
  // A stale project path must not prevent the wrapper CLI from starting: the
  // inner spawnAgent preflight owns cwd classification and reports the
  // structured working_directory_not_found error through heteroFinish.
  const spawnCwd = resolveHeteroSpawnCwd(workDir);

  // Server-ingest mode (--topic + --operation-id): events are batch-POSTed to
  // the server, not rendered. `--input-json -` reads the prompt from stdin.
  const cliArgs = [
    process.argv[1],
    'hetero',
    'exec',
    '--type',
    agentType,
    '--operation-id',
    operationId,
    '--topic',
    topicId,
    '--render',
    'none',
    '--input-json',
    '-',
    '--cwd',
    workDir,
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...(extraArgs ?? []),
  ];

  // systemContext / image attachments turn the payload into a content-block
  // array: context block first, then the user's prompt, then images — mirrors
  // the desktop path. `lh hetero exec` coerces both shapes via
  // coerceJsonPrompt.
  const stdinPayload = buildHeteroExecStdinPayload({
    imageList,
    isNewSession: !resumeSessionId,
    prompt,
    resumeFallbackSystemContext,
    systemContext,
  });

  // A connector can itself be started inside another agent run. Its ambient
  // identity belongs to the launcher, not this dispatched conversation; CLI
  // evidence commands must never attach this run's outputs to that ancestor.
  const childEnv = { ...process.env };
  for (const key of [
    'LOBEHUB_AGENT_ID',
    'LOBEHUB_ASSISTANT_MESSAGE_ID',
    'LOBEHUB_TASK_ID',
    'LOBEHUB_WORKSPACE_ID',
  ]) {
    delete childEnv[key];
  }

  return new Promise<AgentRunAckResult>((resolve) => {
    let settled = false;
    const settle = (result: AgentRunAckResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let pid: number | undefined;
    const child = spawn(process.execPath, [...process.execArgv, ...cliArgs], {
      cwd: spawnCwd,
      detached: true,
      env: {
        ...childEnv,
        ...(agentId ? { LOBEHUB_AGENT_ID: agentId } : {}),
        ...(assistantMessageId ? { LOBEHUB_ASSISTANT_MESSAGE_ID: assistantMessageId } : {}),
        [HETERO_EXEC_INHERIT_PROCESS_GROUP_ENV]: '1',
        LOBEHUB_JWT: jwt,
        LOBEHUB_OPERATION_ID: operationId,
        LOBEHUB_SERVER: serverUrl,
        LOBEHUB_TOPIC_ID: topicId,
        ...(workspaceId ? { LOBEHUB_WORKSPACE_ID: workspaceId } : {}),
      },
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });

    child.once('spawn', () => {
      registerAgentRun(operationId, child);
      // Register the child into the task registry so `cancelHeteroTask`
      // dispatched from the server can resolve it by operationId and signal
      // the whole process group. `detached: true` places the CLI in its own
      // group; the inherited-group env contract keeps its agent descendants
      // in that same group without affecting the connect daemon.
      pid = child.pid;
      if (pid !== undefined) {
        saveTask({
          agentId,
          agentType,
          operationId,
          pid,
          startedAt: new Date().toISOString(),
          taskId: operationId,
          topicId,
          workspaceId,
        });
      }

      // Only safe to write stdin once the process actually started.
      try {
        child.stdin?.write(stdinPayload);
        child.stdin?.end();
      } catch (err) {
        logger?.error?.(
          `hetero exec stdin write failed (op=${operationId}): ${(err as Error).message}`,
        );
      }
      settle({ status: 'accepted' });
    });

    child.once('error', (err) => {
      logger?.error?.(`hetero exec spawn failed (op=${operationId}): ${err.message}`);
      settle({ reason: err.message, status: 'rejected' });
    });

    child.on('exit', (code, signal) => {
      // Only remove the registry entry if the exiting PID still owns this
      // task — a newer run that reused the same operationId must not be
      // cleared by a stale exit event.
      if (pid !== undefined && getTask(operationId)?.pid === pid) {
        removeTask(operationId);
      }
      logger?.info?.(`hetero exec exited (op=${operationId}) code=${code} signal=${signal}`);
    });
  });
}
