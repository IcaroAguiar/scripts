import fs from 'fs-extra';
import path from 'node:path';
import { chromium } from 'playwright';
import { Logger } from '../core/logger/logger';

const RETRY_DIR = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/downloads/themembers-v3-retry';
const QUEUE_PATH = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/audit/v3_wave_url_only_queue.json';
const MANIFESTS_DIR = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/manifests/themembers-v3-repaired';
const AUTH_STATE = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/auth/themembers.json';
const LOGS_DIR = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/logs';

const COURSES = [
  'inteligencia-emocional-e-comunicacao-de-impacto',
  'inteligencia-emocional',
  'lideranca-visionaria-e-estrategia-de-futuro-formacao',
  'lideranca-visionaria-e-estrategia-de-futuro'
];

const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';

interface QueueItem {
  courseSlug: string;
  courseName: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  url: string;
}

interface ResultItem extends QueueItem {
  status: 'downloaded' | 'failed' | 'skipped' | 'unresolved-skipped';
  localPath?: string;
  newUrl?: string;
  error?: string;
  downloadedAt?: string;
  retryAttempt?: number;
}

function moduleIndexFromName(moduleName: string): number {
  const match = moduleName.match(/Módulo[\s-]*(\d+)/i);
  return match ? parseInt(match[1]) : 1;
}

function moduleSlugFromName(moduleName: string): string {
  const idx = moduleIndexFromName(moduleName);
  const baseName = moduleName.replace(/^Módulo[\s-]*\d+[\s-]*/i, '').trim();
  return `${String(idx).padStart(2, '0')}-${baseName}`;
}

function lessonTargetPath(courseSlug: string, moduleName: string, lessonName: string, assetName: string): string {
  const modSlug = moduleSlugFromName(moduleName);
  return path.join(
    RETRY_DIR,
    courseSlug,
    modSlug,
    lessonName,
    'materiais',
    assetName
  );
}

async function waitForHydration(page: any): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
}

async function scrollAndExpand(page: any): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
  }
  const candidates = page
    .locator('button, [role="button"], summary, [aria-expanded="false"], [class*="accordion"], [class*="collapse"]')
    .filter({ hasNotText: /^$/ });
  const count = Math.min(await candidates.count(), 30);
  for (let i = 0; i < count; i++) {
    const c = candidates.nth(i);
    const expanded = await c.getAttribute('aria-expanded').catch(() => null);
    if (expanded === 'true') continue;
    await c.click({ timeout: 300 }).catch(() => undefined);
  }
}

