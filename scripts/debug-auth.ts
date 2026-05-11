import { createBrowserContext, waitForHydration } from '../src/core/browser/browser';
import path from 'node:path';

const authPath = path.join('storage', 'auth', 'themembers.json');

const { browser, page } = await createBrowserContext({
  headless: true,
  storageStatePath: authPath,
  acceptDownloads: false
});

try {
  await page.goto('https://alunos.tetraeducacao.com.br/homepage', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForHydration(page);

  const url = page.url();
  const title = await page.title();
  const hasLogout = await page.locator('a[href*="logout"], button:has-text("Sair")').first().isVisible({ timeout: 3_000 }).catch(() => false);
  const hasLoginForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false);
  const bodyText = await page.locator('body').innerText().catch(() => '');

  console.log('URL:', url);
  console.log('Title:', title);
  console.log('Has logout:', hasLogout);
  console.log('Has login form:', hasLoginForm);
  console.log('Body preview:', bodyText.slice(0, 800));
} finally {
  await browser.close();
}
