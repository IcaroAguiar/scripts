import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs-extra';
import path from 'node:path';
import { expandAccordions, scrollToBottom, waitForHydration } from '../core/browser/browser';
import { Logger } from '../core/logger/logger';

const STORAGE_STATE = 'storage/auth/themembers-retry.json';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const AUDIT_OUTPUT = 'storage/audit/excel-avancado-url-retry.json';

const COURSE_SLUG = 'excel-avancado';

interface AssetRetryItem {
  lessonName: string;
  lessonUrl: string;
  assetName: string;
}

const QUEUE: AssetRetryItem[] = [
  {
    lessonName: 'Aula-0-Introducao',
    lessonUrl: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-0-introducao357442577/84a67c98-24cc-404e-bf68-d83b2abc4a99',
    assetName: 'Operacoes Matematicas Basicas no Excel.xlsx',
  },
  {
    lessonName: 'Aula-01-Office-365-vs-Excel-2019',
    lessonUrl: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-01-office-365-vs-excel-2019-alteracao-do-idioma-no-office1218121412/9b1ad49c-4ba6-46f7-a323-f3514e35c3ad',
    assetName: 'Aula 01 - Office 365 vs Excel 2019 - Alteração do Idioma no Office.zip',
  },
  {
    lessonName: 'Aula-03-Atalho-do-Excel',
    lessonUrl: 'https://alunos.tetraeducacao.com.br/curso/4393/aula-03-atalho-do-excel1400627658/adb1f614-28ca-40a4-ac30-5e414cac0db0',
    assetName: 'Operacoes Matematicas Basicas no Excel.xlsx',
  },
];

function isSignedMaterialUrl(url: string): boolean {
  return /cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveAssetUrl(page: Page, assetName: string, logger: Logger): Promise<string | null> {
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
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);

    const material = page.getByText(assetName, { exact: false }).first();
    const count = await material.count();

    if (count === 0) {
      logger.log('WARN', `material not found on page: ${assetName}`);
      return null;
    }

    await material.scrollIntoViewIfNeeded().catch(() => undefined);
    await sleep(500);
    await material.click({ timeout: 8000 }).catch((e: Error) => {
      logger.log('WARN', `click failed: ${e.message}`, { assetName });
    });

    const download = await downloadPromise;
    await sleep(1000);

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

function buildTargetPath(lessonName: string, assetName: string): string {
  const sanitizedAsset = assetName.replace(/\s+/g, '_').replace(/[^\w\-_\.]/g, '');
  return path.join(DOWNLOADS_DIR, COURSE_SLUG, '01-module-01', lessonName, 'materiais', sanitizedAsset);
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
  const logger = new Logger('storage/logs');

  const browser = await chromium.launch({ headless: true });
  const hasState = await fs.pathExists(STORAGE_STATE);
  const context = await browser.newContext({
    ...(hasState ? { storageState: STORAGE_STATE } : {}),
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
  const EMAIL = 'lucas@tetraeducacao.com.br';
  const PASSWORD = '28778422';

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const emailInput = page.locator('input[type="email"], input[name="email"], input[id="email"]');
  const passwordInput = page.locator('input[type="password"], input[name="password"]');
  const submitButton = page.locator('button[type="submit"]');

  const emailCount = await emailInput.count();
  if (emailCount > 0) {
    logger.log('LOGIN', 'filling login form');
    await emailInput.fill(EMAIL);
    await passwordInput.fill(PASSWORD);
    await submitButton.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await sleep(2000);
  } else {
    const logoutCount = await page.locator('[href*="/logout"]').count();
    console.log(`No login form found, logout link count: ${logoutCount}`);
  }

  await fs.ensureDir(STORAGE_STATE.split('/').slice(0, -1).join('/'));
  await context.storageState({ path: STORAGE_STATE });
  logger.log('LOGIN', `session saved to ${STORAGE_STATE}`);

  const results: Array<{
    item: AssetRetryItem;
    status: string;
    localPath?: string;
    newUrl?: string;
    error?: string;
    attemptCount: number;
  }> = [];

  for (const item of QUEUE) {
    console.log(`\n=== Processing: ${item.assetName} (${item.lessonName}) ===`);

    const result = {
      item,
      status: 'failed',
      attemptCount: 0,
      error: undefined as string | undefined,
      localPath: undefined as string | undefined,
      newUrl: undefined as string | undefined,
    };

    console.log(`  Navigating to: ${item.lessonUrl}`);
    await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForHydration(page);
    await expandAccordions(page);
    await scrollToBottom(page);
    await sleep(2000);

    const resolvedUrl = await resolveAssetUrl(page, item.assetName, logger);
    result.attemptCount++;

    if (!resolvedUrl) {
      result.error = 'Could not resolve asset URL - material button not found or did not generate signed URL';
      results.push(result);
      console.log(`  FAIL: Could not resolve URL`);
      continue;
    }

    result.newUrl = resolvedUrl;
    console.log(`  Resolved to: ${resolvedUrl.substring(0, 100)}...`);

    const targetPath = buildTargetPath(item.lessonName, item.assetName);

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
      result.error = `All download attempts failed`;
      result.status = 'retry_failed';
      console.log(`  FAIL: Download attempts exhausted`);
    }

    results.push(result);
  }

  await browser.close();

  fs.writeFileSync(AUDIT_OUTPUT, JSON.stringify(results, null, 2));
  console.log(`\n=== Results written to ${AUDIT_OUTPUT} ===`);
  const downloaded = results.filter((r) => r.status === 'downloaded').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'retry_failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`Total: ${results.length} | Downloaded: ${downloaded} | Failed: ${failed} | Skipped: ${skipped}`);
}

main().catch(console.error);