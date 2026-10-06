import { isRecord } from '@lobechat/utils/object';

import type { ThreadStartParams } from './protocol';

/** These values identify one run; credentials and every other setting stay process-scoped. */
const CODEX_PROVENANCE_KEYS = [
  'LOBEHUB_AGENT_ID',
  'LOBEHUB_OPERATION_ID',
  'LOBEHUB_TOPIC_ID',
] as const;

const isProvenanceKey = (key: string) => (CODEX_PROVENANCE_KEYS as readonly string[]).includes(key);

export type CodexRunProvenance = Partial<Record<(typeof CODEX_PROVENANCE_KEYS)[number], string>>;

/** Picks only the run provenance from a launch environment. */
export const pickCodexRunProvenance = (env: NodeJS.ProcessEnv): CodexRunProvenance =>
  Object.fromEntries(CODEX_PROVENANCE_KEYS.map((key) => [key, env[key]]));

/**
 * Environment for the shared app-server process: defined values only, without run provenance,
 * so neither reuse checks nor a reconnect can carry the first run's IDs.
 */
export const getCodexProcessEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const processEnv = { ...env };
  for (const key of Object.keys(processEnv)) {
    if (isProvenanceKey(key) || processEnv[key] === undefined) delete processEnv[key];
  }
  return processEnv;
};

/**
 * Sets run provenance in a thread's shell environment. Missing IDs become empty strings, so
 * config saved with the thread cannot revive an earlier run's values.
 */
export const withCodexThreadEnv = (
  params: ThreadStartParams,
  provenance: CodexRunProvenance,
): ThreadStartParams => {
  const set = Object.fromEntries(CODEX_PROVENANCE_KEYS.map((key) => [key, provenance[key] ?? '']));
  const config = { ...params.config };
  // Config accepts nested and dotted keys; keep every spelling identical so an ancestor
  // override cannot restore stale IDs.
  const policy = config.shell_environment_policy;
  if (isRecord(policy)) {
    config.shell_environment_policy = {
      ...policy,
      set: { ...(isRecord(policy.set) ? policy.set : {}), ...set },
    };
  }
  const dottedSet = config['shell_environment_policy.set'];
  if (isRecord(dottedSet)) config['shell_environment_policy.set'] = { ...dottedSet, ...set };
  for (const key of CODEX_PROVENANCE_KEYS) config[`shell_environment_policy.set.${key}`] = set[key];
  return { ...params, config };
};

/** Whether two runs would give the thread's shell the same IDs. */
export const isSameCodexRunProvenance = (a: CodexRunProvenance, b: CodexRunProvenance) =>
  CODEX_PROVENANCE_KEYS.every((key) => (a[key] ?? '') === (b[key] ?? ''));
