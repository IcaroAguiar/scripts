import fs from 'fs-extra';
import path from 'node:path';
import { Logger } from '../core/logger/logger';
import { sha256File } from '../core/download/hash';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_URL = `${BASE_URL}/login`;
const AUTH_STATE = 'storage/auth/themembers-retry-figma.json';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_AUDIT = 'storage/audit/url_retry_figma.json';
const LOGS_DIR = 'storage/logs';

const LESSON_URLS = [
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-bem-vindos2072557276/df83ea77-7059-4520-b924-4fb2f03b2e88',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-02-criando-conta1060429663/6ac1d418-56ad-4f4f-969d-e8544e164d41',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-03-versao-de-desktop1169081525/58038f09-7ad5-43db-aad1-ae47c94de488',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-04-como-ter-fontes-infinitas1187695932/94ef0af9-ae34-4985-872a-745e4caedc3d',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-05-licenca-educacional1089148547/c72ba572-3f63-455d-a8c5-cfa46f61c456',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-06-interface-do-figma347600882/1a4bb104-562e-4814-a922-f564d09c1b22',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-07-interface-do-figjam917728746/c60b65f6-558e-4def-b8a8-f418d312af61',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-08-interface-design-file102501384/b3a90b17-181c-4670-a953-75a2a269259b',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-09-ferramentas1967895036/a7b7574e-8269-496d-a123-62ace8a09fdf',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-10-configuracoes1241703176/a93a93ea-02c9-4ce8-9157-bc655e4cdb74',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-11-plug-ins193967766/f3dadb8e-1545-49f1-88f0-3b6b9b27c876',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-12-salvar-e-exportar892053645/0941a2e3-b57d-4dd2-ace4-a4514704ca62',
];

interface DownloadResult {
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  status: 'downloaded' | 'failed' | 'skipped';
  localPath?: string;
  sha256?: string;
  newUrl?: string;
  error?: string;
}

interface AuditEntry {
  queueItem: {
    courseSlug: string;
    courseName: string;
    moduleName: string;
    lessonName: string;
    lessonUrl: string;
    assetName: string;
    url: string;
  };
  result: DownloadResult;
  retries: number;
  timestamp: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, bytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const logger = new Logger(LOGS_DIR);
  const audit: AuditEntry[] = [];

  const { createBrowserContext, waitForHydration, expandAccordions, scrollToBottom } = await import('../core/browser/browser');
  const { fillLoginForm, persistStorageState } = await import('../core/auth/session');

  const { browser, page } = await createBrowserContext({
    headless: false,
    storageStatePath: AUTH_STATE,
    acceptDownloads: true
  });

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const filled = await fillLoginForm(page, EMAIL, PASSWORD);
  if (filled) {
    await logger.log('LOGIN', 'login form submitted');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await sleep(3000);
    await persistStorageState(browser.context, AUTH_STATE);
  }

