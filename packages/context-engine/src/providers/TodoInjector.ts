import debug from 'debug';

import { BaseVirtualLastUserContentProvider } from '../base/BaseVirtualLastUserContentProvider';
import type { PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    todoCompletedCount?: number;
    todoCount?: number;
    todoInjected?: boolean;
    todoProcessingCount?: number;
  }
}

const log = debug('context-engine:provider:TodoInjector');

/** Status of a todo item */
export type TodoStatus = 'todo' | 'processing' | 'completed';

/**
 * Todo item structure
 */
export interface TodoItem {
  /** Status of the todo item */
  status: TodoStatus;
  /** The todo item text */
  text: string;
}

/**
 * Todo list structure
 */
export interface TodoList {
  items: TodoItem[];
  updatedAt: string;
}

export interface TodoInjectorConfig {
  /** Whether Todo injection is enabled */
  enabled?: boolean;
  /** The current todo list to inject */
  todos?: TodoList;
}

/**
 * Format Todo list content for injection
 */
function formatTodos(todos: TodoList): string | null {
  const { items } = todos;

  if (!items || items.length === 0) {
    return null;
  }

  const lines: string[] = ['<todos>'];

  items.forEach((item, index) => {
    lines.push(`<todo index="${index}" status="${item.status}">${item.text}</todo>`);
  });

  const completedCount = items.filter((item) => item.status === 'completed').length;
  const processingCount = items.filter((item) => item.status === 'processing').length;
  const totalCount = items.length;
  lines.push(
    `<progress completed="${completedCount}" processing="${processingCount}" total="${totalCount}" />`,
  );

  lines.push('</todos>');

  return lines.join('\n');
}

/**
 * Todo Injector
 * Responsible for injecting the current todo list as a virtual tail user message.
 * This provides the AI with real-time awareness of task progress.
 *
 * The TODO list is rewritten on every create/update/clear, so it must never touch a
 * historical message. In a tool loop the "last user message" is the user's original
 * question (everything after it is assistant/tool), so appending there rewrote the
 * second message of the payload and knocked the whole assistant/tool history out of
 * the provider's prefix cache on every TODO change. Keeping the state in a synthetic
 * tail message confines the churn to the last message.
 */
export class TodoInjector extends BaseVirtualLastUserContentProvider {
  readonly name = 'TodoInjector';

  constructor(
    private config: TodoInjectorConfig,
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  /**
   * TODO state changes every step, so it must always live in its own synthetic message —
   * never folded into the user's real message (which is the tail on the first turn).
   */
  protected get appendToRealLastUser(): boolean {
    return false;
  }

  protected shouldSkip(context: PipelineContext): boolean {
    if (!this.config.enabled || !this.config.todos) {
      log('Todo not enabled or no todos, skipping injection');
      return true;
    }

    // Keep the previous guard: without any user turn there is no conversation to report
    // progress against.
    if (!context.messages.some((message) => message.role === 'user')) {
      log('No user messages found, skipping injection');
      return true;
    }

    return false;
  }

  protected buildContent(_context: PipelineContext): string | null {
    const formattedContent = formatTodos(this.config.todos!);

    if (!formattedContent) {
      log('No todos to inject (empty list)');
      return null;
    }

    log('Formatted content length:', formattedContent.length);

    return this.wrapWithSystemContext(formattedContent, 'todo_context');
  }

  protected onInjected(context: PipelineContext): void {
    const { items } = this.config.todos!;

    context.metadata.todoInjected = true;
    context.metadata.todoCount = items.length;
    context.metadata.todoCompletedCount = items.filter(
      (item) => item.status === 'completed',
    ).length;
    context.metadata.todoProcessingCount = items.filter(
      (item) => item.status === 'processing',
    ).length;

    log('Todo context injected as virtual tail user message');
  }
}
