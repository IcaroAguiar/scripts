import fs from 'fs-extra';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Logger } from '../core/logger/logger';
import { sha256File } from '../core/download/hash';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_URL = `${BASE_URL}/login`;
const AUTH_STATE = 'storage/auth/themembers-retry-figma.json';
const QUEUE_PATH = 'storage/audit/v3_wave_url_only_queue.json';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_AUDIT = 'storage/audit/url_retry_figma.json';
const LOGS_DIR = 'storage/logs';

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
  courseSlug: string;
  moduleName: string;
  lessonName: string;
  assetName: string;
  status: 'downloaded' | 'failed' | 'skipped' | 'retry_failed';
  localPath?: string;
  sha256?: string;
  newUrl?: string;
  error?: string;
  attemptCount: number;
}

interface AuditEntry {
  queueItem: QueueItem;
  result: DownloadResult;
  retries: number;
  timestamp: string;
}

const TARGET_COURSE = 'figma';
const RETRY_MAX = 3;

function isUnresolved(url: string): boolean {
  return url.startsWith('unresolved://');
}

function isSignedMaterialUrl(url: string): boolean {
  return /cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanPathComponent(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function slugModule(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
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

async function ensureLogin(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const hasAuth = await fs.pathExists(AUTH_STATE);
  const context = await browser.newContext({
    ...(hasAuth ? { storageState: AUTH_STATE } : {}),
    acceptDownloads: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  if (!hasAuth) {
    console.log('Logging in...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await sleep(1000);

    const emailInput = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    const submitButton = page.locator('button[type="submit"]').first();

    const emailCount = await emailInput.count();
    const passwordCount = await passwordInput.count();

    if (emailCount > 0 && passwordCount > 0) {
      await emailInput.fill(EMAIL);
      await passwordInput.fill(PASSWORD);
      await submitButton.click();
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await sleep(3000);
    }

    await context.storageState({ path: AUTH_STATE });
    console.log('Auth state saved');
  } else {
    console.log('Using existing auth state');
  }

  return { context, page };
}

async function expandAccordions(page: Page): Promise<void> {
  const candidates = page
    .locator('button, [role="button"], summary, [aria-expanded="false"], [class*="accordion"], [class*="collapse"]')
    .filter({ hasNotText: /^$/ });
  const count = Math.min(await candidates.count(), 25);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const expanded = await candidate.getAttribute('aria-expanded').catch(() => null);
    if (expanded === 'true') continue;
    await candidate.click({ timeout: 300 }).catch(() => undefined);
  }
}

async function scrollToBottom(page: Page, maxSteps = 8): Promise<void> {
  let previousHeight = 0;
  for (let index = 0; index < maxSteps; index += 1) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === previousHeight) break;
    previousHeight = height;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
  }
}

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}

async function resolveAndDownload(
  page: Page,
  item: QueueItem,
  logger: Logger,
  attempt: number
): Promise<DownloadResult> {
  const targetDir = path.join(
    DOWNLOADS_DIR,
    item.courseSlug,
    slugModule(item.moduleName),
    cleanPathComponent(item.lessonName),
    'materiais'
  );
  const safeAssetName = cleanPathComponent(item.assetName);
  const targetPath = path.join(targetDir, safeAssetName);

  if (await fs.pathExists(targetPath)) {
    const existingSha = await sha256File(targetPath).catch(() => null);
    return {
      courseSlug: item.courseSlug,
      moduleName: item.moduleName,
      lessonName: item.lessonName,
      assetName: item.assetName,
      status: 'skipped',
      localPath: targetPath,
      sha256: existingSha ?? undefined,
      attemptCount: attempt
    };
  }

  await fs.ensureDir(targetDir);

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

  let signedUrl: string | null = null;

  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);

    const normalizedName = item.assetName.replace(/_/g, ' ').toLowerCase().trim();
    const material = page.getByText(new RegExp(normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
    const count = await material.count();

    if (count === 0) {
      logger.log('WARN', `material not found on page: ${item.assetName}`, { lessonUrl: item.lessonUrl });
      return {
        courseSlug: item.courseSlug,
        moduleName: item.moduleName,
        lessonName: item.lessonName,
        assetName: item.assetName,
        status: 'failed',
        error: 'Material button not found on page',
        attemptCount: attempt
      };
    }

    await material.scrollIntoViewIfNeeded().catch(() => undefined);
    await sleep(300);
    await material.click({ timeout: 5000 }).catch((e: Error) => {
      logger.log('WARN', `click failed: ${e.message}`, { assetName: item.assetName });
    });

    const download = await downloadPromise;
    await sleep(1500);

    signedUrl = capturedUrls.length > 0 ? capturedUrls[capturedUrls.length - 1] : null;

    if (download && !signedUrl) {
      const filename = download.suggestedFilename();
      logger.log('WARN', `download intercepted but no R2 URL captured: ${filename}`, { assetName: item.assetName });
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  if (!signedUrl) {
    return {
      courseSlug: item.courseSlug,
      moduleName: item.moduleName,
      lessonName: item.lessonName,
      assetName: item.assetName,
      status: 'failed',
      error: 'Click did not capture a signed Cloudflare R2 URL',
      attemptCount: attempt
    };
  }

  try {
    await fetchToFile(signedUrl, targetPath, 120_000);
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    if (msg.includes('403')) {
      return {
        courseSlug: item.courseSlug,
        moduleName: item.moduleName,
        lessonName: item.lessonName,
        assetName: item.assetName,
        status: 'retry_failed',
        error: `403 Forbidden on R2 URL - needs fresh URL generation via platform click`,
        newUrl: signedUrl,
        attemptCount: attempt
      };
    }
    return {
      courseSlug: item.courseSlug,
      moduleName: item.moduleName,
      lessonName: item.lessonName,
      assetName: item.assetName,
      status: 'failed',
      error: `Fetch failed: ${msg}`,
      newUrl: signedUrl,
      attemptCount: attempt
    };
  }

  const sha = await sha256File(targetPath);
  return {
    courseSlug: item.courseSlug,
    moduleName: item.moduleName,
    lessonName: item.lessonName,
    assetName: item.assetName,
    status: 'downloaded',
    localPath: targetPath,
    sha256: sha,
    newUrl: signedUrl,
    attemptCount: attempt
  };
}

async function updateManifest(item: QueueItem, localPath: string, sha256: string): Promise<void> {
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
            asset.sha256 = sha256;
            asset.url = item.url;
            delete asset.lastError;
            updated = true;
          }
        }
      }
    }

    if (updated) {
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    }
  } catch (e) {
    // manifest update failure is non-fatal
  }
}

