import type { Message, PipelineContext, ProcessorOptions } from '../types';
import { BaseProcessor } from './BaseProcessor';
import { VIRTUAL_LAST_USER_MARKER } from './constants';
import { wrapWithSystemContext } from './systemContext';

/**
 * Base provider for injecting content at the virtual "last user" position.
 *
 * Behavior:
 * - If the current last message is a user message, append to it directly
 * - Otherwise create a synthetic user message at the tail of the message list
 * - Multiple virtual-last-user providers can reuse the same synthetic tail message
 *
 * This is intended for high-churn runtime guidance that should stay at the end
 * of the prompt so earlier stable prefixes can still benefit from cache hits.
 */
export abstract class BaseVirtualLastUserContentProvider extends BaseProcessor {
  constructor(options: ProcessorOptions = {}) {
    super(options);
  }

  /**
   * Whether this provider may append its content to a *real* (user-authored) last message.
   *
   * Defaults to `true` for guidance that only ever appears on the turn it is built for.
   * Providers whose content changes on every step — TODO state, progress counters — must
   * override this to `false`: on the first turn of a topic the real user message *is* the
   * last message, so appending there would rewrite a message that the rest of the run wants
   * to keep byte-identical for prefix caching.
   */
  protected get appendToRealLastUser(): boolean {
    return true;
  }

  /**
   * Build the content to inject.
   */
  protected abstract buildContent(context: PipelineContext): string | null;

  /**
   * Allow subclasses to skip injection based on the current context.
   */
  protected shouldSkip(_context: PipelineContext): boolean {
    return false;
  }

  /**
   * Hook invoked after content has been injected, for metadata bookkeeping.
   */
  protected onInjected(_context: PipelineContext): void {}

  /**
   * Whether a message is a synthetic tail message created by this base class.
   */
  protected isVirtualLastUserMessage(message: Message | undefined): boolean {
    return message?.role === 'user' && message.meta?.[VIRTUAL_LAST_USER_MARKER] === true;
  }

  /**
   * Wrap content with the shared system-context markers.
   */
  protected wrapWithSystemContext(content: string, contextType: string): string {
    return wrapWithSystemContext(content, contextType);
  }

  /**
   * Create metadata for the synthetic tail user message.
   */
  protected createVirtualLastUserMeta(): Record<string, any> {
    return {
      injectType: this.name,
      [VIRTUAL_LAST_USER_MARKER]: true,
    };
  }

  /**
   * Create a synthetic tail user message.
   */
  protected createVirtualLastUserMessage(content: string): Message {
    return {
      content,
      createdAt: Date.now(),
      id: `virtual-last-user-${this.name}-${Date.now()}`,
      meta: this.createVirtualLastUserMeta(),
      role: 'user' as const,
      updatedAt: Date.now(),
    };
  }

  /**
   * Append content to an existing user message.
   */
  protected appendToMessage(message: Message, contentToAppend: string): Message {
    const currentContent = message.content;

    if (typeof currentContent === 'string') {
      return {
        ...message,
        content: currentContent + '\n\n' + contentToAppend,
        updatedAt: Date.now(),
      };
    }

    if (Array.isArray(currentContent)) {
      const lastTextIndex = currentContent.findLastIndex((part: any) => part.type === 'text');

      if (lastTextIndex !== -1) {
        const newContent = [...currentContent];
        newContent[lastTextIndex] = {
          ...newContent[lastTextIndex],
          text: newContent[lastTextIndex].text + '\n\n' + contentToAppend,
        };

        return {
          ...message,
          content: newContent,
          updatedAt: Date.now(),
        };
      }

      return {
        ...message,
        content: [...currentContent, { text: contentToAppend, type: 'text' }],
        updatedAt: Date.now(),
      };
    }

    return message;
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    if (this.shouldSkip(context)) {
      return this.markAsExecuted(context);
    }

    const content = this.buildContent(context);

    if (!content) {
      return this.markAsExecuted(context);
    }

    const clonedContext = this.cloneContext(context);
    const lastMessage = clonedContext.messages.at(-1);
    const canAppend =
      lastMessage?.role === 'user' &&
      (this.appendToRealLastUser || this.isVirtualLastUserMessage(lastMessage));

    if (canAppend) {
      clonedContext.messages[clonedContext.messages.length - 1] = this.appendToMessage(
        lastMessage!,
        content,
      );
    } else {
      clonedContext.messages.push(this.createVirtualLastUserMessage(content));
    }

    this.onInjected(clonedContext);

    return this.markAsExecuted(clonedContext);
  }
}
