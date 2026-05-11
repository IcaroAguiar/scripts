import { chromium } from 'playwright';
import fs from 'fs';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';
const LESSON_URL = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  // Capture all downloads
  page.on('download', (download) => {
    console.log(`\n!!! DOWNLOAD EVENT !!!`);
    console.log(`Suggested filename: ${download.suggestedFilename()}`);
    console.log(`URL: ${download.url().substring(0, 200)}`);
  });

  console.log('Loading page...');
  await page.goto(LESSON_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log(`URL: ${page.url()}`);

  // Get full body text
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('\n=== Page text (first 3000 chars) ===');
  console.log(bodyText.slice(0, 3000));

  // Check for any clickable elements in the page
  console.log('\n=== Looking for any buttons/links ===');
  const buttons = await page.locator('button').all();
  const links = await page.locator('a').all();
  console.log(`Buttons: ${buttons.length}, Links: ${links.length}`);

  // Try to find elements by regex
  console.log('\n=== Searching with different patterns ===');

  const patterns = ['Estudo', 'Case', 'Material', 'Download', 'PDF', 'Logistica'];
  for (const pattern of patterns) {
    const count = await page.getByText(new RegExp(pattern, 'i')).count();
    console.log(`  "${pattern}": ${count} elements`);
  }

  await browser.close();
}

main().catch(console.error);