import fs from 'fs-extra';
import path from 'node:path';
import { createBrowserContext, expandAccordions, scrollToBottom, waitForHydration } from '../core/browser/browser';
import { Logger } from '../core/logger/logger';

const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const STORAGE_STATE_PATH = 'storage/auth/themembers-retry.json';
const OUTPUT_PATH = 'storage/audit/v3_wave_url_retry_batch7.json';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';

interface QueueItem {
  courseSlug: string;
  courseName: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  url: string;
}

interface DownloadResult {
  item: QueueItem;
  status: 'downloaded' | 'failed' | 'skipped' | 'retry_failed';
  localPath?: string;
  newUrl?: string;
  error?: string;
  attemptCount: number;
}

function isSignedMaterialUrl(url: string): boolean {
  return /cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url);
}

function isGoogleDriveUrl(url: string): boolean {
  return /drive\.google\.com|docs\.google\.com/i.test(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureLogin(context: { authStatePath: string; logsDir: string }): Promise<{ browser: any; page: any; browserContext: any }> {
  const logger = new Logger(context.logsDir);

  const { browser, context: browserContext, page } = await createBrowserContext({
    headless: true,
    storageStatePath: context.authStatePath,
    acceptDownloads: true
  });

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const emailInput = page.locator('input[type="email"], input[name="email"], input[id="email"]');
  const passwordInput = page.locator('input[type="password"], input[name="password"]');
  const submitButton = page.locator('button[type="submit"]');

  const emailCount = await emailInput.count();
  const passwordCount = await passwordInput.count();
  const submitCount = await submitButton.count();

  console.log(`Login form elements found - email: ${emailCount}, password: ${passwordCount}, submit: ${submitCount}`);

  if (emailCount > 0 && passwordCount > 0) {
    logger.log('LOGIN', 'filling login form');
    await emailInput.fill(EMAIL);
    await passwordInput.fill(PASSWORD);
    await submitButton.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await sleep(2000);
  } else {
    const logoutCount = await page.locator('[href*="/logout"]').count();
    console.log(`No login form found, logout link count: ${logoutCount}`);
    if (logoutCount === 0) {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
    }
  }

  const { persistStorageState } = await import('../core/auth/session');
  await persistStorageState(browserContext, context.authStatePath);
  logger.log('LOGIN', `session saved to ${context.authStatePath}`);

  return { browser, page, browserContext };
}

async function resolveAssetUrl(page: any, assetName: string, logger: Logger, lessonUrl: string): Promise<string | null> {
  const capturedUrls: string[] = [];
  const capture = (url: string) => {
    if (isSignedMaterialUrl(url) && !capturedUrls.includes(url)) {
      capturedUrls.push(url);
    }
  };

  const onRequest = (request: { url(): string }) => capture(request.url());
  const onResponse = (response: { url(): string }) => capture(response.url());
  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);

    const material = page.getByText(assetName, { exact: false }).first();
    const count = await material.count();

    if (count === 0) {
      logger.log('WARN', `material not found on page: ${assetName}`, { lessonUrl });
      return null;
    }

    await material.scrollIntoViewIfNeeded().catch(() => undefined);
    await sleep(300);
    await material.click({ timeout: 5000 }).catch((e: Error) => {
      logger.log('WARN', `click failed: ${e.message}`, { assetName });
    });

    const download = await downloadPromise;
    await sleep(800);

    const signedUrl = capturedUrls.length > 0 ? capturedUrls[capturedUrls.length - 1] : null;

    if (download && !signedUrl) {
      const filename = download.suggestedFilename();
      logger.log('WARN', `download intercepted but no R2 URL captured: ${filename}`, { assetName });
    }

    return signedUrl;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while downloading asset`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, bytes);
  } finally {
    clearTimeout(timeout);
  }
}

function buildTargetPath(courseSlug: string, moduleName: string, lessonName: string, assetName: string): string {
  const sanitizedModule = moduleName.replace(/Módulo/gi, 'Modulo').replace(/\s+/g, '_');
  const sanitizedLesson = lessonName.replace(/\s+/g, '_').replace(/[^\w\-_\.]/g, '');
  const sanitizedAsset = assetName.replace(/\s+/g, '_').replace(/[^\w\-_\.]/g, '');

  return path.join(DOWNLOADS_DIR, courseSlug, sanitizedModule, sanitizedLesson, 'materiais', sanitizedAsset);
}

async function downloadWithRetry(url: string, targetPath: string, retries: number, logger: Logger): Promise<boolean> {
  await fs.ensureDir(path.dirname(targetPath));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fetchToFile(url, targetPath, 120_000);
      logger.log('DOWNLOAD', `downloaded ${path.relative(DOWNLOADS_DIR, targetPath)} (attempt ${attempt})`);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.log('RETRY', `attempt ${attempt}/${retries} failed: ${msg}`, { url: url.substring(0, 80) });
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  return false;
}

async function main() {
  const queue: QueueItem[] = JSON.parse(fs.readFileSync('storage/audit/v3_wave_url_only_queue.json', 'utf-8'));

  const targetCourses = [
    'recuperando-o-investimento-curso-completo-milhas',
    'talentos-do-futuro-e-sucessao-de-liderancas-formacao',
    'talentos-do-futuro-e-sucessao-de-liderancas'
  ];

  const items = queue.filter((q) => targetCourses.includes(q.courseSlug));
  console.log(`Processing ${items.length} items for ${targetCourses.length} courses`);

  const logger = new Logger('storage/logs');
  const { browser, page } = await ensureLogin({
    authStatePath: STORAGE_STATE_PATH,
    logsDir: 'storage/logs'
  });

  const results: DownloadResult[] = [];
  let processed = 0;

  try {
    for (const item of items) {
      processed++;
      console.log(`\n[${processed}/${items.length}] ${item.courseSlug} | ${item.lessonName} | ${item.assetName}`);

      const result: DownloadResult = {
        item,
        status: 'failed',
        attemptCount: 0
      };

      if (isGoogleDriveUrl(item.url)) {
        result.status = 'skipped';
        result.error = 'Google Drive link - requires manual download';
        results.push(result);
        console.log(`  SKIP: Google Drive URL`);
        continue;
      }

      console.log(`  Navigating to lesson to resolve: ${item.lessonUrl}`);
      await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await sleep(1500);

      const resolvedUrl = await resolveAssetUrl(page, item.assetName, logger, item.lessonUrl);
      result.attemptCount++;

      if (!resolvedUrl) {
        result.error = 'Could not resolve asset URL - material button not found or did not generate signed URL';
        results.push(result);
        console.log(`  FAIL: Could not resolve URL`);
        continue;
      }

      result.newUrl = resolvedUrl;
      console.log(`  Resolved to: ${resolvedUrl.substring(0, 100)}...`);

      const targetPath = buildTargetPath(item.courseSlug, item.moduleName, item.lessonName, item.assetName);

      if (await fs.pathExists(targetPath)) {
        result.status = 'skipped';
        result.localPath = targetPath;
        results.push(result);
        console.log(`  SKIP: Already exists at ${targetPath}`);
        continue;
      }

      console.log(`  Downloading to: ${targetPath}`);
      const ok = await downloadWithRetry(resolvedUrl, targetPath, 3, logger);
      result.attemptCount++;

      if (ok) {
        result.status = 'downloaded';
        result.localPath = targetPath;
        console.log(`  SUCCESS`);
      } else {
        result.error = `All ${result.attemptCount} download attempts failed`;
        result.status = 'retry_failed';
        console.log(`  FAIL: Download attempts exhausted`);
      }

      results.push(result);

      if (processed % 5 === 0) {
        console.log(`\n--- Logged ${processed} items ---`);
      }
    }
  } finally {
    await browser.close();
  }

  const output = JSON.stringify(results, null, 2);
  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`\n=== Results written to ${OUTPUT_PATH} ===`);
  console.log(`Total: ${results.length} | Downloaded: ${results.filter((r) => r.status === 'downloaded').length} | Failed: ${results.filter((r) => r.status === 'failed' || r.status === 'retry_failed').length} | Skipped: ${results.filter((r) => r.status === 'skipped').length}`);
}

main().catch(console.error);