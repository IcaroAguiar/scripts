import fs from 'fs-extra';
import path from 'node:path';
import { createBrowserContext, waitForHydration, expandAccordions, scrollToBottom } from '../core/browser/browser';
import { themembersAuthStatePath } from '../config/platforms/themembers';
import { loadEnv } from '../core/config/env';

const RETRY_QUEUE_PATH = 'storage/audit/v3_wave_asset_mapping_plan.json';
const RESULTS_SUCCESS_PATH = 'storage/audit/v3_wave_platform_retry_results.json';
const RESULTS_FAILURE_PATH = 'storage/audit/v3_wave_platform_retry_failures.json';
const REPAIRED_MANIFEST_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOAD_BASE = 'storage/downloads/themembers-v3-retry';

interface RetryItem {
  courseSlug: string;
  lessonUrl: string;
  expectedAssetName: string;
  priority: 'P0' | 'P1';
  reason: string;
  moduleOrder?: string;
  moduleSlug?: string;
  lessonOrder?: string;
  lessonSlug?: string;
  moduleIndex?: number;
  lessonIndex?: number;
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

type ErrorCategory =
  | 'AUTH_ERROR'
  | 'COURSE_NAVIGATION_ERROR'
  | 'MODULE_NAVIGATION_ERROR'
  | 'LESSON_NAVIGATION_ERROR'
  | 'MATERIAL_SECTION_NOT_FOUND'
  | 'DOWNLOAD_BUTTON_NOT_FOUND'
  | 'CLOUDFLARE_URL_NOT_CAPTURED'
  | 'DOWNLOAD_FAILED'
  | 'FILE_EMPTY_OR_INVALID'
  | 'TIMEOUT'
  | 'UNKNOWN_ERROR'
  | 'SOURCE_NO_ASSET_FOUND';

async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
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

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, bytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.ensureDir(dir);
}

