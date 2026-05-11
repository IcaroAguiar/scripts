import fs from 'fs-extra';
import path from 'node:path';
import { createBrowserContext, waitForHydration, expandAccordions, scrollToBottom } from '../core/browser/browser';
import { themembersAuthStatePath } from '../config/platforms/themembers';
import { loadEnv } from '../core/config/env';

const QUEUE_PATH = 'storage/audit/v3_wave_url_only_queue.json';
const OUTPUT_PATH = 'storage/audit/v3_wave_url_retry_batch6.json';
const FAILURE_OUTPUT_PATH = 'storage/audit/v3_wave_url_retry_batch6_failures.json';
const REPAIRED_MANIFEST_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOAD_BASE = 'storage/downloads/themembers-v3-retry';

const TARGET_COURSES = new Set([
  'masterclass-certificacao-mos',
  'microsoft-copilot',
  'oratoria-e-comunicacao',
  'projeto-final-mba'
]);

interface QueueItem {
  courseSlug: string;
  courseName: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  url: string;
}

interface SuccessResult {
  courseSlug: string;
  lessonUrl: string;
  assetName: string;
  downloadedPath: string;
  cloudflareUrl: string;
  sha256?: string;
  downloadedAt: string;
}

interface FailureResult {
  courseSlug: string;
  lessonUrl: string;
  assetName: string;
  errorCategory: string;
  errorMessage: string;
  attempt: number;
  failedAt: string;
}

function cleanName(name: string): string {
  return name.replace(/[^\w\u00C0-\u024F.\-+_\s-]/g, '').replace(/\s+/g, ' ').trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function downloadAsset(
  url: string,
  targetPath: string,
  maxRetries: number = 3
): Promise<{ success: boolean; error?: string; sha256?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.ensureDir(path.dirname(targetPath));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180_000);
      let bytes: Buffer;
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        bytes = Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }
      await fs.writeFile(targetPath, bytes);
      const stats = await fs.stat(targetPath);
      if (stats.size < 1024) {
        await fs.remove(targetPath);
        if (attempt === maxRetries) return { success: false, error: 'FILE_EMPTY_OR_INVALID' };
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const hash = await sha256File(targetPath);
      return { success: true, sha256: hash };
    } catch (err: any) {
      if (attempt === maxRetries) return { success: false, error: 'DOWNLOAD_FAILED: ' + (err?.message ?? String(err)) };
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return { success: false, error: 'DOWNLOAD_FAILED after retries' };
}

