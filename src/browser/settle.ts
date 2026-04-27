import type { Page } from 'playwright-core';

/**
 * Wait briefly for the page to be quiescent. Called by every interaction tool
 * before returning so screenshots taken right after a click reflect the post-click DOM.
 * Failure (timeout, navigation, page closed) is intentionally ignored — busy
 * pages that never reach networkidle should not block the tool response.
 */
export async function settle(page: Page, timeoutMs = 2000): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    /* expected on long-polling pages, nav races, or after navigation */
  }
}
