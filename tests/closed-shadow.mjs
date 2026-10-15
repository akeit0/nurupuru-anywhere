import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { selectors } from 'playwright';

// Only the debugger sees this reference, in Playwright's isolated world.
// No test hooks or open roots are added to the extension or the page's world.
await selectors.register('nuru', () => ({
  query(root, selector) { return globalThis.__nurupuruTestRoot?.host.isConnected ? globalThis.__nurupuruTestRoot.querySelector(selector) : null; },
  queryAll(root, selector) { return globalThis.__nurupuruTestRoot?.host.isConnected ? [...globalThis.__nurupuruTestRoot.querySelectorAll(selector)] : []; },
}), { contentScript: true });

export async function closedUI(page) {
  const cdp = await page.context().newCDPSession(page), contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  await cdp.send('Runtime.enable');
  await page.locator('html').count();
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const utility = [...contexts.values()].find(context => context.name.startsWith('__playwright_utility_world') && context.auxData?.frameId === frameTree.frame.id);
  assert.ok(utility, 'Playwright isolated world exists');
  async function refresh() {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#nurupuru-anywhere' });
    assert.ok(nodeId, 'extension host exists');
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 1, pierce: true });
    const shadow = node.shadowRoots?.[0];
    assert.equal(shadow?.shadowRootType, 'closed', 'the actual root is closed');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId, executionContextId: utility.id });
    try {
      await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){globalThis.__nurupuruTestRoot=this;}' });
    } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
  }
  async function evaluate(fn, arg) {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      contextId: utility.id, expression: `(${fn})(globalThis.__nurupuruTestRoot,${JSON.stringify(arg) ?? 'undefined'})`, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  async function waitFor(fn, arg) {
    const deadline = Date.now() + 10000;
    while (!await evaluate(fn, arg)) { if (Date.now() >= deadline) throw Error('Timed out waiting for closed UI: ' + fn);await setTimeout(20); }
  }
  await refresh();
  const control = selector => page.locator('nuru=' + selector);
  return { control, ui: id => control('#' + id), refresh, evaluate, waitFor };
}