async function updateManifest(
  courseSlug: string,
  assetName: string,
  localPath: string,
  provenance: string
): Promise<void> {
  const manifestPath = path.join(REPAIRED_MANIFEST_DIR, courseSlug + '.json');
  if (!(await fs.pathExists(manifestPath))) return;
  const manifest = await fs.readJson(manifestPath);
  const cleanAsset = cleanName(assetName).toLowerCase();
  let updated = false;
  for (const mod of manifest.modules ?? []) {
    for (const lesson of mod.lessons ?? []) {
      for (const asset of lesson.assets ?? []) {
        const assetClean = cleanName(asset.name ?? '').toLowerCase();
        if (assetClean.includes(cleanAsset) || cleanAsset.includes(assetClean)) {
          asset.localPath = localPath;
          asset.provenance = provenance;
          asset.status = 'downloaded';
          updated = true;
        }
      }
    }
  }
  if (updated) await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

function getTargetPath(
  courseSlug: string,
  moduleName: string,
  lessonName: string,
  assetName: string
): string {
  const safeModule = slugify(
    moduleName.replace(/MóduloEncontro\s*\d+\s*-\s*/i, '').replace(/\s+/g, '-').substring(0, 60)
  );
  const safeLesson = slugify(lessonName.replace(/\s+/g, '-').substring(0, 60));
  const moduleDir = 'module-' + safeModule;
  const lessonDir = 'lesson-' + safeLesson;
  return path.join(DOWNLOAD_BASE, courseSlug, moduleDir, lessonDir, 'materiais', assetName);
}

async function getFreshUrlFromLessonPage(
  page: any,
  expectedAssetName: string
): Promise<{ url: string; fileName: string } | null> {
  const capturedUrls: string[] = [];
  const onRequest = (request: { url(): string }) => {
    capturedUrls.push(request.url());
  };
  const onResponse = (response: { url(): string }) => {
    capturedUrls.push(response.url());
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    await expandAccordions(page);
    await scrollToBottom(page, 10);
    await page.waitForTimeout(2_000);

    const downloadPromise = page.waitForEvent('download', { timeout: 8_000 }).catch(() => null);

    const svgParent = page.locator('.css-vnghgq').first();
    const svgParentVisible = await svgParent.isVisible({ timeout: 3_000 }).catch(() => false);
    if (svgParentVisible) {
      await svgParent.scrollIntoViewIfNeeded();
      await svgParent.click({ timeout: 5_000 }).catch(() => undefined);
    }

    const download = await downloadPromise;
    await page.waitForTimeout(1_500);

    const signedUrl = capturedUrls.find(url =>
      url.includes('cloudflarestorage.com') &&
      (url.includes('X-Amz-Signature') || url.includes('Signature=') || url.includes('Expires='))
    );

    if (signedUrl) {
      return { url: signedUrl, fileName: expectedAssetName };
    }

    if (download) {
      const suggestedName = download.suggestedFilename() ?? '';
      const downloadExt = suggestedName.split('.').pop()?.toLowerCase() ?? '';
      const extDot = '.' + downloadExt;
      const matchingUrl = capturedUrls.find(url => url.toLowerCase().includes(extDot));
      const lastUrl = capturedUrls[capturedUrls.length - 1] ?? '';
      return { url: matchingUrl ?? lastUrl, fileName: expectedAssetName };
    }

    return null;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

async function main() {
  const env = loadEnv();
  console.log('[BATCH6] Starting batch6 retry for 4 target courses...');

  const allQueue: QueueItem[] = await fs.readJson(QUEUE_PATH);
  const items = allQueue.filter(item => TARGET_COURSES.has(item.courseSlug));
  console.log('[BATCH6] Items to process: ' + items.length);

  if (items.length === 0) {
    console.log('[BATCH6] No items found for target courses.');
    return;
  }

  const successResults: SuccessResult[] = [];
  const failureResults: FailureResult[] = [];

  if (await fs.pathExists(OUTPUT_PATH)) {
    const existing: SuccessResult[] = await fs.readJson(OUTPUT_PATH);
    successResults.push(...existing);
  }

  const alreadyDone = new Set(
    successResults.map(s => s.courseSlug + '::' + s.lessonUrl + '::' + s.assetName)
  );
  const itemsToProcess = items.filter(
    item => !alreadyDone.has(item.courseSlug + '::' + item.lessonUrl + '::' + item.assetName)
  );
  console.log('[BATCH6] Items to process after dedup: ' + itemsToProcess.length);

  if (itemsToProcess.length === 0) {
    console.log('[BATCH6] All items already processed.');
    return;
  }

  await fs.ensureDir(DOWNLOAD_BASE);

  const { browser, page } = await createBrowserContext({
    headless: true,
    storageStatePath: themembersAuthStatePath,
    acceptDownloads: false
  });

  let loginSucceeded = false;

  try {
    for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
      console.log('[BATCH6] Login attempt ' + loginAttempt + '/3...');
      await page.goto(env.THEMEMBERS_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForHydration(page);
      await page.waitForTimeout(3_000);

      const hasLoginForm = await page
        .locator('input[type="email"], input[type="password"]')
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      if (!hasLoginForm) {
        const currentUrl = page.url();
        if (currentUrl.includes('/homepage') || currentUrl.includes('/courses')) {
          console.log('[BATCH6] Already authenticated (no login form found).');
          loginSucceeded = true;
          break;
        }
      }

      try {
        await page
          .locator('input[type="email"], input[name="email"], input[id="email"]')
          .first()
          .fill(env.THEMEMBERS_EMAIL ?? '', { timeout: 10_000 });
        await page.locator('input[type="password"]').first().fill(env.THEMEMBERS_PASSWORD ?? '', { timeout: 10_000 });
        await page
          .locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar")')
          .first()
          .click({ timeout: 10_000 });
        await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => undefined);
        await page.waitForTimeout(5_000);
      } catch (fillErr) {
        console.log('[BATCH6] Could not fill login form: ' + (fillErr instanceof Error ? fillErr.message : String(fillErr)));
        if (loginAttempt < 3) {
          await page.waitForTimeout(3_000);
          continue;
        }
      }

      const postLoginUrl = page.url();
      const stillHasLoginForm = await page
        .locator('input[type="email"], input[type="password"]')
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);

      if (!stillHasLoginForm && (postLoginUrl.includes('/homepage') || postLoginUrl.includes('/courses'))) {
        console.log('[BATCH6] Login succeeded!');
        loginSucceeded = true;
        break;
      }

      console.log('[BATCH6] Login attempt ' + loginAttempt + ' - URL: ' + postLoginUrl);
      if (loginAttempt < 3) await page.waitForTimeout(3_000);
    }

    if (!loginSucceeded) {
      console.log('[BATCH6] All login attempts failed. Exiting.');
      for (const item of itemsToProcess) {
        failureResults.push({
          courseSlug: item.courseSlug,
          lessonUrl: item.lessonUrl,
          assetName: item.assetName,
          errorCategory: 'AUTH_ERROR',
          errorMessage: 'Login failed after 3 attempts',
          attempt: 0,
          failedAt: new Date().toISOString()
        });
      }
      await fs.writeJson(FAILURE_OUTPUT_PATH, failureResults, { spaces: 2 });
      return;
    }

    console.log('[BATCH6] Authenticated. Processing ' + itemsToProcess.length + ' items...');

    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];

      if ((i + 1) % 5 === 0 || i === 0) {
        console.log('[BATCH6] Progress ' + (i + 1) + '/' + itemsToProcess.length + ' - ' + item.courseSlug + ' / ' + item.assetName);
      }

      let cloudflareUrl: string | null = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await waitForHydration(page);

          const result = await getFreshUrlFromLessonPage(page, item.assetName);

          if (!result) {
            if (attempt < 3) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            failureResults.push({
              courseSlug: item.courseSlug,
              lessonUrl: item.lessonUrl,
              assetName: item.assetName,
              errorCategory: 'CLOUDFLARE_URL_NOT_CAPTURED',
              errorMessage: 'Could not get fresh download URL after 3 attempts',
              attempt,
              failedAt: new Date().toISOString()
            });
            break;
          }

          cloudflareUrl = result.url;
          const targetPath = getTargetPath(item.courseSlug, item.moduleName, item.lessonName, item.assetName);
          await fs.ensureDir(path.dirname(targetPath));

          const dlResult = await downloadAsset(cloudflareUrl, targetPath, 3);

          if (!dlResult.success) {
            if (attempt < 3) {
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
            failureResults.push({
              courseSlug: item.courseSlug,
              lessonUrl: item.lessonUrl,
              assetName: item.assetName,
              errorCategory: dlResult.error === 'FILE_EMPTY_OR_INVALID' ? 'FILE_EMPTY_OR_INVALID' : 'DOWNLOAD_FAILED',
              errorMessage: dlResult.error ?? 'Download failed',
              attempt,
              failedAt: new Date().toISOString()
            });
            break;
          }

          successResults.push({
            courseSlug: item.courseSlug,
            lessonUrl: item.lessonUrl,
            assetName: item.assetName,
            downloadedPath: targetPath,
            cloudflareUrl,
            sha256: dlResult.sha256,
            downloadedAt: new Date().toISOString()
          });

          await updateManifest(item.courseSlug, item.assetName, targetPath, 'batch6-retry-v3');
          break;
        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          if (attempt === 3) {
            failureResults.push({
              courseSlug: item.courseSlug,
              lessonUrl: item.lessonUrl,
              assetName: item.assetName,
              errorCategory: 'TIMEOUT',
              errorMessage: errMsg,
              attempt,
              failedAt: new Date().toISOString()
            });
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      if ((i + 1) % 5 === 0) {
        await fs.writeJson(OUTPUT_PATH, successResults, { spaces: 2 });
        if (failureResults.length > 0) {
          await fs.writeJson(FAILURE_OUTPUT_PATH, failureResults, { spaces: 2 });
        }
      }
    }
  } finally {
    await browser.close();
  }

  await fs.writeJson(OUTPUT_PATH, successResults, { spaces: 2 });
  if (failureResults.length > 0) {
    await fs.writeJson(FAILURE_OUTPUT_PATH, failureResults, { spaces: 2 });
  }

  console.log('[BATCH6] Done. Success: ' + successResults.length + ', Failures: ' + failureResults.length);
}

main().catch(err => {
  console.error('[BATCH6] Fatal error:', err);
  process.exit(1);
});