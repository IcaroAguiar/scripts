import { chromium } from 'playwright';
import fs from 'fs';

const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_URL = `${BASE_URL}/login`;
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: fs.existsSync(AUTH_PATH) ? AUTH_PATH : undefined,
    acceptDownloads: true
  });
  const page = await context.newPage();

  // Capture ALL requests
  const allRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('datadog') && !url.includes('clarity') && !url.includes('google') && !url.includes('doubleclick')) {
      allRequests.push(`REQ: ${url.substring(0, 200)}`);
    }
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('datadog') && !url.includes('clarity') && !url.includes('google') && !url.includes('doubleclick')) {
      allRequests.push(`RES: ${res.status()} ${url.substring(0, 200)}`);
    }
  });

  page.on('download', (download) => {
    console.log(`DOWNLOAD triggered: ${download.suggestedFilename()}`);
  });

  console.log('Loading login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  console.log(`URL after load: ${page.url()}`);

  // Check if we need to login
  const needsLogin = await page.locator('input[name="email"]').count() > 0;

  if (needsLogin) {
    console.log('Logging in manually...');
    await page.evaluate(`document.querySelector('input[name="email"]').value = '${EMAIL}'`);
    await page.evaluate(`document.querySelector('input[name="password"]').value = '${PASSWORD}'`);
    await page.evaluate(`document.querySelector('button[type="submit"]').click()`);
    await page.waitForTimeout(4000);
    console.log(`URL after login: ${page.url()}`);
  } else {
    console.log('Already logged in (no email field found)');
  }

  const lessonUrl = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b';
  console.log(`\nNavigating to: ${lessonUrl}`);

  allRequests.length = 0;
  await page.goto(lessonUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  console.log(`Current URL: ${page.url()}`);

  // Print page text to see what's there
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('\n--- Page text (first 1500 chars) ---');
  console.log(bodyText.slice(0, 1500));

  // Find all clickable elements that contain "Estudo"
  console.log('\n--- Searching for Estudo elements ---');
  const estElements = await page.getByText(/Estudo/i).all();
  console.log(`Found ${estElements.length} elements containing "Estudo"`);

  for (let i = 0; i < Math.min(estElements.length, 10); i++) {
    try {
      const el = estElements[i];
      const tag = await el.evaluate((e: Element) => e.tagName);
      const text = await el.innerText().catch(() => '');
      const rect = await el.boundingBox().catch(() => null);
      console.log(`  ${i + 1}. <${tag}> "${text.slice(0, 60)}" rect: ${rect ? `${rect.x.toFixed(0)},${rect.y.toFixed(0)} ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}` : 'null'}`);
    } catch (e) {
      console.log(`  ${i + 1}. Error: ${e.message}`);
    }
  }

  // Try clicking on the first Estudo element
  if (estElements.length > 0) {
    console.log('\n--- Attempting click ---');
    allRequests.length = 0;

    try {
      const el = estElements[0];
      const rect = await el.boundingBox();
      console.log(`Clicking element at: ${rect?.x}, ${rect?.y}`);

      await el.click({ timeout: 10000, force: true });
      console.log('Click succeeded');

      await page.waitForTimeout(3000);
      console.log(`URL after click: ${page.url()}`);

      // Look for any download or navigation
      console.log('\n--- Looking for new elements ---');
      const newEst = await page.getByText(/Estudo/i).all();
      console.log(`Now have ${newEst.length} Estudo elements`);

    } catch (e: any) {
      console.log(`Click failed: ${e.message}`);
    }
  }

  // Print captured requests
  console.log('\n--- Captured requests/responses (filtered) ---');
  const materialRequests = allRequests.filter(r => r.includes('material') || r.includes('cloudflarestorage') || r.includes('pdf') || r.includes('zip'));
  if (materialRequests.length > 0) {
    materialRequests.forEach((r) => console.log(r));
  } else {
    console.log('No material-related requests captured');
    allRequests.slice(0, 20).forEach((r) => console.log(r));
  }

  await browser.close();
}

main().catch(console.error);