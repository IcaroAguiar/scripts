import { chromium } from 'playwright';
import fs from 'fs';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';
const LESSON_URL = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-02-introducao-ao-storytelling-de-dados339087634/dfc4fbf6-8e1b-42a0-b144-813aeb0c7d1a';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  // Capture ALL network requests/responses
  const networkLog: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    networkLog.push(`REQ: ${url}`);
  });

  page.on('response', (res) => {
    const url = res.url();
    networkLog.push(`RES ${res.status()}: ${url}`);
  });

  page.on('download', (download) => {
    console.log(`\n!!! DOWNLOAD !!!`);
    console.log(`Filename: ${download.suggestedFilename()}`);
    console.log(`URL: ${download.url()}`);
  });

  console.log('Loading lesson page...');
  await page.goto(LESSON_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log(`URL: ${page.url()}`);

  // Get the "Material complementar" element
  const materialComplementar = page.getByText('Material complementar', { exact: true });
  const count = await materialComplementar.count();
  console.log(`Found ${count} "Material complementar" elements`);

  if (count > 0) {
    const el = materialComplementar.first();
    const rect = await el.boundingBox();
    console.log(`Element rect: ${JSON.stringify(rect)}`);

    // Clear network log before click
    networkLog.length = 0;
    console.log('\nCleared network log, clicking...');

    try {
      await el.click({ timeout: 10000 });
      console.log('Click succeeded');

      // Wait for network activity
      await page.waitForTimeout(5000);

      // Check for any new downloads
      console.log(`\nCurrent URL: ${page.url()}`);

      // Look for network requests to material endpoints
      const materialRequests = networkLog.filter(l =>
        l.includes('material') ||
        l.includes('cloudflarestorage') ||
        l.includes('pdf') ||
        l.includes('zip') ||
        l.includes('download')
      );

      console.log(`\nMaterial-related network activity: ${materialRequests.length}`);
      materialRequests.slice(0, 20).forEach(r => console.log(r));

    } catch (e) {
      console.log(`Click failed: ${e.message}`);
    }
  }

  // Print full network log if no material requests found
  console.log('\n--- All network activity (first 50 lines) ---');
  networkLog.slice(0, 50).forEach(r => console.log(r));

  await browser.close();
}

main().catch(console.error);