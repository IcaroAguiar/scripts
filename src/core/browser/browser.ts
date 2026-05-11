import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs-extra';

export async function createBrowserContext(options: {
  headless: boolean;
  storageStatePath: string;
  acceptDownloads?: boolean;
}): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: options.headless });
  const hasState = await fs.pathExists(options.storageStatePath);
  const context = await browser.newContext({
    ...(hasState ? { storageState: options.storageStatePath } : {}),
    acceptDownloads: options.acceptDownloads ?? false
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);
  return { browser, context, page };
}

export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}

export async function scrollToBottom(page: Page, maxSteps = 8): Promise<void> {
  let previousHeight = 0;
  for (let index = 0; index < maxSteps; index += 1) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === previousHeight) break;
    previousHeight = height;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
  }
}

export async function expandAccordions(page: Page): Promise<void> {
  const candidates = page
    .locator('button, [role="button"], summary, [aria-expanded="false"], [class*="accordion"], [class*="collapse"]')
    .filter({ hasNotText: /^$/ });
  const count = Math.min(await candidates.count(), 25);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const expanded = await candidate.getAttribute('aria-expanded').catch(() => null);
    if (expanded === 'true') continue;
    await candidate.click({ timeout: 300 }).catch(() => undefined);
  }
}
