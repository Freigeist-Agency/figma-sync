import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveDir } from './serve.js';

const WIDTHS = [375, 768, 1440];

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
 * @returns {Promise<Array<{ section: string, width: number, file?: string, figma?: "desktop" | "mobile", error?: string }>>}
 */
export async function shootSections({ repoDir, sections, outDir, ready, readyTimeout = 15000 }) {
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

          const loc = page.locator(section.selector).first();
          // Fail fast if the selector is not on the page, rather than Playwright's 30 s default.
          const found = await loc.waitFor({ state: 'attached', timeout: 3500 }).then(() => true, () => false);
          if (!found) {
            shot.error = 'selector not found';
            continue;
          }

          const fileName = `${section.name}-${width}.png`;
          const filePath = path.join(outDir, fileName);
          await loc.screenshot({ path: filePath, timeout: 3500 });

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