async function doLogin(page: any, env: ReturnType<typeof loadEnv>): Promise<boolean> {
  try {
    await page.goto(env.THEMEMBERS_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await waitForHydration(page);

    const hasEmailInput = await page.locator('input[type="email"], input[name="email"], input[id="email"]').first().isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasEmailInput) {
      const hasPasswordInput = await page.locator('input[type="password"]').first().isVisible({ timeout: 5_000 }).catch(() => false);
      if (!hasPasswordInput) {
        return false;
      }
    }

    const emailSel = 'input[type="email"], input[name="email"], input[id="email"]';
    const pwdSel = 'input[type="password"], input[name="password"], input[id="password"]';
    const submitSel = 'button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar"), button:has-text("Acessar conta")';

    await page.locator(emailSel).first().fill(env.THEMEMBERS_EMAIL ?? '', { timeout: 5_000 });
    await page.locator(pwdSel).first().fill(env.THEMEMBERS_PASSWORD ?? '', { timeout: 5_000 });
    await page.locator(submitSel).first().click({ timeout: 5_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function getCloudflareUrlFromLessonPage(
  page: any,
  expectedAssetName: string
): Promise<{ url: string; fileName: string } | null> {
  const originalUrl = page.url();
  const cleanExpected = cleanName(expectedAssetName).toLowerCase();

  const capturedUrls: string[] = [];
  const onRequest = (request: { url(): string }) => {
    const url = request.url();
    if (url.includes('cloudflarestorage') || /\.(pdf|zip|docx?|xlsx?|pptx?|mp3|m4a|wav|ogg)\b/i.test(url)) {
      capturedUrls.push(url);
    }
  };
  const onResponse = (response: { url(): string }) => {
    const url = response.url();
    if (url.includes('cloudflarestorage') || /\.(pdf|zip|docx?|xlsx?|pptx?|mp3|m4a|wav|ogg)\b/i.test(url)) {
      capturedUrls.push(url);
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    await expandAccordions(page);
    if (page.url() !== originalUrl) {
      page.off('request', onRequest);
      page.off('response', onResponse);
      return null;
    }

    await scrollToBottom(page, 10);
    if (page.url() !== originalUrl) {
      page.off('request', onRequest);
      page.off('response', onResponse);
      return null;
    }
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
      try {
        const parsed = new URL(signedUrl);
        const fileName = parsed.searchParams.get('X-Amz-Algorithm')
          ? (parsed.pathname.split('/').pop() ?? expectedAssetName)
          : expectedAssetName;
        return { url: signedUrl, fileName };
      } catch {
        return { url: signedUrl, fileName: expectedAssetName };
      }
    }

    if (download) {
      const suggestedName = download.suggestedFilename() ?? '';
      const downloadExt = suggestedName.split('.').pop()?.toLowerCase() ?? '';
      const matchingUrl = capturedUrls.find(url => url.toLowerCase().includes(`.${downloadExt}`));
      return { url: matchingUrl ?? capturedUrls[capturedUrls.length - 1] ?? '', fileName: suggestedName };
    }

    return null;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

async function downloadAsset(url: string, targetPath: string, maxRetries: number = 3): Promise<{ success: boolean; error?: string; sha256?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ensureDir(path.dirname(targetPath));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180_000);
      let bytes: Buffer;

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow'
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
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
      if (attempt === maxRetries) {
        return { success: false, error: `DOWNLOAD_FAILED: ${err?.message ?? String(err)}` };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return { success: false, error: 'DOWNLOAD_FAILED after retries' };
}

async function updateManifest(courseSlug: string, lessonUrl: string, assetName: string, localPath: string, provenance: string): Promise<void> {
  const manifestPath = path.join(REPAIRED_MANIFEST_DIR, `${courseSlug}.json`);
  if (!(await fs.pathExists(manifestPath))) return;

  const manifest = await fs.readJson(manifestPath);
  const cleanAsset = cleanName(assetName).toLowerCase();
  let updated = false;

  for (const mod of manifest.modules ?? []) {
    for (const lesson of mod.lessons ?? []) {
      const lessonUrlPart = lessonUrl.split('/').pop() ?? '';
      if (lesson.url?.includes(lessonUrlPart) || lessonUrl.includes(lesson.url?.split('/').pop() ?? '')) {
        for (const asset of lesson.assets ?? []) {
          const assetClean = cleanName(asset.name).toLowerCase();
          if (assetClean.includes(cleanAsset) || cleanAsset.includes(assetClean)) {
            asset.localPath = localPath;
            asset.provenance = provenance;
            asset.status = 'downloaded';
            updated = true;
          }
        }
      }
    }
  }

  if (updated) {
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  }
}

function getTargetPath(item: RetryItem, fileName: string): string {
  const modOrder = (item.moduleIndex ?? 1).toString().padStart(2, '0');
  const modSlug = item.moduleSlug ?? `module-${modOrder}`;
  const lesOrder = (item.lessonIndex ?? 1).toString().padStart(2, '0');
  const lesSlug = item.lessonSlug ?? `lesson-${lesOrder}`;
  return path.join(DOWNLOAD_BASE, item.courseSlug, `${modOrder}-${modSlug}`, `${lesOrder}-${lesSlug}`, 'materiais', fileName);
}

async function main() {
  const env = loadEnv();
  console.log('[PLATFORM-RETRY] Starting platform retry for P0/P1 items...');

  const planData = await fs.readJson(RETRY_QUEUE_PATH);
  const allItems: RetryItem[] = planData.retryQueue ?? [];

  const p0Items = allItems.filter(i => i.priority === 'P0');
  const p1Items = allItems.filter(i => i.priority === 'P1');
  console.log(`[PLATFORM-RETRY] P0: ${p0Items.length}, P1: ${p1Items.length}`);

  let successResults: SuccessResult[] = [];
  let failureResults: FailureResult[] = [];

  if (await fs.pathExists(RESULTS_SUCCESS_PATH)) {
    successResults = await fs.readJson(RESULTS_SUCCESS_PATH);
  }
  if (await fs.pathExists(RESULTS_FAILURE_PATH)) {
    failureResults = await fs.readJson(RESULTS_FAILURE_PATH);
  }

  const alreadyDone = new Set(successResults.map(s => `${s.courseSlug}::${s.lessonUrl}::${s.assetName}`));

  const itemsToProcess = [...p0Items, ...p1Items].filter(
    item => !alreadyDone.has(`${item.courseSlug}::${item.lessonUrl}::${item.expectedAssetName}`)
  );

  console.log(`[PLATFORM-RETRY] Items to process: ${itemsToProcess.length}`);
  if (itemsToProcess.length === 0) {
    console.log('[PLATFORM-RETRY] Nothing to process, all items already completed.');
    return;
  }

  await ensureDir(DOWNLOAD_BASE);

  const { browser, page } = await createBrowserContext({
    headless: true,
    storageStatePath: themembersAuthStatePath,
    acceptDownloads: false
  });

  let loginSucceeded = false;

  try {
    for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
      console.log(`[PLATFORM-RETRY] Login attempt ${loginAttempt}/3...`);
      await page.goto(env.THEMEMBERS_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForHydration(page);
      await page.waitForTimeout(3_000);

      const urlAfterLoad = page.url();
      console.log(`[PLATFORM-RETRY] After goto URL: ${urlAfterLoad}`);

      const hasLoginForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 5_000 }).catch(() => false);
      console.log(`[PLATFORM-RETRY] Has login form: ${hasLoginForm}`);

      if (!hasLoginForm) {
        const currentUrl = page.url();
        if (currentUrl.includes('/homepage') || currentUrl.includes('/courses')) {
          console.log('[PLATFORM-RETRY] Already on authenticated page after goto (no login form found).');
          loginSucceeded = true;
          break;
        }
        console.log('[PLATFORM-RETRY] No login form visible but not on expected page. Retrying...');
        if (loginAttempt < 3) {
          await page.waitForTimeout(3_000);
          continue;
        }
      }

      try {
        await page.locator('input[type="email"], input[name="email"], input[id="email"]').first().fill(env.THEMEMBERS_EMAIL ?? '', { timeout: 10_000 });
        await page.locator('input[type="password"]').first().fill(env.THEMEMBERS_PASSWORD ?? '', { timeout: 10_000 });
        await page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar")').first().click({ timeout: 10_000 });
        await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => undefined);
        await page.waitForTimeout(5_000);
      } catch (fillErr) {
        console.log('[PLATFORM-RETRY] Could not fill login form:', fillErr instanceof Error ? fillErr.message : String(fillErr));
        if (loginAttempt < 3) {
          await page.waitForTimeout(3_000);
          continue;
        }
      }

      const postLoginUrl = page.url();
      const stillHasLoginForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false);

      if (!stillHasLoginForm && (postLoginUrl.includes('/homepage') || postLoginUrl.includes('/courses'))) {
        console.log('[PLATFORM-RETRY] Login succeeded!');
        loginSucceeded = true;
        break;
      }

      console.log(`[PLATFORM-RETRY] Login attempt ${loginAttempt} - URL: ${postLoginUrl}, stillHasLoginForm: ${stillHasLoginForm}`);
      if (loginAttempt < 3) {
        await page.waitForTimeout(3_000);
      }
    }

    if (!loginSucceeded) {
      console.log('[PLATFORM-RETRY] All login attempts failed. Recording AUTH_ERROR for all items and exiting.');
      for (const item of itemsToProcess) {
        failureResults.push({
          courseSlug: item.courseSlug,
          lessonUrl: item.lessonUrl,
          assetName: item.expectedAssetName,
          errorCategory: 'AUTH_ERROR',
          errorMessage: 'Login failed after 3 attempts',
          attempt: 0,
          failedAt: new Date().toISOString()
        });
      }
      await fs.writeJson(RESULTS_FAILURE_PATH, failureResults, { spaces: 2 });
      return;
    }

    const authStateUrl = page.url();
    console.log(`[PLATFORM-RETRY] Authenticated page URL: ${authStateUrl}`);

    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];

      if ((i + 1) % 10 === 0 || i === 0) {
        console.log(`[PLATFORM-RETRY] Progress ${i + 1}/${itemsToProcess.length} (${item.courseSlug} / ${item.expectedAssetName})`);
      }

      let cloudflareUrl: string | null = null;
      let assetDownloaded = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await waitForHydration(page);

          const result = await getCloudflareUrlFromLessonPage(page, item.expectedAssetName);

          if (!result) {
            if (attempt < 3) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            failureResults.push({
              courseSlug: item.courseSlug,
              lessonUrl: item.lessonUrl,
              assetName: item.expectedAssetName,
              errorCategory: 'CLOUDFLARE_URL_NOT_CAPTURED',
              errorMessage: 'Could not find download URL for asset after 3 attempts',
              attempt,
              failedAt: new Date().toISOString()
            });
            break;
          }

          cloudflareUrl = result.url;
          const targetPath = getTargetPath(item, result.fileName);
          await ensureDir(path.dirname(targetPath));

          const dlResult = await downloadAsset(cloudflareUrl, targetPath, 3);

          if (!dlResult.success) {
            if (attempt < 3) {
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
            failureResults.push({
              courseSlug: item.courseSlug,
              lessonUrl: item.lessonUrl,
              assetName: item.expectedAssetName,
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
            assetName: item.expectedAssetName,
            downloadedPath: targetPath,
            cloudflareUrl,
            sha256: dlResult.sha256,
            downloadedAt: new Date().toISOString()
          });

          await updateManifest(item.courseSlug, item.lessonUrl, item.expectedAssetName, targetPath, 'platform-retry-v3');
          assetDownloaded = true;
          break;

        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          if (attempt === 3) {
            failureResults.push({
              courseSlug: item.courseSlug,
              lessonUrl: item.lessonUrl,
              assetName: item.expectedAssetName,
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

      if ((i + 1) % 10 === 0) {
        await fs.writeJson(RESULTS_SUCCESS_PATH, successResults, { spaces: 2 });
        await fs.writeJson(RESULTS_FAILURE_PATH, failureResults, { spaces: 2 });
      }
    }

  } finally {
    await browser.close();
  }

  await fs.writeJson(RESULTS_SUCCESS_PATH, successResults, { spaces: 2 });
  await fs.writeJson(RESULTS_FAILURE_PATH, failureResults, { spaces: 2 });

  console.log(`[PLATFORM-RETRY] Done. Success: ${successResults.length}, Failures: ${failureResults.length}`);
  const p0Done = successResults.filter(s => {
    const item = allItems.find(a => a.courseSlug === s.courseSlug && a.lessonUrl === s.lessonUrl && a.expectedAssetName === s.assetName);
    return item?.priority === 'P0';
  }).length;
  console.log(`[PLATFORM-RETRY] P0 done: ${p0Done}/${p0Items.length}`);
}

main().catch(err => {
  console.error('[PLATFORM-RETRY] Fatal error:', err);
  process.exit(1);
});