async function main() {
  const logger = new Logger(LOGS_DIR);

  let queue: QueueItem[] = [];
  if (await fs.pathExists(QUEUE_PATH)) {
    queue = await fs.readJson(QUEUE_PATH);
  } else {
    console.log('Queue not found at', QUEUE_PATH, '- building from manifest');
  }

  const items = queue.filter(
    (i) => i.courseSlug === TARGET_COURSE && isUnresolved(i.url)
  );

  if (items.length === 0) {
    console.log(`No unresolved assets found for ${TARGET_COURSE} in queue`);
    console.log('Checking manifest directly for unresolved assets...');
    const manifestPath = path.join(MANIFESTS_DIR, `${TARGET_COURSE}.json`);
    if (await fs.pathExists(manifestPath)) {
      const manifest = await fs.readJson(manifestPath);
      for (const mod of manifest.modules ?? []) {
        for (const lesson of mod.lessons ?? []) {
          for (const asset of lesson.assets ?? []) {
            if (isUnresolved(asset.url)) {
              items.push({
                courseSlug: TARGET_COURSE,
                courseName: manifest.course,
                moduleName: mod.name,
                lessonName: lesson.name,
                lessonUrl: lesson.url,
                assetName: asset.name,
                url: asset.url
              });
            }
          }
        }
      }
    }
  }

  console.log(`Found ${items.length} unresolved assets for ${TARGET_COURSE}`);

  const browser = await chromium.launch({ headless: false });
  const { page } = await ensureLogin(browser);
  const audit: AuditEntry[] = [];
  let processedCount = 0;

  const groupedByLesson = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = item.lessonUrl;
    if (!groupedByLesson.has(key)) groupedByLesson.set(key, []);
    groupedByLesson.get(key)!.push(item);
  }

  for (const [lessonUrl, lessonItems] of groupedByLesson) {
    console.log(`\n=== Navigating to: ${lessonUrl}`);
    logger.log('NAVIGATE', lessonUrl, { assets: lessonItems.map((i) => i.assetName) });

    try {
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await page.waitForTimeout(1500);
    } catch (e) {
      console.log(`Navigation failed: ${e}`);
      logger.log('FAILED', `navigation failed for ${lessonUrl}`, { error: String(e) });
      for (const item of lessonItems) {
        audit.push({
          queueItem: item,
          result: {
            courseSlug: item.courseSlug,
            moduleName: item.moduleName,
            lessonName: item.lessonName,
            assetName: item.assetName,
            status: 'failed',
            error: `Navigation failed: ${e}`,
            attemptCount: 0
          },
          retries: 0,
          timestamp: new Date().toISOString()
        });
      }
      continue;
    }

    for (const item of lessonItems) {
      processedCount++;
      let lastResult: DownloadResult | null = null;
      let retries = 0;

      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        if (attempt > 0) {
          console.log(`  Retry ${attempt}/${RETRY_MAX} for: ${item.assetName}`);
          await logger.log('RETRY', `asset retry ${attempt}/${RETRY_MAX}`, {
            asset: item.assetName,
            error: lastResult?.error
          });
          await page.waitForTimeout(2000);
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await waitForHydration(page);
          await expandAccordions(page);
          await scrollToBottom(page);
          await page.waitForTimeout(1000);
        }

        const result = await resolveAndDownload(page, item, logger, attempt + 1);
        lastResult = result;

        console.log(`  [${processedCount}/${items.length}] ${item.assetName}: ${result.status}${result.error ? ' - ' + result.error : ''}`);

        if (result.status === 'downloaded') {
          break;
        }

        retries = attempt;
      }

      if (lastResult!.status === 'downloaded' && lastResult!.localPath && lastResult!.sha256) {
        await updateManifest(item, lastResult!.localPath, lastResult!.sha256);
      }

      audit.push({
        queueItem: item,
        result: lastResult!,
        retries,
        timestamp: new Date().toISOString()
      });

      if (processedCount % 5 === 0) {
        await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });
        console.log(`\n[${processedCount}/${items.length}] Batch logged`);
      }
    }
  }

  await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });

  const downloaded = audit.filter((a) => a.result.status === 'downloaded').length;
  const failed = audit.filter((a) => a.result.status === 'failed').length;
  const skipped = audit.filter((a) => a.result.status === 'skipped').length;
  const retryFailed = audit.filter((a) => a.result.status === 'retry_failed').length;

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${audit.length}`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Retry-Failed: ${retryFailed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Output: ${OUTPUT_AUDIT}`);

  await browser.close();
}

main().catch(console.error);
