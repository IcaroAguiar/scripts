import { createBrowserContext, waitForHydration, expandAccordions, scrollToBottom } from '../src/core/browser/browser';
import path from 'node:path';

const authPath = path.join('storage', 'auth', 'themembers.json');
const lessonUrl = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-abertura-cinco-pilares1105220020/60c4770a-b355-4fa8-9286-736497bb64db';

const { browser, page } = await createBrowserContext({
  headless: true,
  storageStatePath: authPath,
  acceptDownloads: false
});

try {
  console.log('=== Homepage ===');
  await page.goto('https://alunos.tetraeducacao.com.br/homepage', { waitUntil: 'load', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  console.log('URL:', page.url());

  const cookies = await page.context().cookies();
  const tokenCookie = cookies.find(c => c.name === 'token');
  console.log('Token cookie:', tokenCookie ? (tokenCookie.value ? '(set)' : '(empty)') : '(missing)');
  console.log('rememberMe cookie:', cookies.find(c => c.name === 'rememberMe') ? '(set)' : '(missing)');

  console.log('\n=== Check if URL changed after wait ===');
  await page.waitForTimeout(5_000);
  console.log('URL after 5s:', page.url());
  const bodyAfter = await page.locator('body').innerText().catch(() => '');
  console.log('Body after 5s:', bodyAfter.slice(0, 400));

  console.log('\n=== Try lesson navigation with proper wait ===');
  await page.goto(lessonUrl, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(5_000);
  console.log('URL:', page.url());
  const bodyLesson = await page.locator('body').innerText().catch(() => '');
  console.log('Body:', bodyLesson.slice(0, 600));

  const mainContent = await page.evaluate(() => {
    const main = document.querySelector('main, article, [role="main"]');
    return main?.textContent?.trim().slice(0, 1000) ?? 'No main';
  });
  console.log('\nMain:', mainContent);

  const allLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .filter(a => /\/aula-/i.test(a.href))
      .map(a => ({ text: a.textContent?.trim().slice(0, 80), href: a.href }))
      .slice(0, 3)
  );
  console.log('\nLesson links:', JSON.stringify(allLinks, null, 2));

  const allContent = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('h1, h2, h3, .lesson-title, [class*="lesson"]'))
      .map(el => ({ tag: el.tagName, text: el.textContent?.trim().slice(0, 80) }))
      .slice(0, 10);
  });
  console.log('\nLesson-related elements:', JSON.stringify(allContent, null, 2));
} finally {
  await browser.close();
}
