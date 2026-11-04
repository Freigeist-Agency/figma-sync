import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveDir } from './serve.js';

const WIDTHS = [375, 768, 1440];

/**
 * Scrolls the whole page once from top to bottom and back, then waits for all images to complete.
 * Ensures lazy-loaded images and scroll-triggered content run before section screenshots.
 *
 * @param {import('playwright').Page} page
 */
export async function settlePage(page) {
  await page.evaluate(async () => {
    const vh = window.innerHeight;
    const getScrollHeight = () =>
      Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);

    if (getScrollHeight() > vh) {
      for (let y = vh; y < getScrollHeight(); y += vh) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      for (let y = window.scrollY; y > 0; y -= vh) {
        window.scrollTo({ top: Math.max(0, y - vh), behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  });

  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('img')).every((img) => img.complete),
      { timeout: 5000 }
    );
  } catch {
    // A timeout is not an error, carry on.
  }
}

/**
 * Shoots screenshots of given sections at 3 widths (375, 768, 1440).
 * Pairs 1440 with desktop and 375 with mobile.
 * Selector not found returns an error object without throwing.
 *
 * @param {Object} options
 * @param {string} options.repoDir
 * @param {Array<{ name: string, selector: string, page: string }>} options.sections
 * @param {string} options.outDir
 * @param {string} [options.ready]
 * @param {number} [options.readyTimeout=15000]
 * @param {(page: import('playwright').Page, section: { name: string, selector: string, page: string }) => Promise<void>|void} [options.onBeforeShot]
 * @returns {Promise<Array<{ section: string, width: number, file?: string, figma?: "desktop" | "mobile", error?: string }>>}
 */
export async function shootSections({ repoDir, sections, outDir, ready, readyTimeout = 15000, onBeforeShot }) {
  fs.mkdirSync(outDir, { recursive: true });

  const server = await serveDir(repoDir);
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const shots = [];

    for (const section of sections) {
      for (const width of WIDTHS) {
        const shot = {
          section: section.name,
          width
        };
        if (width === 1440) shot.figma = 'desktop';
        if (width === 375) shot.figma = 'mobile';

        const page = await browser.newPage({
          viewport: { width, height: 900 }
        });

        try {
          const pagePath = section.page.startsWith('/') ? section.page : `/${section.page}`;
          await page.goto(`${server.url}${pagePath}`, { waitUntil: 'load' });
          if (ready) {
            try {
              await page.locator(ready).first().waitFor({ state: 'attached', timeout: readyTimeout });
            } catch {
              shot.error = `page never became ready (${ready})`;
              continue;
            }
          }
          await page.evaluate(() => document.fonts?.ready);
          await settlePage(page);

          const loc = page.locator(section.selector).first();
          // Fail fast if the selector is not on the page, rather than Playwright's 30 s default.
          const found = await loc.waitFor({ state: 'attached', timeout: 3500 }).then(() => true, () => false);
          if (!found) {
            shot.error = 'selector not found';
            continue;
          }

          if (onBeforeShot) {
            await onBeforeShot(page, section);
          }

          const fileName = `${section.name}-${width}.png`;
          const filePath = path.join(outDir, fileName);
          await loc.screenshot({ path: filePath, timeout: 15000 });

          shot.file = fileName;
        } catch (err) {
          // Report the real cause (navigation, screenshot) instead of blaming the selector.
          shot.error = err.message || String(err);
        } finally {
          await page.close();
          shots.push(shot);
        }
      }
    }

    return shots;
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.close();
  }
}

/**
 * Smoke checks pages across widths 375, 768, 1440.
 * Detects console errors, uncaught page errors, and horizontal overflow.
 *
 * @param {Object} options
 * @param {string} options.repoDir
 * @param {string[]} options.pages
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function smoke({ repoDir, pages }) {
  const server = await serveDir(repoDir);
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const problems = [];

    for (const pageName of pages) {
      for (const width of WIDTHS) {
        const page = await browser.newPage({
          viewport: { width, height: 900 }
        });

        const consoleErrors = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            consoleErrors.push(msg.text());
          }
        });
        page.on('pageerror', (err) => {
          consoleErrors.push(err.message || String(err));
        });

        try {
          const pagePath = pageName.startsWith('/') ? pageName : `/${pageName}`;
          await page.goto(`${server.url}${pagePath}`, { waitUntil: 'load' });
          await page.evaluate(() => document.fonts?.ready);

          // Check horizontal overflow
          const hasOverflow = await page.evaluate(() => {
            return document.documentElement.scrollWidth > window.innerWidth;
          });

          if (hasOverflow) {
            problems.push(`${pageName} at ${width}px: horizontal overflow (scrollWidth > innerWidth)`);
          }

          for (const err of consoleErrors) {
            problems.push(`${pageName} at ${width}px: console error: ${err}`);
          }
        } catch (err) {
          problems.push(`${pageName} at ${width}px: navigation error: ${err.message || String(err)}`);
        } finally {
          await page.close();
        }
      }
    }

    return {
      ok: problems.length === 0,
      problems
    };
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.close();
  }
}