  let lessonIndex = 0;
  for (const lessonUrl of LESSON_URLS) {
    lessonIndex++;
    console.log(`\n=== [${lessonIndex}/12] Navigating to: ${lessonUrl}`);

    try {
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await sleep(1500);
    } catch (e) {
      console.log(`Navigation failed: ${e}`);
      continue;
    }

    const html = await page.content();
    const materialRegex = /(EBOOK|Audiobook|PDF|ebook|audiobook)[^<]*(?:\.pdf|\.zip|\.docx|\.xlsx)[^<]*</gi;
    const matches = [...html.matchAll(materialRegex)];
    console.log(`  Found ${matches.length} material references`);

    for (const match of matches) {
      const fullText = match[0];
      const nameMatch = fullText.match(/([A-Za-z0-9\s\-_\.À-ÿ]+(?:pdf|zip|docx|xlsx))/i);
      if (!nameMatch) continue;
      const assetName = nameMatch[1].trim();
      if (!assetName || assetName.length < 5) continue;

      console.log(`  Processing: ${assetName}`);
      const safeName = assetName.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
      const targetDir = path.join(DOWNLOADS_DIR, 'figma', 'ModuloEncontro_1_Acumulo_de_Milhas_na_Pratica', `lesson-${String(lessonIndex).padStart(2, '0')}`, 'materiais');
      const targetPath = path.join(targetDir, safeName);

      if (await fs.pathExists(targetPath)) {
        console.log(`  SKIP: already exists`);
        audit.push({
          queueItem: { courseSlug: 'figma', courseName: 'Figma', moduleName: 'MóduloEncontro 1 - Acúmulo de Milhas na Prática', lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, url: 'pending' },
          result: { lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, status: 'skipped', localPath: targetPath },
          retries: 0,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      await fs.ensureDir(targetDir);

      const capturedUrls: string[] = [];
      const onRequest = (req: { url(): string }) => {
        const u = req.url();
        if (/cloudflarestorage\.com|\/material\//i.test(u) && /X-Amz-Signature=/i.test(u)) {
          if (!capturedUrls.includes(u)) capturedUrls.push(u);
        }
      };
      const onResponse = (res: { url(): string }) => {
        const u = res.url();
        if (/cloudflarestorage\.com|\/material\//i.test(u) && /X-Amz-Signature=/i.test(u)) {
          if (!capturedUrls.includes(u)) capturedUrls.push(u);
        }
      };
      page.on('request', onRequest as any);
      page.on('response', onResponse as any);

      let signedUrl: string | null = null;

      try {
        const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
        const materialEl = page.locator(`text="${assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).first();
        const count = await materialEl.count();

        if (count === 0) {
          console.log(`  WARN: element not found for ${assetName}`);
        } else {
          await materialEl.scrollIntoViewIfNeeded().catch(() => undefined);
          await sleep(300);
          await materialEl.click({ timeout: 5000 }).catch((e: Error) => console.log(`  click error: ${e.message}`));
          const download = await downloadPromise;
          await sleep(1500);
          signedUrl = capturedUrls.length > 0 ? capturedUrls[capturedUrls.length - 1] : null;

          if (download && !signedUrl) {
            const tmpPath = `/tmp/figma-download-${Date.now()}.tmp`;
            await download.saveAs(tmpPath);
            await fs.copy(tmpPath, targetPath);
            await fs.remove(tmpPath).catch(() => undefined);
            const sha = await sha256File(targetPath);
            console.log(`  SUCCESS (download): ${targetPath}`);
            audit.push({
              queueItem: { courseSlug: 'figma', courseName: 'Figma', moduleName: 'MóduloEncontro 1 - Acúmulo de Milhas na Prática', lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, url: 'pending' },
              result: { lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, status: 'downloaded', localPath: targetPath, sha256: sha },
              retries: 0,
              timestamp: new Date().toISOString()
            });
          } else if (signedUrl) {
            try {
              await fetchToFile(signedUrl, targetPath, 120_000);
              const sha = await sha256File(targetPath);
              console.log(`  SUCCESS (url): ${targetPath}`);
              audit.push({
                queueItem: { courseSlug: 'figma', courseName: 'Figma', moduleName: 'MóduloEncontro 1 - Acúmulo de Milhas na Prática', lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, url: 'pending' },
                result: { lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, status: 'downloaded', localPath: targetPath, sha256: sha, newUrl: signedUrl },
                retries: 0,
                timestamp: new Date().toISOString()
              });
            } catch (fe) {
              console.log(`  FAILED to fetch: ${fe}`);
              audit.push({
                queueItem: { courseSlug: 'figma', courseName: 'Figma', moduleName: 'MóduloEncontro 1 - Acúmulo de Milhas na Prática', lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, url: 'pending' },
                result: { lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, status: 'failed', error: `Fetch failed: ${fe}`, newUrl: signedUrl },
                retries: 0,
                timestamp: new Date().toISOString()
              });
            }
          } else {
            console.log(`  FAILED: no signed URL captured`);
            audit.push({
              queueItem: { courseSlug: 'figma', courseName: 'Figma', moduleName: 'MóduloEncontro 1 - Acúmulo de Milhas na Prática', lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, url: 'pending' },
              result: { lessonName: `lesson-${lessonIndex}`, lessonUrl, assetName, status: 'failed', error: 'No signed R2 URL captured after click' },
              retries: 0,
              timestamp: new Date().toISOString()
            });
          }
        }
      } finally {
        page.off('request', onRequest as any);
        page.off('response', onResponse as any);
      }
    }

    await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });
    console.log(`  Logged ${audit.length} entries so far`);
  }

  await browser.close();

  const downloaded = audit.filter((a) => a.result.status === 'downloaded').length;
  const failed = audit.filter((a) => a.result.status === 'failed').length;
  const skipped = audit.filter((a) => a.result.status === 'skipped').length;

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${audit.length} | Downloaded: ${downloaded} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log(`Output: ${OUTPUT_AUDIT}`);
}

main().catch(console.error);
