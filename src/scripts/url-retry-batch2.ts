import fs from 'fs-extra';
import path from 'node:path';
import { createBrowserContext, waitForHydration, expandAccordions, scrollToBottom } from '../core/browser/browser';
import { themembersAuthStatePath } from '../config/platforms/themembers';
import { loadEnv } from '../core/config/env';

const QUEUE_PATH = 'storage/audit/v3_wave_url_only_queue.json';
const OUTPUT_PATH = 'storage/audit/v3_wave_url_retry_batch2.json';
const REPAIRED_MANIFEST_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOAD_BASE = 'storage/downloads/themembers-v3-retry';
const LOG_EVERY = 5;

const TARGET_COURSES = [
  'cultura-organizacional-e-times-de-alta-performance-formacao',
  'cultura-organizacional-e-times-de-alta-performance',
  'curso-completo-de-inteligencia-artificial',
  'design-de-dashboards-e-storytelling-com-dados'
];

interface QueueItem {
  courseSlug: string;
  courseName: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  url: string;
}

interface ResultItem {
  courseSlug: string;
  lessonUrl: string;
  assetName: string;
  status: 'success' | 'failed' | 'skipped';
  downloadedPath?: string;
  cloudflareUrl?: string;
  sha256?: string;
  errorCategory?: string;
  errorMessage?: string;
  resolvedUrl?: string;
  attempt: number;
  completedAt: string;
}

function cleanName(name: string): string {
  return name.replace(/[^\w\u00C0-\u024F.\-+_\s-]/g, '').replace(/\s+/g, ' ').trim();
}

async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function getTargetPath(courseSlug: string, moduleName: string, lessonName: string, assetName: string): string {
  const safeMod = cleanName(moduleName).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '');
  const safeLes = cleanName(lessonName).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 60);
  const safeAsset = cleanName(assetName);
  return path.join(DOWNLOAD_BASE, courseSlug, safeMod, safeLes, 'materiais', safeAsset);
}

async function doLogin(page: any, env: ReturnType<typeof loadEnv>): Promise<boolean> {
  try {
    await page.goto(env.THEMEMBERS_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForHydration(page);
    await page.waitForTimeout(2_000);

    const hasLoginForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasLoginForm) {
      const currentUrl = page.url();
      if (currentUrl.includes('/homepage') || currentUrl.includes('/courses')) {
        return true;
      }
    }

    await page.locator('input[type="email"], input[name="email"], input[id="email"]').first().fill(env.THEMEMBERS_EMAIL ?? '', { timeout: 10_000 });
    await page.locator('input[type="password"]').first().fill(env.THEMEMBERS_PASSWORD ?? '', { timeout: 10_000 });
    await page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Acessar")').first().click({ timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);

    const stillHasLoginForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false);
    return !stillHasLoginForm;
  } catch {
    return false;
  }
}

