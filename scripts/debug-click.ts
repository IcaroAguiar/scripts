import { chromium } from 'playwright';

const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_URL = `${BASE_URL}/login`;
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  // Capture ALL requests
  const allRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('datadog') && !url.includes('clarity') && !url.includes('google')) {
      allRequests.push(`REQ: ${url.substring(0, 150)}`);
    }
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('datadog') && !url.includes('clarity')) {
      allRequests.push(`RES: ${res.status()} ${url.substring(0, 150)}`);
    }
  });

  page.on('download', (download) => {
    console.log(`DOWNLOAD: ${download.suggestedFilename()} -> ${download.url().substring(0, 200)}`);
  });

  console.log('Logging in...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  await page.evaluate(`document.querySelector('input[name="email"]').value = '${EMAIL}'`);
  await page.evaluate(`document.querySelector('input[name="password"]').value = '${PASSWORD}'`);
  await page.evaluate(`document.querySelector('button[type="submit"]').click()`);
  await page.waitForTimeout(4000);

  console.log(`Logged in, URL: ${page.url()}`);

  const lessonUrl = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b';
  console.log(`\nNavigating to: ${lessonUrl}`);

  allRequests.length = 0;
  await page.goto(lessonUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log('\n--- Page loaded, scanning for material elements ---');

  // Find all elements that might be clickable
  const elements = await page.locator('*').all();
  let materialElements: any[] = [];

  for (const el of elements) {
    try {
      const text = await el.innerText().catch(() => '');
      if (text.includes('Estudo de Caso') || text.includes('Material')) {
        const tag = await el.evaluate((e: Element) => e.tagName);
        const rect = await el.boundingBox();
        if (rect) {
          materialElements.push({ tag, text: text.slice(0, 80), x: rect.x, y: rect.y });
        }
      }
    } catch {}
  }

  console.log(`Found ${materialElements.length} elements with relevant text`);
  materialElements.slice(0, 10).forEach((el, i) => {
    console.log(`  ${i + 1}. <${el.tag}> "${el.text}" at (${el.x.toFixed(0)}, ${el.y.toFixed(0)})`);
  });

  // Try clicking on first "Estudo de Caso" element
  console.log('\n--- Attempting click on Estudo de Caso ---');
  allRequests.length = 0;

  try {
const estudoEl = page.getByText('Estudo de Caso', { exact: false }).first();
  await estudoEl.scrollIntoViewIfNeeded();
  await estudoEl.click({ timeout: 5000 });
    console.log('Click succeeded');

    // Wait and capture
    await page.waitForTimeout(3000);

    // Check what happened
    console.log(`Current URL: ${page.url()}`);

    // Check for modals/dialogs
    const modalCount = await page.locator('[role="dialog"], .modal, [class*="modal"]').count();
    console.log(`Modal/dialog count: ${modalCount}`);

    // Check for any new navigation
    if (page.url() !== lessonUrl) {
      console.log(`Navigation detected to: ${page.url()}`);
    }

  } catch (e: any) {
    console.log(`Click failed: ${e.message}`);
  }

  // Print captured requests
  console.log('\n--- Captured requests/responses ---');
  allRequests.slice(0, 50).forEach((r) => console.log(r));

  await browser.close();
}

main().catch(console.error);