import { chromium } from 'playwright';
import fs from 'fs';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';
const COURSE_URL = 'https://alunos.tetraeducacao.com.br/courses/4393/design-de-dashboards-e-storytelling-com-dados/2e548c59-3a8e-4168-888a-c3b01463bc6e';
const LESSON_URL = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  console.log('Step 1: Navigate to course page');
  await page.goto(COURSE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  console.log(`Course page URL: ${page.url()}`);

  // Get cookies
  const cookies = await context.cookies();
  console.log(`Cookies: ${cookies.length}`);
  const sessionCookie = cookies.find(c => c.name.includes('session') || c.name.includes('auth'));
  if (sessionCookie) {
    console.log(`Session cookie: ${sessionCookie.name}=${sessionCookie.value.substring(0, 30)}...`);
  }

  console.log('\nStep 2: Navigate directly to lesson');
  await page.goto(LESSON_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  console.log(`Lesson page URL: ${page.url()}`);

  // Check URL - does it match?
  if (page.url() === LESSON_URL) {
    console.log('URL matches - lesson page loaded correctly');
  } else {
    console.log('URL does NOT match - redirected');
  }

  // Check for materials in page
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Estudo de Caso') || bodyText.includes('Material')) {
    console.log('Page contains material references');
  } else {
    console.log('Page does NOT contain material references');
    console.log('First 500 chars:', bodyText.slice(0, 500));
  }

  // Now try using the API directly
  console.log('\nStep 3: Call materials API directly');
  const apiUrl = `https://api.themembers.com.br/api/auth/home/materials/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b`;

  const apiResponse = await page.request.get(apiUrl);
  console.log(`API Response status: ${apiResponse.status()}`);
  const apiData = await apiResponse.json();
  console.log('API Data:', JSON.stringify(apiData, null, 2));

  await browser.close();
}

main().catch(console.error);