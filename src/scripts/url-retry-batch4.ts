import fs from 'fs-extra';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { sha256File } from '../core/download/hash';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const AUTH_STATE = 'storage/auth/themembers-retry-batch4.json';
const QUEUE_PATH = 'storage/audit/v3_wave_url_only_queue.json';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_AUDIT = 'storage/audit/v3_wave_url_retry_batch4.json';

const TARGET_COURSES = [
  'gestao-de-tempo-e-produtividade',
  'imersao-em-excel-essencial',
  'ingles-para-iniciantes',
  'integracoes-com-api-usando-power-query'
];

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
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
  } finally {
    clearTimeout(timeout);
  }
}

async function clickAndCaptureUrl(
  page: Page,
  materialName: string
): Promise<string | null> {
  const capturedUrls: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (/cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url)) {
      if (!capturedUrls.includes(url)) capturedUrls.push(url);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (/cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url)) {
      if (!capturedUrls.includes(url)) capturedUrls.push(url);
    }
  });

  try {
    const normalized = materialName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const exact = page.locator('*').filter({ hasText: new RegExp(`^${normalized}$`, 'i') });
    const partial = page.locator('*').filter({ hasText: new RegExp(normalized, 'i') });

    const elements = (await exact.count()) > 0 ? exact : partial;
    const count = await elements.count();

    console.log(`  [DEBUG] Searching for "${materialName}", found ${count} elements`);

    if (count === 0) return null;

    const el = elements.first();
    const tag = await el.evaluate((e: Element) => e.tagName).catch(() => '?');
    console.log(`  [DEBUG] Clicking <${tag}> for "${materialName}"`);

    const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await el.scrollIntoViewIfNeeded().catch(() => undefined);

    try {
      await el.click({ timeout: 5000 });
    } catch {
      await el.click({ timeout: 5000, force: true });
    }

    await page.waitForTimeout(2000);

    const download = await downloadPromise;
    if (download) {
      const tmpPath = `/tmp/batch4-${Date.now()}-${download.suggestedFilename()}`;
      await download.saveAs(tmpPath);
      console.log(`  [DEBUG] Download intercepted: ${download.suggestedFilename()}`);
      return capturedUrls.at(-1) ?? `file://${tmpPath}`;
    }

    return capturedUrls.at(-1) ?? null;
  } finally {
    page.removeAllListeners('request');
    page.removeAllListeners('response');
  }
}

async function resolveAndDownload(page: Page, item: QueueItem): Promise<DownloadResult> {
  const targetDir = path.join(
    DOWNLOADS_DIR,
    item.courseSlug,
    cleanPathComponent(item.moduleName),
    cleanPathComponent(item.lessonName),
    'materiais'
  );
  const targetPath = path.join(targetDir, cleanPathComponent(item.assetName));

  if (await fs.pathExists(targetPath)) {
    const sha = await sha256File(targetPath).catch(() => null);
    return { courseSlug: item.courseSlug, moduleName: item.moduleName, lessonName: item.lessonName, assetName: item.assetName, status: 'skipped', localPath: targetPath, sha256: sha ?? undefined };
  }

  await fs.ensureDir(targetDir);

  const signedUrl = await clickAndCaptureUrl(page, item.assetName);

  if (!signedUrl) {
    return { courseSlug: item.courseSlug, moduleName: item.moduleName, lessonName: item.lessonName, assetName: item.assetName, status: 'failed', error: 'No signed URL captured' };
  }

  try {
    if (signedUrl.startsWith('file://')) {
      await fs.copy(signedUrl.replace('file://', ''), targetPath);
    } else {
      await fetchToFile(signedUrl, targetPath, 120_000);
    }
  } catch (e) {
    return { courseSlug: item.courseSlug, moduleName: item.moduleName, lessonName: item.lessonName, assetName: item.assetName, status: 'failed', error: `Download failed: ${e}` };
  }

  const sha = await sha256File(targetPath);
  return { courseSlug: item.courseSlug, moduleName: item.moduleName, lessonName: item.lessonName, assetName: item.assetName, status: 'downloaded', localPath: targetPath, sha256: sha, newUrl: signedUrl };
}

async function main() {
  const queue: QueueItem[] = await fs.readJson(QUEUE_PATH);
  const items = queue.filter((i) => TARGET_COURSES.includes(i.courseSlug));

  console.log(`Processing ${items.length} items`);
  for (const c of TARGET_COURSES) {
    console.log(`  ${c}: ${items.filter((i) => i.courseSlug === c).length}`);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: AUTH_STATE,
    acceptDownloads: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  console.log('Navigating to login to verify session...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (page.url().includes('/login')) {
    console.log('Session expired, logging in fresh...');
    const emailEl = page.locator('input[type="email"], input[name="email"]').first();
    const passEl = page.locator('input[type="password"]').first();
    await emailEl.fill(EMAIL);
    await passEl.fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
    await context.storageState({ path: AUTH_STATE });
    console.log('Fresh auth saved');
  }

  const audit: AuditEntry[] = [];
  let processed = 0;

  const groupedByLesson = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = item.lessonUrl;
    if (!groupedByLesson.has(key)) groupedByLesson.set(key, []);
    groupedByLesson.get(key)!.push(item);
  }

  for (const [lessonUrl, lessonItems] of groupedByLesson) {
    console.log(`\n=== Lesson: ${lessonUrl} ===`);

    await page.goto(lessonUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    const pageText = await page.evaluate(() => document.body.innerText);
    console.log(`  Page text preview: ${pageText.substring(0, 150).replace(/\n/g, ' ')}`);

    for (const item of lessonItems) {
      processed++;
      let lastResult: DownloadResult | null = null;
      let retries = 0;

      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        if (attempt > 0) {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3000);
        }

        const result = await resolveAndDownload(page, item);
        lastResult = result;

        if (result.status === 'downloaded') {
          console.log(`  [OK] ${item.assetName} -> ${path.basename(result.localPath!)}`);
          break;
        }
        retries = attempt;
        console.log(`  [FAIL attempt ${attempt + 1}] ${item.assetName}: ${result.error}`);
      }

      audit.push({
        queueItem: item,
        result: lastResult!,
        retries,
        timestamp: new Date().toISOString()
      });

      if (processed % 5 === 0) {
        await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });
        console.log(`\n--- Logged ${processed} items ---`);
      }
    }
  }

  await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });

  const d = audit.filter((a) => a.result.status === 'downloaded').length;
  const f = audit.filter((a) => a.result.status === 'failed').length;
  const s = audit.filter((a) => a.result.status === 'skipped').length;
  console.log(`\n=== Done ===\nTotal: ${audit.length} | Downloaded: ${d} | Failed: ${f} | Skipped: ${s}\nOutput: ${OUTPUT_AUDIT}`);

  await browser.close();
}

main().catch(console.error);