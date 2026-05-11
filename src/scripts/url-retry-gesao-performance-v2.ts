import fs from 'fs-extra';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { waitForHydration, scrollToBottom, expandAccordions } from '../core/browser/browser';
import { sha256File } from '../core/download/hash';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_AUDIT = 'storage/audit/url_retry_gesao_performance.json';
const COURSE_SLUG = 'gestao-de-performance-e-cultura-de-resultados';
const LESSON_URLS = [
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-1-cultura-de-alta-perfomance-e-accountability1374628510/43e3b618-fdad-4c36-9eeb-558b8ca44d89',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-2-ciclos-de-performance-e-cultura-de-alta-responsabilidade651751721/f46f0170-7d58-4a7e-9896-c0d8a7326c99',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-3-avaliacao-de-performance-e-comites-de-talento260171567/02825f5d-fa43-47ba-94a4-5db8b0a0a025',
  'https://alunos.tetraeducacao.com.br/curso/4393/aula-4-engajamento-e-reconhecimento-estrategico1192595046/28af1ce4-c4ec-4189-b039-65411e5e85c0',
];

type AssetResult = {
  courseSlug: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  status: 'downloaded' | 'failed';
  localPath?: string;
  sha256?: string;
  error?: string;
  urlUsed?: string;
};

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

function normalizeText(t: string): string {
  return t.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function clickMaterialAndCaptureUrl(page: Page, targetName: string): Promise<string | null> {
  const captured: string[] = [];

  const onRequest = (req: { url(): string }) => {
    const u = req.url();
    if (/cloudflarestorage\.com|\/material\//i.test(u) && /X-Amz-Signature=/i.test(u)) {
      if (!captured.includes(u)) captured.push(u);
    }
  };
  const onResponse = (res: { url(): string }) => {
    const u = res.url();
    if (/cloudflarestorage\.com|\/material\//i.test(u) && /X-Amz-Signature=/i.test(u)) {
      if (!captured.includes(u)) captured.push(u);
    }
  };

  page.on('request', onRequest as any);
  page.on('response', onResponse as any);

  try {
    const normalized = normalizeText(targetName);
    const keywords = normalized.split(' ').filter(k => k.length > 3);

    let bestButton: any = null;
    let bestMatch = '';

    const buttons = page.locator('button, a, [role="button"], [class*="material"], [class*="download"], [class*="file"]');
    const count = await buttons.count();

    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const text = await btn.textContent().catch(() => '');
      const lower = normalizeText(text);

      const matchScore = keywords.filter(k => lower.includes(k)).length;
      if (matchScore > bestMatch.length) {
        bestMatch = keywords.filter(k => lower.includes(k)).join(' ');
        bestButton = btn;
      }

      if (matchScore >= Math.ceil(keywords.length * 0.6)) {
        bestButton = btn;
        bestMatch = keywords.filter(k => lower.includes(k)).join(' ');
        break;
      }
    }

    if (!bestButton) {
      const allLinks = page.locator('a[href*="cloudflarestorage"], a[href*="/material/"]');
      const linkCount = await allLinks.count();
      for (let i = 0; i < linkCount; i++) {
        const link = allLinks.nth(i);
        const text = await link.textContent().catch(() => '');
        const lower = normalizeText(text);
        const matchScore = keywords.filter(k => lower.includes(k)).length;
        if (matchScore > bestMatch.length) {
          bestMatch = keywords.filter(k => lower.includes(k)).join(' ');
          bestButton = link;
        }
      }
    }

    if (!bestButton) {
      const materialSection = page.locator('text=/material/i').first();
      const hasMaterial = await materialSection.isVisible({ timeout: 2000 }).catch(() => false);
      if (hasMaterial) {
        const sibling = materialSection.locator('..').locator('button, a').first();
        const siblingCount = await sibling.count();
        if (siblingCount > 0) bestButton = sibling;
      }
    }

    if (!bestButton) return null;

    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);

    await bestButton.scrollIntoViewIfNeeded().catch(() => {});
    await bestButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const dl = await downloadPromise;
    if (dl) {
      const tmp = `/tmp/retry-gp-${Date.now()}-${dl.suggestedFilename()}`;
      await dl.saveAs(tmp);
      return `file://${tmp}`;
    }

    return captured.at(-1) ?? null;
  } finally {
    page.off('request', onRequest as any);
    page.off('response', onResponse as any);
  }
}

async function downloadWithRetry(
  page: Page,
  assetName: string,
  targetDir: string,
  maxRetries = 2
): Promise<{ path: string; sha: string; url: string } | null> {
  await fs.ensureDir(targetDir);
  const safeName = cleanPath(assetName);
  const targetPath = path.join(targetDir, safeName);

  if (await fs.pathExists(targetPath)) {
    const sha = await sha256File(targetPath).catch(() => null);
    if (sha) return { path: targetPath, sha, url: 'already-existed' };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForHydration(page);
      await expandAccordions(page);
      await scrollToBottom(page);
      await page.waitForTimeout(1000);
    }

    const signedUrl = await clickMaterialAndCaptureUrl(page, assetName);
    if (!signedUrl) {
      console.log(`  Attempt ${attempt + 1}: no URL captured`);
      continue;
    }

    try {
      if (signedUrl.startsWith('file://')) {
        const tmpPath = signedUrl.replace('file://', '');
        await fs.copy(tmpPath, targetPath);
        await fs.remove(tmpPath).catch(() => {});
      } else {
        await fetchToFile(signedUrl, targetPath, 120_000);
      }
      const sha = await sha256File(targetPath);
      return { path: targetPath, sha, url: signedUrl };
    } catch (e) {
      console.log(`  Attempt ${attempt + 1}: download failed - ${e}`);
      await fs.remove(targetPath).catch(() => {});
    }
  }

  return null;
}

