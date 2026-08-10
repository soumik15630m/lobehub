import { describe, expect, it } from 'vitest';

import type { UIChatMessage } from '@/types/index';

import type { SkillMeta } from '../../../providers/SkillContextProvider';
import type { LobeToolManifest } from '../../tools/types';
import { MessagesEngine } from '../MessagesEngine';
import type { MessagesEngineParams } from '../types';

/**
 * Regression tests for preventing duplicate tool/skill docs in LLM payloads:
 * after dynamic activation, the full tool systemRole / skill content must reach
 * the final LLM payload exactly once — either via the system prompt injection
 * OR via the activation tool result, never both.
 *
 * This guards against activation tool results permanently double-carrying
 * manifest docs (once as `role=tool` content, once in subsequent system
 * prompts), which wastes context window space — up to ~50K tokens observed
 * across a single multi-turn agent run.
 */