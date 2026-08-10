import { CONTEXT_INSTRUCTION, SYSTEM_CONTEXT_END, SYSTEM_CONTEXT_START } from './constants';

/**
 * Wrap content with system context markers
 * Following the format from @lobechat/prompts files/index.ts
 */
export const wrapWithSystemContext = (content: string, contextType: string): string =>
  `${SYSTEM_CONTEXT_START}
${CONTEXT_INSTRUCTION}
<${contextType}>
${content}
</${contextType}>
${SYSTEM_CONTEXT_END}`;

/**
 * Create a context block without the full wrapper (for inserting into an existing wrapper)
 */
export const createContextBlock = (content: string, contextType: string): string =>
  `<${contextType}>
${content}
</${contextType}>`;
