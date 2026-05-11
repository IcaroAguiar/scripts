import { chromium } from 'playwright';
import fs from 'fs';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';

const LESSON_INFO: Record<string, string> = {
  'f871b37f-95ee-4632-a9b0-e3fd7ac6e44b': 'Aula 01 - Comece aqui',
  'dfc4fbf6-8e1b-42a0-b144-813aeb0c7d1a': 'Aula 02 - Storytelling',
  '41fff709-ec20-44b5-8341-c7a9e9849a28': 'Aula 03 - Fundamentos',
  '1b64c377-9267-4640-8fe7-c7d63f524bb4': 'Aula 04 - Tipos de Visuais'
};

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: true
  });
  const page = await context.newPage();

  console.log('Testing material download via browser...\n');

  for (const [lessonId, lessonName] of Object.entries(LESSON_INFO)) {
    console.log(`=== ${lessonName} (${lessonId}) ===`);

    const lessonUrl = `https://alunos.tetraeducacao.com.br/curso/4393/aula-01-comece-aqui78478784/${lessonId}`;

    // Capture download
    let downloadInfo: { filename: string; url: string } | null = null;
    page.on('download', (download) => {
      downloadInfo = {
        filename: download.suggestedFilename(),
        url: download.url()
      };
    });

    await page.goto(lessonUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Look for material elements
    const materialText = await page.getByText('Material', { exact: false }).all();
    console.log(`  Found ${materialText.length} "Material" elements`);

    for (const el of materialText.slice(0, 3)) {
      try {
        const text = await el.innerText().catch(() => '');
        const rect = await el.boundingBox();
        console.log(`    - "${text.slice(0, 60)}" at (${rect?.x.toFixed(0)}, ${rect?.y.toFixed(0)})`);
      } catch {}
    }

    // Try clicking on Material element
    if (materialText.length > 0) {
      console.log('  Attempting click on Material...');
      try {
        await materialText[0].click({ timeout: 5000, force: true });
        await page.waitForTimeout(2000);
        console.log(`  Click completed. Download? ${downloadInfo ? 'YES: ' + downloadInfo.filename : 'NO'}`);
      } catch (e) {
        console.log(`  Click failed: ${e.message}`);
      }
    }

    // Reset
    page.removeAllListeners('download');
    downloadInfo = null;
    console.log();
  }

  await browser.close();
}

main().catch(console.error);