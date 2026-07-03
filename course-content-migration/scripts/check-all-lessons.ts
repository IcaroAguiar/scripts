import { chromium } from 'playwright';
import fs from 'fs';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';

const LESSONS = [
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-02-introducao-ao-storytelling-de-dados339087634/dfc4fbf6-8e1b-42a0-b144-813aeb0c7d1a',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-03-fundamentos-de-analise-de-dados255709997/41fff709-ec20-44b5-8341-c7a9e9849a28',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-04-tipos-de-visuais-e-suas-aplicacoes1039703444/1b64c377-9267-4640-8fe7-c7d63f524bb4'
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  for (let i = 0; i < LESSONS.length; i++) {
    console.log(`\n=== Lesson ${i + 1}: ${LESSONS[i].split('/').pop()} ===`);

    // Intercept API response
    let materialsData: any = null;
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('/api/auth/home/materials/')) {
        try {
          materialsData = await res.json();
        } catch {}
      }
    });

    await page.goto(LESSONS[i], { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    if (materialsData) {
      console.log(`Found ${materialsData.length} materials:`);
      materialsData.forEach((m: any, idx: number) => {
        console.log(`  ${idx + 1}. ${m.material_name}`);
        console.log(`     URL: ${m.material_url}`);
      });
    } else {
      console.log('No materials data captured');
    }

    // Reset listener
    page.removeAllListeners('response');
    materialsData = null;
  }

  await browser.close();
}

main().catch(console.error);