async function resolveMaterialByClick(page: any, assetName: string): Promise<string | null> {
  const cleanPatterns = [
    assetName.replace(/\s*\(\d+\)\s*$/, '').trim(),
    assetName.replace(/\.pdf|\.zip|\.docx|\.xlsx|\.rar|\.pptx/gi, '').trim(),
    decodeURIComponent(assetName).replace(/\.pdf|\.zip|\.docx|\.xlsx|\.rar|\.pptx/gi, '').trim()
  ];

  let locator: any = null;
  for (const pattern of cleanPatterns) {
    locator = page.getByText(pattern, { exact: true }).first();
    if ((await locator.count()) > 0) break;
    locator = page.getByText(pattern, { exact: false }).first();
    if ((await locator.count()) > 0) break;
    locator = null;
  }

  if (!locator || (await locator.count()) === 0) {
    const allText = await page.evaluate(() => document.body.innerText);
    const found = allText.includes(assetName) || allText.includes(decodeURIComponent(assetName));
    if (!found) return null;
    const el = page.locator('*').filter({ hasText: new RegExp(assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
    if ((await el.count()) > 0) locator = el;
    if (!locator) return null;
  }

  const capturedUrls: string[] = [];
  const isSigned = (url: string) =>
    /cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url);
  const capture = (req: any) => { if (isSigned(req.url())) capturedUrls.push(req.url()); };
  page.on('request', capture);
  page.on('response', capture);

  try {
    const dlPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    const dl = await dlPromise;
    if (capturedUrls.length > 0) return capturedUrls.at(-1)!;
    if (dl) return 'download-triggered:' + dl.suggestedFilename();
    return null;
  } catch {
    return null;
  } finally {
    page.off('request', capture);
    page.off('response', capture);
  }
}

async function tryDownload(page: any, url: string, targetPath: string, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await page.request.fetch(url, {
        timeout: 120000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }
      const buffer = await response.body();
      if (!buffer || buffer.length === 0) throw new Error('Empty response body');
      await fs.writeFile(targetPath, Buffer.from(buffer));
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

async function login(page: any): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.evaluate(() => {
    const emailInput = document.querySelector('input[type="email"], input[name="email"], #field-_r_0_') as HTMLInputElement;
    const passwordInput = document.querySelector('input[type="password"], input[name="password"], #field-_r_1_') as HTMLInputElement;
    if (emailInput) emailInput.value = 'lucas@tetraeducacao.com.br';
    if (passwordInput) passwordInput.value = '28778422';
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => /entrar/i.test(b.textContent || ''));
    (btn as HTMLButtonElement)?.click();
  });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(4000);
}

async function main() {
  const logger = new Logger(LOGS_DIR);

  const rawQueue: QueueItem[] = await fs.readJson(QUEUE_PATH);
  const queue = rawQueue.filter((item): item is QueueItem => COURSES.includes(item.courseSlug));
  console.log(`\nFiltered ${queue.length} items for target courses\n`);

  const results: ResultItem[] = [];
  let processed = 0;
  let browser: any = null;
  let context: any = null;
  let page: any = null;
  let skippedBrowserCrash = 0;

  async function ensureBrowser(): Promise<void> {
    if (!browser || browser.isConnected()) return;
    console.log('\n[RECONNECT] Reopening browser after crash...\n');
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      storageState: await fs.pathExists(AUTH_STATE) ? AUTH_STATE : undefined,
      acceptDownloads: true
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);
    await login(page);
  }

  async function processQueue() {
    for (let qi = 0; qi < queue.length; qi++) {
      const item = queue[qi];
      const key = `${item.lessonUrl}|${item.assetName}`;

      processed++;
      const result: ResultItem = { ...item, status: 'failed', retryAttempt: 0 };

      try {
        if (!browser || !browser.isConnected()) {
          console.log('Launching browser...');
          browser = await chromium.launch({ headless: false });
          context = await browser.newContext({
            storageState: await fs.pathExists(AUTH_STATE) ? AUTH_STATE : undefined,
            acceptDownloads: true
          });
          page = await context.newPage();
          page.setDefaultTimeout(30000);
          page.setDefaultNavigationTimeout(45000);

          if (await fs.pathExists(AUTH_STATE)) {
            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);
            const check = await page.getByText(/sair|logout|minha conta/i).count();
            if (check === 0) {
              await login(page);
              await context.storageState().then((state: any) => fs.writeJson(AUTH_STATE, state));
            } else {
              console.log('Already authenticated.\n');
            }
          } else {
            await login(page);
            await context.storageState().then((state: any) => fs.writeJson(AUTH_STATE, state));
          }
        }

        console.log(`[${processed}/${queue.length}] ${item.courseSlug} | ${item.lessonName} | ${item.assetName}`);

        await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForHydration(page);
        await scrollAndExpand(page);
        await page.waitForTimeout(1000);

        let downloadUrl: string | null = null;

        if (item.url.startsWith('unresolved://') || item.url === 'unresolved://') {
          console.log('  -> Resolving unresolved material...');
          downloadUrl = await resolveMaterialByClick(page, item.assetName);
          if (downloadUrl && downloadUrl.startsWith('download-triggered:')) {
            result.error = 'Browser download triggered: ' + downloadUrl;
            console.log('  !! ' + result.error);
          } else if (downloadUrl) {
            result.newUrl = downloadUrl;
            console.log('  -> Got signed URL');
          } else {
            result.status = 'failed';
            result.error = 'Could not resolve signed URL from material click';
            console.log('  !! ' + result.error);
          }
        } else if (item.url.startsWith('http')) {
          downloadUrl = item.url;
        } else if (item.url.startsWith('drive.google.com') || item.url.includes('drive.google.com')) {
          result.status = 'skipped';
          result.error = 'Google Drive external link - skipped';
          console.log('  -> SKIPPED (Google Drive external link)\n');
        } else {
          result.status = 'unresolved-skipped';
          result.error = 'Unknown URL scheme';
          console.log('  !! Unknown scheme: ' + item.url.substring(0, 50));
        }

        if (downloadUrl && !downloadUrl.startsWith('download-triggered:')) {
          const targetPath = lessonTargetPath(item.courseSlug, item.moduleName, item.lessonName, item.assetName);
          await fs.ensureDir(path.dirname(targetPath));

          try {
            await tryDownload(page, downloadUrl, targetPath);
            result.status = 'downloaded';
            result.localPath = targetPath;
            result.downloadedAt = new Date().toISOString();
            console.log('  OK -> ' + targetPath + '\n');
          } catch (dlErr) {
            result.status = 'failed';
            result.error = dlErr instanceof Error ? dlErr.message : String(dlErr);
            console.log('  !! Download failed: ' + result.error + '\n');
          }
        }
      } catch (err) {
        result.status = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
        if (result.error.includes('Target page, context or browser has been closed')) {
          skippedBrowserCrash++;
          console.log('  !! Browser crashed, will reconnect on next iteration\n');
          browser = null;
        } else {
          console.log('  !! Error: ' + result.error + '\n');
        }
      }

      results.push(result);

      if (processed % 5 === 0) {
        const summary = results.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        console.log(`\n--- LOG every-5: ${processed}/${queue.length} | Summary: ${JSON.stringify(summary)} ---\n`);
        await logger.log('BATCH5', `progress: ${processed}/${queue.length}`, { last: JSON.stringify(result) });
      }
    }
  }

  await processQueue();

  if (browser) await browser.close();

  const outputPath = path.join(path.dirname(QUEUE_PATH), 'v3_wave_url_retry_batch5.json');
  await fs.writeJson(outputPath, results, { spaces: 2 });

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(`\nDONE. ${summary.downloaded || 0}/${results.length} downloaded.`);
  console.log(`Output: ${outputPath}`);
  console.log('Summary:', summary);
  if (skippedBrowserCrash > 0) console.log(`Browser crashes handled: ${skippedBrowserCrash}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
