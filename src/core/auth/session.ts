import fs from 'fs-extra';
import type { BrowserContext, Page } from 'playwright';

export async function persistStorageState(context: BrowserContext, authStatePath: string): Promise<void> {
  await fs.ensureDir(authStatePath.split('/').slice(0, -1).join('/'));
  await context.storageState({ path: authStatePath });
}

export async function fillLoginForm(page: Page, email: string, password: string): Promise<boolean> {
  const emailLocator = page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"]').first();
  const passwordLocator = page
    .locator('input[type="password"], input[name*="password" i], input[autocomplete="current-password"]')
    .first();

  if ((await emailLocator.count()) === 0 || (await passwordLocator.count()) === 0) {
    return false;
  }

  await emailLocator.fill(email);
  await passwordLocator.fill(password);
  await page
    .getByRole('button', { name: /entrar|login|acessar|sign in/i })
    .click({ timeout: 5_000 })
    .catch(async () => {
      await passwordLocator.press('Enter');
    });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return true;
}
