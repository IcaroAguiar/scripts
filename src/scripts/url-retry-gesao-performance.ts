import fs from 'fs-extra';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { waitForHydration, scrollToBottom, expandAccordions } from '../core/browser/browser';
import { sha256File } from '../core/download/hash';
import { assetNameFromUrl } from '../core/extractors/assets';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_AUDIT = 'storage/audit/url_retry_gesao_performance.json';
const COURSE_SLUG = 'gestao-de-performance-e-cultura-de-resultados';

type AssetResult = {
  courseSlug: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  status: 'downloaded' | 'failed' | 'skipped' | 'expired';
  localPath?: string;
  sha256?: string;
  error?: string;
  urlUsed?: string;
};

type AuditEntry = {
  asset: AssetResult;
  retries: number;
  timestamp: string;
};

const MAX_RETRIES = 2;

function cleanPath(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(targetPath, buf);
  } finally {
    clearTimeout(timer);
  }
}

async function clickAndCaptureUrl(
  page: Page,
  assetName: string,
  timeoutMs = 8000
): Promise<string | null> {
  const captured: string[] = [];

  const onRequest = (req: { url(): string }) => {
    const u = req.url();
    if (/cloudflarestorage\.com|\/material\//i.test(u) && /X-Amz-Signature=/i.test(u)) {
      if (!captured.includes(u)) captured.push(u);
    }
  };
  const onResponse = (res: { url(): string; status(): number }) => {
    const u = res.url();
    if (/cloudflarestorage\.com|\/material\//i.test(u) && /X-Amz-Signature=/i.test(u)) {
      if (!captured.includes(u)) captured.push(u);
    }
  };

  page.on('request', onRequest as any);
  page.on('response', onResponse as any);

  try {
    const normalized = assetName.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();

    const textMatches = [
      normalized,
      normalized.replace(/\s*-\s*/g, ' '),
      normalized.replace(/\s+/g, ''),
    ];

    let bestButton: any = null;
    let bestScore = 0;

    for (const text of textMatches) {
      const candidates = page.locator('button, a, [role="button"]').filter({ hasText: new RegExp(text, 'i') });
      const count = await candidates.count();
      if (count > 0) {
        bestButton = candidates.first();
        bestScore = text.length;
        break;
      }
    }

    if (!bestButton) {
      const allButtons = page.locator('button, a, [role="button"]');
      const count = await allButtons.count();
      for (let i = 0; i < count; i++) {
        const btn = allButtons.nth(i);
        const txt = await btn.textContent().catch(() => '');
        if (txt && txt.trim().length > 0) {
          const score = textMatches.some(t => txt.toLowerCase().includes(t.toLowerCase())) ? textMatches.find(t => txt.toLowerCase().includes(t.toLowerCase()))!.length : 0;
          if (score > bestScore) {
            bestScore = score;
            bestButton = btn;
          }
        }
      }
    }

    if (!bestButton) return null;

    const downloadPromise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);

    await bestButton.scrollIntoViewIfNeeded().catch(() => {});
    await bestButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const dl = await downloadPromise;
    if (dl) {
      const tmp = `/tmp/url-retry-${Date.now()}-${dl.suggestedFilename()}`;
      await dl.saveAs(tmp);
      return `file://${tmp}`;
    }

    return captured.at(-1) ?? null;
  } finally {
    page.off('request', onRequest as any);
    page.off('response', onResponse as any);
  }
}

async function downloadAsset(
  page: Page,
  assetName: string,
  targetDir: string
): Promise<{ path: string; sha: string; url: string } | null> {
  await fs.ensureDir(targetDir);

  const safeName = cleanPath(assetName);
  const targetPath = path.join(targetDir, safeName);

  if (await fs.pathExists(targetPath)) {
    const existingSha = await sha256File(targetPath).catch(() => null);
    if (existingSha) return { path: targetPath, sha: existingSha, url: 'already-existed' };
  }

  const signedUrl = await clickAndCaptureUrl(page, assetName);
  if (!signedUrl) return null;

  let finalPath = targetPath;

  if (signedUrl.startsWith('file://')) {
    const tmpPath = signedUrl.replace('file://', '');
    await fs.copy(tmpPath, targetPath);
    await fs.remove(tmpPath).catch(() => {});
    finalPath = targetPath;
  } else {
    try {
      await fetchToFile(signedUrl, targetPath, 120_000);
      finalPath = targetPath;
    } catch (e) {
      const altPath = targetPath + '.tmp';
      try {
        await fetchToFile(signedUrl, altPath, 120_000);
        finalPath = altPath;
      } catch {
        return null;
      }
    }
  }

  const sha = await sha256File(finalPath);
  return { path: finalPath, sha, url: signedUrl };
}

