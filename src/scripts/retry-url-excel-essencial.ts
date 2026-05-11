import fs from 'fs-extra';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Logger } from '../core/logger/logger';
import { sha256File } from '../core/download/hash';
import { assetTargetPath, writeLessonFiles } from '../core/filesystem/lesson-writer';
import type { CourseManifest } from '../core/types';
import { cleanName } from '../core/utils/slug';

const AUTH_PATH = 'storage/auth/themembers-retry-excel-essencial.json';
const LOGS_DIR = 'storage/logs';
const DOWNLOADS_DIR = 'storage/downloads';
const MANIFEST_REPAIRED = 'storage/manifests/themembers-v3-repaired/excel-essencial.json';
const AUDIT_OUTPUT = 'storage/audit/url_retry_excel_essencial.json';
const LOGS_RETRY_DIR = 'storage/logs/retry-excel-essencial';

const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';

const BASE_URL = 'https://alunos.tetraeducacao.com.br';

interface AuditEntry {
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  assetType: string;
  oldUrl: string;
  newUrl: string | null;
  status: 'success' | 'failed' | 'skipped' | 'refreshed';
  localPath: string | null;
  error: string | null;
  timestamp: string;
}

const audit: AuditEntry[] = [];

function isR2Url(url: string): boolean {
  return /cloudflarestorage\.com|\/material\//i.test(url);
}

function isSignedR2Url(url: string): boolean {
  return /cloudflarestorage\.com/i.test(url) && /X-Amz-Signature=/i.test(url);
}

function redactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = parsed.search ? '?[redacted]' : '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

async function fetchToFile(url: string, targetPath: string, timeoutMs = 120_000): Promise<void> {
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

async function login(context: BrowserContext, page: Page, logger: Logger): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);

  const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i], input[id*="email" i]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="senha" i], input[id*="password" i]').first();

  const emailCount = await emailInput.count();
  const passwordCount = await passwordInput.count();

  if (emailCount > 0 && passwordCount > 0) {
    await emailInput.fill(EMAIL);
    await passwordInput.fill(PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar")').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await logger.log('LOGIN', 'form submitted and logged in');
  } else {
    const pageText = await page.evaluate(() => document.body.innerText);
    logger.log('LOGIN', `already logged in or form not found. Body preview: ${pageText.substring(0, 200)}`);
  }

  await context.storageState({ path: AUTH_PATH });
  await logger.log('LOGIN', `storage state saved to ${AUTH_PATH}`);
}

async function resolveR2Url(page: Page, materialName: string, lessonUrl: string, logger: Logger): Promise<string | null> {
  const capturedUrls: string[] = [];

  const onRequest = (request: { url(): string }) => {
    const url = request.url();
    if (isSignedR2Url(url) && !capturedUrls.includes(url)) {
      capturedUrls.push(url);
    }
  };
  const onResponse = (response: { url(): string }) => {
    const url = response.url();
    if (isSignedR2Url(url) && !capturedUrls.includes(url)) {
      capturedUrls.push(url);
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    // Try multiple click strategies
    const strategies = [
      { selector: `a:has-text("${materialName}"), button:has-text("${materialName}"), [data-material*="${encodeURIComponent(materialName)}"]`, label: 'exact text' },
      { selector: `text="${materialName}"`, label: 'contains text' },
      { selector: `a[href*="material"], button[class*="material"], [class*="material-btn"]`, label: 'material class' },
    ];

    let clicked = false;
    for (const strategy of strategies) {
      const elements = page.locator(strategy.selector);
      const count = await elements.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const el = elements.nth(i);
        const text = await el.innerText().catch(() => '');
        if (text.toLowerCase().includes(materialName.toLowerCase().substring(0, 10)) || text === '') {
          try {
            await el.scrollIntoViewIfNeeded();
            const downloadPromise = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
            await el.click({ timeout: 5_000 });
            await page.waitForTimeout(1_500);
            const download = await downloadPromise;
            if (download || capturedUrls.length > 0) {
              clicked = true;
              logger.log('CLICK', `strategy "${strategy.label}" worked for ${materialName}`);
              break;
            }
          } catch {}
        }
      }
      if (clicked) break;
    }

    // Also try the materials section button directly
    if (!clicked) {
      const matButtons = page.locator('[class*="material"], [class*="anexo"], [class*="download"], button:has-text("Material"), button:has-text("Baixar"), button:has-text("Download")');
      const count = await matButtons.count();
      for (let i = 0; i < Math.min(count, 10); i++) {
        try {
          const btn = matButtons.nth(i);
          await btn.scrollIntoViewIfNeeded();
          const downloadPromise = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
          await btn.click({ timeout: 5_000 });
          await page.waitForTimeout(1_500);
          if (capturedUrls.length > 0) {
            clicked = true;
            logger.log('CLICK', `material section button worked for ${materialName}`);
            break;
          }
        } catch {}
      }
    }

    const signedUrl = capturedUrls.at(-1);
    return signedUrl || null;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadAsset(url: string, targetPath: string, assetName: string, logger: Logger, retries = 2): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fetchToFile(url, targetPath);
      const hash = await sha256File(targetPath);
      logger.log('DOWNLOAD', `success ${path.basename(targetPath)} (${hash.substring(0, 8)})`);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.log(attempt < retries ? 'RETRY' : 'FAILED', `${assetName} attempt ${attempt + 1} failed: ${err}`);
      if (attempt < retries) await sleep(2_000 * (attempt + 1));
    }
  }
  return false;
}

