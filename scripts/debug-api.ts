import { chromium } from 'playwright';
import fs from 'fs';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  // Intercept API response
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/auth/home/materials/')) {
      console.log(`\n=== API Response for materials ===`);
      try {
        const body = await res.json();
        console.log(JSON.stringify(body, null, 2).slice(0, 3000));
      } catch (e) {
        console.log(`Could not parse JSON: ${e.message}`);
      }
    }
  });

  const lessonUrl = 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b';
  console.log(`Navigating to: ${lessonUrl}`);

  await page.goto(lessonUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log(`\nFinal URL: ${page.url()}`);

  // Get cookies to use for direct API call
  const cookies = await context.cookies('https://alunos.tetraeducacao.com.br');
  const sessionCookie = cookies.find(c => c.name === 'session' || c.name === 'session_id' || c.name.includes('auth'));

  if (sessionCookie) {
    console.log(`\nSession cookie: ${sessionCookie.name}`);
  }

  await browser.close();
}

main().catch(console.error);