async function updateManifest(
  courseSlug: string,
  moduleName: string,
  lessonName: string,
  assetName: string,
  localPath: string,
  sha256: string,
  usedUrl: string
): Promise<void> {
  const manifestPath = path.join(MANIFESTS_DIR, `${courseSlug}.json`);
  if (!(await fs.pathExists(manifestPath))) return;

  try {
    const manifest = await fs.readJson(manifestPath);
    let updated = false;

    for (const mod of manifest.modules ?? []) {
      if (mod.name !== moduleName) continue;
      for (const lesson of mod.lessons ?? []) {
        if (lesson.name !== lessonName) continue;
        for (const asset of lesson.assets ?? []) {
          const norm = (n: string) => n.replace(/[_\s-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
          if (
            norm(asset.name) === norm(assetName) &&
            (asset.url.startsWith('unresolved://') || asset.url.startsWith('https://tm1-private'))
          ) {
            asset.localPath = localPath;
            asset.status = 'downloaded';
            asset.sha256 = sha256;
            asset.url = usedUrl;
            delete asset.lastError;
            updated = true;
          }
        }
      }
    }

    if (updated) await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  } catch {}
}

async function main() {
  const manifestPath = path.join(MANIFESTS_DIR, `${COURSE_SLUG}.json`);
  const manifest = await fs.readJson(manifestPath);

  const pendingAssets: {
    moduleName: string;
    lessonName: string;
    lessonUrl: string;
    assetName: string;
    currentUrl: string;
  }[] = [];

  for (const mod of manifest.modules ?? []) {
    for (const lesson of mod.lessons ?? []) {
      for (const asset of lesson.assets ?? []) {
        if (
          (asset.url.startsWith('https://tm1-private') || asset.url.startsWith('unresolved://')) &&
          asset.status !== 'downloaded'
        ) {
          pendingAssets.push({
            moduleName: mod.name,
            lessonName: lesson.name,
            lessonUrl: lesson.url,
            assetName: asset.name,
            currentUrl: asset.url,
          });
        }
      }
    }
  }

  console.log(`Found ${pendingAssets.length} assets to process in ${COURSE_SLUG}`);

  const groupedByLesson = new Map<string, typeof pendingAssets>();
  for (const a of pendingAssets) {
    if (!groupedByLesson.has(a.lessonUrl)) groupedByLesson.set(a.lessonUrl, []);
    groupedByLesson.get(a.lessonUrl)!.push(a);
  }

  console.log(`${groupedByLesson.size} unique lessons to visit`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  console.log('Logging in...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const loginForm = page.locator('form');
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passInput = page.locator('input[type="password"]').first();

  const emailFound = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);

  if (emailFound) {
    await emailInput.fill(EMAIL);
    await passInput.fill(PASSWORD);
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    console.log('Login form submitted');
  } else {
    console.log('Already logged in or no login form found');
  }

  const audit: AuditEntry[] = [];

  for (const [lessonUrl, assets] of groupedByLesson) {
    console.log(`\n--- Lesson: ${assets[0].lessonName} ---`);
    console.log(`URL: ${lessonUrl}`);

    try {
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await page.waitForTimeout(1500);
    } catch (e) {
      console.log(`Navigation failed: ${e}`);
      for (const a of assets) {
        audit.push({
          asset: {
            courseSlug: COURSE_SLUG,
            moduleName: a.moduleName,
            lessonName: a.lessonName,
            lessonUrl: a.lessonUrl,
            assetName: a.assetName,
            status: 'failed',
            error: `Navigation failed: ${e}`,
          },
          retries: 0,
          timestamp: new Date().toISOString(),
        });
      }
      continue;
    }

    const pageContent = await page.content();
    const hasMaterial = /material|Material|complementar|Complementar/i.test(pageContent);
    console.log(`Material section found: ${hasMaterial}`);

    for (const a of assets) {
      console.log(`\nProcessing: ${a.assetName}`);

      let lastResult: AssetResult = {
        courseSlug: COURSE_SLUG,
        moduleName: a.moduleName,
        lessonName: a.lessonName,
        lessonUrl: a.lessonUrl,
        assetName: a.assetName,
        status: 'failed',
      };

      let retries = 0;
      let success = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);
          await page.waitForTimeout(2000);
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await waitForHydration(page);
          await expandAccordions(page);
          await scrollToBottom(page);
          await page.waitForTimeout(1000);
        }

        const targetDir = path.join(
          DOWNLOADS_DIR,
          COURSE_SLUG,
          cleanPath(a.moduleName),
          cleanPath(a.lessonName),
          'materiais'
        );

        const result = await downloadAsset(page, a.assetName, targetDir);

        if (result) {
          lastResult = {
            courseSlug: COURSE_SLUG,
            moduleName: a.moduleName,
            lessonName: a.lessonName,
            lessonUrl: a.lessonUrl,
            assetName: a.assetName,
            status: 'downloaded',
            localPath: result.path,
            sha256: result.sha,
            urlUsed: result.url,
          };
          success = true;
          console.log(`  Downloaded: ${result.path}`);
          console.log(`  SHA256: ${result.sha}`);

          await updateManifest(
            COURSE_SLUG,
            a.moduleName,
            a.lessonName,
            a.assetName,
            result.path,
            result.sha,
            result.url
          );
          break;
        } else {
          lastResult.error = `Attempt ${attempt + 1}: Could not capture signed URL`;
          retries = attempt;
          console.log(`  Failed attempt ${attempt + 1}`);
        }
      }

      audit.push({ asset: lastResult, retries, timestamp: new Date().toISOString() });
      await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });
    }
  }

  await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });

  const downloaded = audit.filter((a) => a.asset.status === 'downloaded').length;
  const failed = audit.filter((a) => a.asset.status === 'failed').length;
  const skipped = audit.filter((a) => a.asset.status === 'skipped').length;
  const expired = audit.filter((a) => a.asset.status === 'expired').length;

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${audit.length}`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Expired: ${expired}`);
  console.log(`Audit: ${OUTPUT_AUDIT}`);

  await browser.close();
}

main().catch(console.error);