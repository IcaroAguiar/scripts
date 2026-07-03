import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';

const LESSONS = [
  { id: 'f871b37f-95ee-4632-a9b0-e3fd7ac6e44b', url: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/f871b37f-95ee-4632-a9b0-e3fd7ac6e44b' },
  { id: 'dfc4fbf6-8e1b-42a0-b144-813aeb0c7d1a', url: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-02-introducao-ao-storytelling-de-dados339087634/dfc4fbf6-8e1b-42a0-b144-813aeb0c7d1a' },
  { id: '41fff709-ec20-44b5-8341-c7a9e9849a28', url: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-03-fundamentos-de-analise-de-dados255709997/41fff709-ec20-44b5-8341-c7a9e9849a28' },
  { id: '1b64c377-9267-4640-8fe7-c7d63f524bb4', url: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-04-tipos-de-visuais-e-suas-aplicacoes1039703444/1b64c377-9267-4640-8fe7-c7d63f524bb4' }
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  console.log('=== Getting fresh material URLs from API ===\n');

  const freshMaterials: Record<string, Array<{name: string; url: string}>> = {};

  for (const lesson of LESSONS) {
    console.log(`Fetching: ${lesson.id}`);

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

    await page.goto(lesson.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    if (materialsData && materialsData.length > 0) {
      freshMaterials[lesson.id] = materialsData.map((m: any) => ({
        name: m.material_name,
        url: m.material_url
      }));

      console.log(`  Found ${materialsData.length} materials:`);
      for (const m of materialsData) {
        console.log(`    - ${m.material_name}`);
        console.log(`      ${m.material_url.substring(0, 80)}...`);
      }
    } else {
      console.log(`  No materials found`);
    }

    page.removeAllListeners('response');
    console.log();
  }

  // Save fresh materials
  const outputPath = 'storage/audit/design_dashboards_fresh_urls.json';
  fs.writeFileSync(outputPath, JSON.stringify(freshMaterials, null, 2));
  console.log(`Saved fresh URLs to: ${outputPath}`);

  await browser.close();
}

main().catch(console.error);