async function getCloudflareUrlFromLessonPage(page: any, expectedAssetName: string): Promise<{ url: string; fileName: string } | null> {
  const originalUrl = page.url();
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
      return null;
    }

    await scrollToBottom(page, 10);
    if (page.url() !== originalUrl) {
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
      await fs.ensureDir(path.dirname(targetPath));

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

async function updateManifest(courseSlug: string, lessonUrl: string, assetName: string, localPath: string): Promise<void> {
  const manifestPath = path.join(REPAIRED_MANIFEST_DIR, `${courseSlug}.json`);
  if (!(await fs.pathExists(manifestPath))) return;

  const manifest = await fs.readJson(manifestPath);
  const cleanAsset = cleanName(assetName).toLowerCase();

  for (const mod of manifest.modules ?? []) {
    for (const lesson of mod.lessons ?? []) {
      const lessonUrlPart = lessonUrl.split('/').pop() ?? '';
      if (lesson.url?.includes(lessonUrlPart) || lessonUrl.includes(lesson.url?.split('/').pop() ?? '')) {
        for (const asset of lesson.assets ?? []) {
          const assetClean = cleanName(asset.name).toLowerCase();
          if (assetClean.includes(cleanAsset) || cleanAsset.includes(assetClean)) {
            asset.localPath = localPath;
            asset.provenance = 'url-retry-batch2';
            asset.status = 'downloaded';
          }
        }
      }
    }
  }

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function main() {
  const env = loadEnv();
  console.log('[URL-RETRY-BATCH2] Starting URL-only asset retry for 4 courses...');

  const queueData = await fs.readJson(QUEUE_PATH);
  const allItems: QueueItem[] = queueData;

  const filteredItems = allItems.filter(item => TARGET_COURSES.includes(item.courseSlug));
  console.log(`[URL-RETRY-BATCH2] Filtered ${filteredItems.length} items for target courses`);

  if (filteredItems.length === 0) {
    console.log('[URL-RETRY-BATCH2] No items to process.');
    await fs.writeJson(OUTPUT_PATH, { results: [], summary: { total: 0, success: 0, failed: 0, skipped: 0 } }, { spaces: 2 });
    return;
  }

  await fs.ensureDir(DOWNLOAD_BASE);

  const results: ResultItem[] = [];

  const { browser, page } = await createBrowserContext({
    headless: true,
    storageStatePath: themembersAuthStatePath,
    acceptDownloads: false
  });

  let loginSucceeded = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[URL-RETRY-BATCH2] Login attempt ${attempt}/3...`);
    const ok = await doLogin(page, env);
    if (ok) {
      loginSucceeded = true;
      console.log('[URL-RETRY-BATCH2] Login succeeded.');
      break;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
  }

  if (!loginSucceeded) {
    console.log('[URL-RETRY-BATCH2] Login failed. Recording failures and exiting.');
    for (const item of filteredItems) {
      results.push({
        courseSlug: item.courseSlug,
        lessonUrl: item.lessonUrl,
        assetName: item.assetName,
        status: 'failed',
        errorCategory: 'AUTH_ERROR',
        errorMessage: 'Login failed after 3 attempts',
        attempt: 0,
        completedAt: new Date().toISOString()
      });
    }
    await fs.writeJson(OUTPUT_PATH, { results, summary: { total: results.length, success: 0, failed: results.length, skipped: 0 } }, { spaces: 2 });
    await browser.close();
    return;
  }

  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];

    if ((i + 1) % LOG_EVERY === 0 || i === 0) {
      console.log(`[URL-RETRY-BATCH2] Progress ${i + 1}/${filteredItems.length} - ${item.courseSlug} / ${item.assetName}`);
    }

    if (item.url.startsWith('unresolved://')) {
      results.push({
        courseSlug: item.courseSlug,
        lessonUrl: item.lessonUrl,
        assetName: item.assetName,
        status: 'skipped',
        errorCategory: 'UNRESOLVED_URL',
        errorMessage: 'URL has unresolved:// prefix, needs fresh generation via UI',
        attempt: 0,
        completedAt: new Date().toISOString()
      });
      continue;
    }

    if (item.url.includes('drive.google.com')) {
      results.push({
        courseSlug: item.courseSlug,
        lessonUrl: item.lessonUrl,
        assetName: item.assetName,
        status: 'skipped',
        errorCategory: 'GOOGLE_DRIVE_LINK',
        errorMessage: 'Google Drive external link, not downloadable via Cloudflare',
        resolvedUrl: item.url,
        attempt: 0,
        completedAt: new Date().toISOString()
      });
      continue;
    }

    let cloudflareUrl: string | null = null;
    let assetDownloaded = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(item.lessonUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await waitForHydration(page);

        const result = await getCloudflareUrlFromLessonPage(page, item.assetName);

        if (!result) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          results.push({
            courseSlug: item.courseSlug,
            lessonUrl: item.lessonUrl,
            assetName: item.assetName,
            status: 'failed',
            errorCategory: 'CLOUDFLARE_URL_NOT_CAPTURED',
            errorMessage: 'Could not capture Cloudflare URL from lesson page after 3 attempts',
            attempt,
            completedAt: new Date().toISOString()
          });
          break;
        }

        cloudflareUrl = result.url;
        const targetPath = getTargetPath(item.courseSlug, item.moduleName, item.lessonName, result.fileName);
        await fs.ensureDir(path.dirname(targetPath));

        const dlResult = await downloadAsset(cloudflareUrl, targetPath, 3);

        if (!dlResult.success) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          results.push({
            courseSlug: item.courseSlug,
            lessonUrl: item.lessonUrl,
            assetName: item.assetName,
            status: 'failed',
            errorCategory: dlResult.error === 'FILE_EMPTY_OR_INVALID' ? 'FILE_EMPTY_OR_INVALID' : 'DOWNLOAD_FAILED',
            errorMessage: dlResult.error ?? 'Download failed',
            cloudflareUrl,
            attempt,
            completedAt: new Date().toISOString()
          });
          break;
        }

        await updateManifest(item.courseSlug, item.lessonUrl, item.assetName, targetPath);

        results.push({
          courseSlug: item.courseSlug,
          lessonUrl: item.lessonUrl,
          assetName: item.assetName,
          status: 'success',
          downloadedPath: targetPath,
          cloudflareUrl,
          sha256: dlResult.sha256,
          resolvedUrl: result.url,
          attempt,
          completedAt: new Date().toISOString()
        });
        assetDownloaded = true;
        break;

      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        if (attempt === 3) {
          results.push({
            courseSlug: item.courseSlug,
            lessonUrl: item.lessonUrl,
            assetName: item.assetName,
            status: 'failed',
            errorCategory: 'TIMEOUT',
            errorMessage: errMsg,
            cloudflareUrl: cloudflareUrl ?? undefined,
            attempt,
            completedAt: new Date().toISOString()
          });
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if ((i + 1) % LOG_EVERY === 0) {
      const successCount = results.filter(r => r.status === 'success').length;
      const failedCount = results.filter(r => r.status === 'failed').length;
      const skippedCount = results.filter(r => r.status === 'skipped').length;
      console.log(`[URL-RETRY-BATCH2] Intermediate - success: ${successCount}, failed: ${failedCount}, skipped: ${skippedCount}`);
    }
  }

  await browser.close();

  const successCount = results.filter(r => r.status === 'success').length;
  const failedCount = results.filter(r => r.status === 'failed').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;

  const output = {
    results,
    summary: {
      total: filteredItems.length,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      processedAt: new Date().toISOString()
    }
  };

  await fs.writeJson(OUTPUT_PATH, output, { spaces: 2 });

  console.log(`[URL-RETRY-BATCH2] Done. Success: ${successCount}, Failed: ${failedCount}, Skipped: ${skippedCount}`);
}

main().catch(err => {
  console.error('[URL-RETRY-BATCH2] Fatal error:', err);
  process.exit(1);
});