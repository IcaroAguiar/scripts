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

  // Capture ALL relevant requests/responses
  const allRequests: string[] = [];
  const allResponses: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('datadog') && !url.includes('clarity') && !url.includes('google')) {
      allRequests.push(url);
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('datadog') && !url.includes('clarity') && !url.includes('google')) {
      try {
        const status = res.status();
        const headers = res.headers();
        if (status === 200 && (url.includes('material') || url.includes('cloudflarestorage') || url.includes('pdf') || url.includes('zip'))) {
          allResponses.push(`200: ${url.substring(0, 200)}`);
        }
      } catch {}
    }
  });

  page.on('download', (download) => {
    console.log(`\n!!! DOWNLOAD EVENT !!!`);
    console.log(`Suggested filename: ${download.suggestedFilename()}`);
    console.log(`URL: ${download.url().substring(0, 200)}`);
  });

  console.log('Loading page...');
  await page.goto(LESSON_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Get all "Estudo de Caso" text elements
  console.log('\n=== Searching for "Estudo de Caso" ===');
  const elements = await page.getByText('Estudo de Caso', { exact: false }).all();
  console.log(`Found ${elements.length} elements`);

  for (let i = 0; i < elements.length; i++) {
    try {
      const el = elements[i];
      const tag = await el.evaluate((e: Element) => e.tagName);
      const rect = await el.boundingBox();
      const text = await el.innerText().catch(() => '');
      console.log(`  ${i + 1}. <${tag}> "${text.slice(0, 60)}" at (${rect?.x.toFixed(0)}, ${rect?.y.toFixed(0)})`);
    } catch (e) {
      console.log(`  ${i + 1}. Error: ${e.message}`);
    }
  }

  // Try clicking on first element and capture all network activity
  if (elements.length > 0) {
    console.log('\n=== Clicking first "Estudo de Caso" element ===');
    allRequests.length = 0;
    allResponses.length = 0;

    try {
      const el = elements[0];
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: 10000, force: true });
      console.log('Click succeeded');

      // Wait for any network activity
      await page.waitForTimeout(5000);

      // Check current URL
      console.log(`Current URL: ${page.url()}`);

      // Look for any new dialogs/modals
      const dialogs = await page.locator('[role="dialog"], .modal, [class*="modal"]').count();
      console.log(`Dialog count: ${dialogs}`);

      // Print captured responses
      if (allResponses.length > 0) {
        console.log('\n=== Captured material responses ===');
        allResponses.forEach(r => console.log(r));
      } else {
        console.log('\n=== No material responses captured ===');
      }

      // Check if any download happened
      console.log('\n=== Requests made ===');
      allRequests.filter(r => r.includes('material') || r.includes('cloudflarestorage')).slice(0, 20)
        .forEach(r => console.log(r));

    } catch (e: any) {
      console.log(`Click failed: ${e.message}`);
    }
  }

  await browser.close();
}

main().catch(console.error);