async function updateManifest(
  moduleName: string,
  lessonName: string,
  assetName: string,
  localPath: string,
  sha256: string,
  usedUrl: string
): Promise<void> {
  const manifestPath = path.join(MANIFESTS_DIR, `${COURSE_SLUG}.json`);
  if (!(await fs.pathExists(manifestPath))) return;

  try {
    const manifest = await fs.readJson(manifestPath);
    let updated = false;

    for (const mod of manifest.modules ?? []) {
      for (const lesson of mod.lessons ?? []) {
        for (const asset of lesson.assets ?? []) {
          const norm = (n: string) => normalizeText(n);
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

async function processLesson(
  browser: any,
  lessonUrl: string,
  assets: { moduleName: string; lessonName: string; assetName: string; currentUrl: string }[]
): Promise<AssetResult[]> {
  const results: AssetResult[] = [];
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  try {
    console.log(`\nNavigating to lesson...`);
    await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForHydration(page);
    await expandAccordions(page);
    await scrollToBottom(page);
    await page.waitForTimeout(2000);

    const title = await page.title();
    console.log(`  Page title: ${title}`);

    const pageText = await page.textContent('body');
    const hasMaterial = /material|complementar|Material/i.test(pageText);
    console.log(`  Material section detected: ${hasMaterial}`);

    for (const asset of assets) {
      console.log(`\n  Processing: ${asset.assetName}`);

      const targetDir = path.join(
        DOWNLOADS_DIR,
        COURSE_SLUG,
        cleanPath(asset.moduleName),
        cleanPath(asset.lessonName),
        'materiais'
      );

      const result = await downloadWithRetry(page, asset.assetName, targetDir);

      if (result) {
        console.log(`  Downloaded: ${result.path}`);
        console.log(`  SHA256: ${result.sha}`);

        await updateManifest(
          asset.moduleName,
          asset.lessonName,
          asset.assetName,
          result.path,
          result.sha,
          result.url
        );

        results.push({
          courseSlug: COURSE_SLUG,
          moduleName: asset.moduleName,
          lessonName: asset.lessonName,
          lessonUrl,
          assetName: asset.assetName,
          status: 'downloaded',
          localPath: result.path,
          sha256: result.sha,
          urlUsed: result.url,
        });
      } else {
        console.log(`  FAILED: all retry attempts exhausted`);
        results.push({
          courseSlug: COURSE_SLUG,
          moduleName: asset.moduleName,
          lessonName: asset.lessonName,
          lessonUrl,
          assetName: asset.assetName,
          status: 'failed',
          error: 'All retry attempts exhausted',
        });
      }
    }
  } catch (e) {
    console.log(`Lesson navigation failed: ${e}`);
    for (const asset of assets) {
      results.push({
        courseSlug: COURSE_SLUG,
        moduleName: asset.moduleName,
        lessonName: asset.lessonName,
        lessonUrl,
        assetName: asset.assetName,
        status: 'failed',
        error: `Navigation failed: ${e}`,
      });
    }
  } finally {
    await context.close();
  }

  return results;
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

  console.log(`Total pending assets: ${pendingAssets.length}`);

  const groupedByLesson = new Map<string, typeof pendingAssets>();
  for (const a of pendingAssets) {
    if (!groupedByLesson.has(a.lessonUrl)) groupedByLesson.set(a.lessonUrl, []);
    groupedByLesson.get(a.lessonUrl)!.push(a);
  }

  console.log(`Lessons to process: ${groupedByLesson.size}`);

  const browser = await chromium.launch({ headless: false });

  const allResults: AssetResult[] = [];

  for (const lessonUrl of LESSON_URLS) {
    const assets = groupedByLesson.get(lessonUrl) ?? [];
    if (assets.length === 0) {
      console.log(`\nNo pending assets for: ${lessonUrl}`);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing lesson: ${assets[0].lessonName}`);
    console.log(`Assets: ${assets.map(a => a.assetName).join(', ')}`);

    const results = await processLesson(browser, lessonUrl, assets);
    allResults.push(...results);

    await fs.writeJson(OUTPUT_AUDIT, allResults, { spaces: 2 });
  }

  await browser.close();

  await fs.writeJson(OUTPUT_AUDIT, allResults, { spaces: 2 });

  const downloaded = allResults.filter(r => r.status === 'downloaded').length;
  const failed = allResults.filter(r => r.status === 'failed').length;

  console.log(`\n=== Final Summary ===`);
  console.log(`Total processed: ${allResults.length}`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Audit: ${OUTPUT_AUDIT}`);
}

main().catch(console.error);