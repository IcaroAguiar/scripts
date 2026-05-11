import fs from 'fs-extra';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fillLoginForm, persistStorageState } from '../core/auth/session';
import { waitForHydration, scrollToBottom, expandAccordions } from '../core/browser/browser';
import { assetNameFromUrl } from '../core/extractors/assets';
import { Logger } from '../core/logger/logger';
import { sha256File } from '../core/download/hash';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const AUTH_STATE = 'storage/auth/themembers-retry-batch3.json';
const QUEUE_PATH = 'storage/audit/v3_wave_url_only_queue.json';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const LOGS_DIR = 'storage/logs';
const OUTPUT_AUDIT = 'storage/audit/v3_wave_url_retry_batch3.json';

const TARGET_COURSES = ['excel-avancado', 'excel-essencial', 'figma', 'gestao-de-performance-e-cultura-de-resultados'];

type QueueItem = {
  courseSlug: string;
  courseName: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  url: string;
};

type DownloadResult = {
  courseSlug: string;
  moduleName: string;
  lessonName: string;
  assetName: string;
  status: 'downloaded' | 'failed' | 'skipped';
  localPath?: string;
  sha256?: string;
  error?: string;
  newUrl?: string;
};

type AuditEntry = {
  queueItem: QueueItem;
  result: DownloadResult;
  retries: number;
  timestamp: string;
};

const RETRY_MAX = 3;

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

function isUnresolved(url: string): boolean {
  return url.startsWith('unresolved://');
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

async function clickAndCaptureDownload(
  page: Page,
  materialName: string,
  timeoutMs = 8000
): Promise<string | null> {
  const capturedUrls: string[] = [];

  const onRequest = (req: { url(): string }) => {
    const url = req.url();
    if (/cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url)) {
      if (!capturedUrls.includes(url)) capturedUrls.push(url);
    }
  };
  const onResponse = (res: { url(): string }) => {
    const url = res.url();
    if (/cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url)) {
      if (!capturedUrls.includes(url)) capturedUrls.push(url);
    }
  };

  page.on('request', onRequest as any);
  page.on('response', onResponse as any);

  try {
    const normalizedName = materialName.replace(/_/g, ' ').toLowerCase().trim();

    const candidates = page.locator('button, a, [role="button"]').filter({ hasText: new RegExp(normalizedName, 'i') });

    const exactMatch = page.locator('button, a, [role="button"]').filter({ hasText: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });

    const elements =
      (await exactMatch.count()) > 0
        ? exactMatch
        : candidates;

    const count = await elements.count();
    if (count === 0) return null;

    const material = elements.first();

    const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);

    await material.scrollIntoViewIfNeeded().catch(() => undefined);
    await material.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1500);

    const download = await downloadPromise;
    if (download) {
      const tmpPath = `/tmp/retry-download-${Date.now()}-${download.suggestedFilename()}`;
      await download.saveAs(tmpPath);
      const lastSigned = capturedUrls.at(-1);
      return lastSigned ?? `file://${tmpPath}`;
    }

    return capturedUrls.at(-1) ?? null;
  } finally {
    page.off('request', onRequest as any);
    page.off('response', onResponse as any);
  }
}

async function resolveAndDownload(
  page: Page,
  item: QueueItem,
  logger: Logger
): Promise<DownloadResult> {
  const targetDir = path.join(
    DOWNLOADS_DIR,
    item.courseSlug,
    cleanPathComponent(item.moduleName),
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
      sha256: existingSha ?? undefined
    };
  }

  await fs.ensureDir(targetDir);

  const signedUrl = await clickAndCaptureDownload(page, item.assetName);

  if (!signedUrl) {
    return {
      courseSlug: item.courseSlug,
      moduleName: item.moduleName,
      lessonName: item.lessonName,
      assetName: item.assetName,
      status: 'failed',
      error: 'Click did not capture a signed Cloudflare URL'
    };
  }

  if (signedUrl.startsWith('file://')) {
    const tmpPath = signedUrl.replace('file://', '');
    await fs.copy(tmpPath, targetPath);
    await fs.remove(tmpPath).catch(() => undefined);
  } else {
    await fetchToFile(signedUrl, targetPath, 120_000);
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
    newUrl: signedUrl
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
  const queue: QueueItem[] = await fs.readJson(QUEUE_PATH);
  const items = queue.filter(
    (i) => TARGET_COURSES.includes(i.courseSlug) && isUnresolved(i.url)
  );

  console.log(`Found ${items.length} unresolved assets in target courses`);

  for (const c of TARGET_COURSES) {
    const count = items.filter((i) => i.courseSlug === c).length;
    console.log(`  ${c}: ${count}`);
  }

  const audit: AuditEntry[] = [];
  const logger = new Logger(LOGS_DIR);

  const browser = await chromium.launch({ headless: false });
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
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);

    const filled = await fillLoginForm(page, EMAIL, PASSWORD);
    if (filled) {
      await logger.log('LOGIN', 'login form submitted');
    }

    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(3000);
    await context.storageState({ path: AUTH_STATE });
    await logger.log('LOGIN', `auth state saved to ${AUTH_STATE}`);
  } else {
    console.log('Using existing auth state');
  }

  const groupedByLesson = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = item.lessonUrl;
    if (!groupedByLesson.has(key)) groupedByLesson.set(key, []);
    groupedByLesson.get(key)!.push(item);
  }

  let processedCount = 0;
  let loggedCount = 0;

  for (const [lessonUrl, lessonItems] of groupedByLesson) {
    console.log(`\nNavigating to: ${lessonUrl}`);
    await logger.log('NAVIGATE', lessonUrl, { assets: lessonItems.map((i) => i.assetName) });

    try {
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log(`Failed to navigate to lesson: ${e}`);
      await logger.log('FAILED', `navigation failed for ${lessonUrl}`, { error: String(e) });
      for (const item of lessonItems) {
        audit.push({
          queueItem: item,
          result: {
            courseSlug: item.courseSlug,
            moduleName: item.moduleName,
            lessonName: item.lessonName,
            assetName: item.assetName,
            status: 'failed',
            error: `Navigation failed: ${e}`
          },
          retries: 0,
          timestamp: new Date().toISOString()
        });
      }
      continue;
    }

    for (const item of lessonItems) {
      processedCount++;
      loggedCount++;

      let lastResult: DownloadResult | null = null;
      let retries = 0;

      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        if (attempt > 0) {
          await page.waitForTimeout(2000);
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await waitForHydration(page);
          await expandAccordions(page);
          await scrollToBottom(page);
          await page.waitForTimeout(1000);
        }

        const result = await resolveAndDownload(page, item, logger);
        lastResult = result;

        if (result.status === 'downloaded') {
          break;
        }

        retries = attempt;

        if (attempt < RETRY_MAX) {
          await logger.log('RETRY', `asset retry ${attempt + 1}/${RETRY_MAX}`, {
            asset: item.assetName,
            error: result.error
          });
        }
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

      if (loggedCount % 5 === 0) {
        await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });
        console.log(`[${loggedCount}/${items.length}] Logged batch`);
      }
    }
  }

  await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });

  const downloaded = audit.filter((a) => a.result.status === 'downloaded').length;
  const failed = audit.filter((a) => a.result.status === 'failed').length;
  const skipped = audit.filter((a) => a.result.status === 'skipped').length;

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${audit.length}`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Output: ${OUTPUT_AUDIT}`);

  await browser.close();
}

main().catch(console.error);