async function processLesson(
  browser: Browser,
  context: BrowserContext,
  manifest: CourseManifest,
  modIndex: number,
  lesson: { name: string; index: number; url: string; assets: any[] },
  logger: Logger
): Promise<void> {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

try {
    // Set up R2 URL capture BEFORE navigation
    const capturedR2Urls: string[] = [];
    const pageForCapture = page;

    const captureR2Request = (request: { url(): string }) => {
      const url = request.url();
      if (isSignedR2Url(url) && !capturedR2Urls.includes(url)) {
        capturedR2Urls.push(url);
        logger.log('CAPTURED_R2', `request: ${redactedUrl(url)}`);
      }
    };
    const captureR2Response = (response: { url(): string }) => {
      const url = response.url();
      if (isSignedR2Url(url) && !capturedR2Urls.includes(url)) {
        capturedR2Urls.push(url);
        logger.log('CAPTURED_R2', `response: ${redactedUrl(url)}`);
      }
    };

    page.on('request', captureR2Request);
    page.on('response', captureR2Response);

    logger.log('NAVIGATE', `going to lesson: ${lesson.name}`);
    await page.goto(lesson.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);

    logger.log('PAGE_DEBUG', `${capturedR2Urls.length} R2 URLs captured on page load`);

    // Expand any accordions
    const accordions = page.locator('button, [role="button"], summary, [aria-expanded="false"]');
    const accCount = Math.min(await accordions.count(), 20);
    for (let i = 0; i < accCount; i++) {
      try {
        const btn = accordions.nth(i);
        const expanded = await btn.getAttribute('aria-expanded').catch(() => null);
        if (expanded === 'false') await btn.click({ timeout: 500 }).catch(() => undefined);
      } catch {}
    }
    await page.waitForTimeout(1_000);

    const mod = manifest.modules[modIndex];
    for (const asset of lesson.assets) {
      logger.log('ASSET_DEBUG', `processing asset: ${asset.name} type=${asset.type} url=${redactedUrl(asset.url)} status=${asset.status}`);

      if (asset.type === 'external-link') {
        audit.push({
          lessonName: lesson.name,
          lessonUrl: lesson.url,
          assetName: asset.name,
          assetType: asset.type,
          oldUrl: asset.url,
          newUrl: null,
          status: 'skipped',
          localPath: null,
          error: 'external link',
          timestamp: new Date().toISOString()
        });
        continue;
      }

      // If we already have a fresh R2 URL from page load, use it
      let effectiveUrl = asset.url;

      if (asset.url.startsWith('unresolved://') || isR2Url(asset.url)) {
        logger.log('RESOLVE', `trying to refresh URL for: ${asset.name}`);
        const newUrl = await resolveR2Url(page, asset.name, lesson.url, logger);
        if (newUrl) {
          effectiveUrl = newUrl;
          audit.push({
            lessonName: lesson.name,
            lessonUrl: lesson.url,
            assetName: asset.name,
            assetType: asset.type,
            oldUrl: asset.url,
            newUrl,
            status: 'refreshed',
            localPath: null,
            error: null,
            timestamp: new Date().toISOString()
          });
        } else {
          // Check if any captured R2 URL matches this asset
          const matched = capturedR2Urls.find(u => {
            const ext = u.split('?')[0].split('.').pop()?.toLowerCase();
            const assetExt = asset.name.split('.').pop()?.toLowerCase();
            return ext === assetExt || u.includes(encodeURIComponent(asset.name)) || u.includes(asset.name.replace(/[^a-zA-Z0-9]/g, ''));
          });
          if (matched) {
            effectiveUrl = matched;
            logger.log('RESOLVED_FROM_CAPTURE', `${asset.name} matched captured URL`);
            audit.push({
              lessonName: lesson.name,
              lessonUrl: lesson.url,
              assetName: asset.name,
              assetType: asset.type,
              oldUrl: asset.url,
              newUrl: matched,
              status: 'refreshed',
              localPath: null,
              error: null,
              timestamp: new Date().toISOString()
            });
          } else if (asset.url.startsWith('unresolved://')) {
            audit.push({
              lessonName: lesson.name,
              lessonUrl: lesson.url,
              assetName: asset.name,
              assetType: asset.type,
              oldUrl: asset.url,
              newUrl: null,
              status: 'failed',
              localPath: null,
              error: 'Could not resolve URL via click or capture',
              timestamp: new Date().toISOString()
            });
            continue;
          }
        }
      }

      // Download
      const bucket = asset.type === 'audio' ? 'audios' : 'materiais';
      const targetPath = assetTargetPath(DOWNLOADS_DIR, manifest, mod, lesson, cleanName(asset.name), bucket);
      asset.targetPath = targetPath;
      asset.localPath = targetPath;

      const existing = await fs.pathExists(targetPath);
      if (existing) {
        const hash = await sha256File(targetPath);
        asset.sha256 = hash;
        asset.status = 'downloaded';
        logger.log('SKIPPED', `${asset.name} already exists`);
        audit.push({
          lessonName: lesson.name,
          lessonUrl: lesson.url,
          assetName: asset.name,
          assetType: asset.type,
          oldUrl: asset.url,
          newUrl: asset.url,
          status: 'skipped',
          localPath: targetPath,
          error: null,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      await fs.ensureDir(path.dirname(targetPath));

      const success = await downloadAsset(effectiveUrl, targetPath, asset.name, logger);
      if (success) {
        const hash = await sha256File(targetPath);
        asset.sha256 = hash;
        asset.status = 'downloaded';
        asset.localPath = targetPath;
        audit.push({
          lessonName: lesson.name,
          lessonUrl: lesson.url,
          assetName: asset.name,
          assetType: asset.type,
          oldUrl: asset.url,
          newUrl: effectiveUrl,
          status: 'success',
          localPath: targetPath,
          error: null,
          timestamp: new Date().toISOString()
        });
      } else {
        asset.status = 'failed';
        asset.lastError = 'Download failed after retries';
        audit.push({
          lessonName: lesson.name,
          lessonUrl: lesson.url,
          assetName: asset.name,
          assetType: asset.type,
          oldUrl: asset.url,
          newUrl: effectiveUrl,
          status: 'failed',
          localPath: null,
          error: 'Download failed after retries',
          timestamp: new Date().toISOString()
        });
      }
    }

    // Write lesson metadata
    await writeLessonFiles(DOWNLOADS_DIR, manifest, mod, lesson);

  } finally {
    await page.close();
  }
}

async function main() {
  await fs.ensureDir(LOGS_RETRY_DIR);
  await fs.ensureDir(AUDIT_OUTPUT.replace(/[^/]+$/, ''));
  const logger = new Logger(LOGS_RETRY_DIR);

  logger.log('START', '=== URL Retry for excel-essencial ===');

  const manifest: CourseManifest = await fs.readJson(MANIFEST_REPAIRED);

  const browser = await chromium.launch({ headless: false });
  const hasAuth = await fs.pathExists(AUTH_PATH);
  const context = await browser.newContext({
    ...(hasAuth ? { storageState: AUTH_PATH } : {}),
    acceptDownloads: true
  });

  const page = await context.newPage();

  if (!hasAuth) {
    await login(context, page, logger);
  } else {
    logger.log('AUTH', `using existing auth state from ${AUTH_PATH}`);
    // Verify auth still valid
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const pageText = await page.evaluate(() => document.body.innerText);
    if (pageText.includes('login') || pageText.includes('Login')) {
      logger.log('AUTH', 'session expired, re-logging in');
      await login(context, page, logger);
    } else {
      logger.log('AUTH', 'existing session valid');
    }
  }
  await page.close();

  // Count pending assets
  let totalPending = 0;
  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons) {
      for (const asset of lesson.assets) {
        if (asset.status === 'pending' || asset.status === 'failed' || isR2Url(asset.url)) {
          totalPending++;
        }
      }
    }
  }
  logger.log('STATS', `total assets needing download/refresh: ${totalPending}`);

  for (let modIdx = 0; modIdx < manifest.modules.length; modIdx++) {
    const mod = manifest.modules[modIdx];
    for (const lesson of mod.lessons) {
      await processLesson(browser, context, manifest, modIdx, lesson, logger);
    }
  }

  // Save updated manifest
  await fs.writeJson(MANIFEST_REPAIRED, manifest, { spaces: 2 });
  logger.log('MANIFEST', `updated manifest saved`);

  // Save audit
  const successCount = audit.filter(a => a.status === 'success').length;
  const failedCount = audit.filter(a => a.status === 'failed').length;
  const refreshedCount = audit.filter(a => a.status === 'refreshed').length;
  const skippedCount = audit.filter(a => a.status === 'skipped').length;

  const auditReport = {
    course: 'excel-essencial',
    timestamp: new Date().toISOString(),
    summary: {
      total: audit.length,
      success: successCount,
      failed: failedCount,
      refreshed: refreshedCount,
      skipped: skippedCount
    },
    entries: audit
  };

  await fs.writeJson(AUDIT_OUTPUT, auditReport, { spaces: 2 });
  logger.log('AUDIT', `saved to ${AUDIT_OUTPUT}`);
  logger.log('COMPLETE', `success=${successCount}, failed=${failedCount}, refreshed=${refreshedCount}, skipped=${skippedCount}`);

  await browser.close();
}

main().catch(console.error);