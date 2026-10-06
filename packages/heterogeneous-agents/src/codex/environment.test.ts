import { describe, expect, it } from 'vitest';

import { pickCodexRunProvenance, withCodexThreadEnv } from './environment';

describe('Codex thread environment', () => {
  it('picks only run provenance from a launch environment', () => {
    expect(
      pickCodexRunProvenance({
        CODEX_HOME: '/codex',
        LOBEHUB_JWT: 'test-token',
        LOBEHUB_OPERATION_ID: 'op',
        LOBEHUB_TOPIC_ID: 'topic',
      }),
    ).toEqual({
      LOBEHUB_AGENT_ID: undefined,
      LOBEHUB_OPERATION_ID: 'op',
      LOBEHUB_TOPIC_ID: 'topic',
    });
  });

  it('overrides stale provenance in every config spelling and keeps other settings', () => {
    const params = {
      config: {
        'model_reasoning_effort': 'low',
        'shell_environment_policy': {
          inherit: 'all',
          set: { EXTRA: 'kept', LOBEHUB_OPERATION_ID: 'old' },
        },
        'shell_environment_policy.set': { ANOTHER: 'kept', LOBEHUB_TOPIC_ID: 'old' },
        'shell_environment_policy.set.LOBEHUB_OPERATION_ID': 'old',
      },
      cwd: '/workspace',
    };

    const result = withCodexThreadEnv(params, { LOBEHUB_OPERATION_ID: 'current' });

    expect(result.config).toMatchObject({
      'model_reasoning_effort': 'low',
      'shell_environment_policy': {
        inherit: 'all',
        set: { EXTRA: 'kept', LOBEHUB_OPERATION_ID: 'current', LOBEHUB_TOPIC_ID: '' },
      },
      'shell_environment_policy.set': {
        ANOTHER: 'kept',
        LOBEHUB_OPERATION_ID: 'current',
        LOBEHUB_TOPIC_ID: '',
      },
      'shell_environment_policy.set.LOBEHUB_OPERATION_ID': 'current',
    });
    expect(params.config.shell_environment_policy.set.LOBEHUB_OPERATION_ID).toBe('old');
  });
});
