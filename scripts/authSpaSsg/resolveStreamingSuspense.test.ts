import { describe, expect, it } from 'vitest';

import { resolveStreamingSuspense } from './resolveStreamingSuspense';

describe('resolveStreamingSuspense', () => {
  it('replaces a completed streaming fallback with its static segment', () => {
    const html = `<!doctype html><html><body><div id="root"><!--$?--><template id="B:0"></template><div role="status">Loading</div><!--/$--><script>requestAnimationFrame(function(){$RT=performance.now()});</script><div hidden id="S:0"><main>Sign in</main></div><script>$RC=function(){};$RC("B:0","S:0")</script></div></body></html>`;
    const result = resolveStreamingSuspense(html);

    expect(result).toContain('<!--$--><main>Sign in</main><!--/$-->');
    expect(result).not.toContain('Loading');
    expect(result).not.toContain('id="B:0"');
    expect(result).not.toContain('id="S:0"');
    expect(result).not.toContain('$RC=');
  });
});
