import fs from 'fs-extra';
import path from 'node:path';
import { createBrowserContext, expandAccordions, scrollToBottom, waitForHydration } from '../core/browser/browser';
import { Logger } from '../core/logger/logger';

const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const STORAGE_STATE_PATH = 'storage/auth/themembers-retry-batch4.json';
const OUTPUT_PATH = 'storage/audit/url_retry_design_dashboards.json';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';

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

  console.log(`Login form elements found - email: ${emailCount}, password: ${passwordCount}`);

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

    // Try different text matching approaches
    const nameBase = assetName.replace(/\.(pdf|zip|mp3|docx?|xlsx?)$/i, '').trim();
    const namePatterns = [
      nameBase,
      assetName,
      'Estudo de Caso',
      'Material',
      'Download'
    ];

    let material: any = null;
    for (const pattern of namePatterns) {
      const candidates = page.getByText(pattern, { exact: false });
      const count = await candidates.count();
      if (count > 0) {
        material = candidates.first();
        log(`  Found material with pattern: "${pattern}" (count: ${count})`);
        break;
      }
    }

    if (!material) {
      logger.log('WARN', `material not found on page: ${assetName}`, { lessonUrl });
      return null;
    }

    await material.scrollIntoViewIfNeeded().catch(() => undefined);
    await sleep(300);

    // Try clicking with retry
    for (let clickAttempt = 0; clickAttempt < 3; clickAttempt++) {
      try {
        await material.click({ timeout: 5000 });
        log(`  Click succeeded on attempt ${clickAttempt + 1}`);
        break;
      } catch (e: any) {
        log(`  Click attempt ${clickAttempt + 1} failed: ${e.message}`);
        await sleep(1000);
        // Try refreshing material reference
        const refreshed = page.getByText(nameBase, { exact: false }).first();
        if (await refreshed.count() > 0) {
          material = refreshed;
        }
      }
    }

    const download = await downloadPromise;
    await sleep(1500);

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

function cleanPathComponent(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildTargetPath(courseSlug: string, moduleName: string, lessonName: string, assetName: string): string {
  const sanitizedModule = cleanPathComponent(moduleName);
  const sanitizedLesson = cleanPathComponent(lessonName);
  const sanitizedAsset = cleanPathComponent(assetName);

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

async function updateManifest(item: QueueItem, localPath: string): Promise<void> {
  const manifestPath = path.join(MANIFESTS_DIR, `${item.courseSlug}.json`);
  if (!(await fs.pathExists(manifestPath))) return;

  try {
    const manifest = await fs.readJson(manifestPath);
    let updated = false;

    for (const mod of manifest.modules ?? []) {
      for (const lesson of mod.lessons ?? []) {
        for (const asset of lesson.assets ?? []) {
          const assetComparable = (n: string) =>
            n.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
          if (
            assetComparable(asset.name) === assetComparable(item.assetName) &&
            (asset.url === item.url || asset.url.startsWith('unresolved://'))
          ) {
            asset.localPath = localPath;
            asset.status = 'downloaded';
            delete asset.lastError;
            updated = true;
            log(`  Updated manifest for: ${asset.name}`);
          }
        }
      }
    }

    if (updated) {
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    }
  } catch (e: any) {
    log(`  Manifest update error: ${e.message}`);
  }
}

async function main() {
  const queuePath = 'storage/audit/v3_wave_url_only_queue.json';
  const queue: QueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));

  const targetCourse = 'design-de-dashboards-e-storytelling-com-dados';
  const items = queue.filter((q) => q.courseSlug === targetCourse && q.url.startsWith('unresolved://'));

  console.log(`\n=== Processing ${items.length} unresolved assets for ${targetCourse} ===\n`);

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
      console.log(`\n[${processed}/${items.length}] ${item.assetName}`);
      console.log(`  Lesson: ${item.lessonUrl}`);

      const result: DownloadResult = {
        item,
        status: 'failed',
        attemptCount: 0
      };

      // Navigate to lesson
      console.log(`  Navigating to lesson...`);
      await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await sleep(2000);

      // Try to resolve URL
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
        console.log(`  SKIP: Already exists`);
        continue;
      }

      console.log(`  Downloading to: ${targetPath}`);
      const ok = await downloadWithRetry(resolvedUrl, targetPath, 3, logger);
      result.attemptCount++;

      if (ok) {
        result.status = 'downloaded';
        result.localPath = targetPath;
        console.log(`  SUCCESS`);

        // Update manifest
        await updateManifest(item, targetPath);
      } else {
        result.error = `All ${result.attemptCount} download attempts failed`;
        result.status = 'retry_failed';
        console.log(`  FAIL: Download attempts exhausted`);
      }

      results.push(result);
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

function log(msg: string) {
  console.log(`  ${msg}`);
}