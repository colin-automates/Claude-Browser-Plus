import type { Page } from 'playwright-core';

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Click that approximates a human cursor:
 *   - approach from a random nearby offset
 *   - smooth 6–10 step move to target
 *   - pre-press dwell, brief mouse-down hold, release
 *
 * Using raw page.mouse.click() lights up most behavioural bot detectors
 * because the pointer teleports.
 */
export async function humanClick(page: Page, x: number, y: number): Promise<void> {
  const startX = x + rand(-40, 40);
  const startY = y + rand(-40, 40);
  await page.mouse.move(startX, startY);
  const steps = Math.round(rand(6, 10));
  await page.mouse.move(x, y, { steps });
  await sleep(rand(50, 150));
  await page.mouse.down();
  await sleep(rand(50, 130));
  await page.mouse.up();
}

/**
 * Type with per-keystroke jitter (40–120 ms). page.keyboard.type's built-in
 * `delay` is a fixed value; behavioural detectors flag the lack of variance.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(40, 120));
  }
}
