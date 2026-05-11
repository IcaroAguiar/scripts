import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@deepflame/storage';
import https from 'https';
import http from 'http';

const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';
const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
const OUTPUT_DIR = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/downloads/themembers-v3-retry';
const MANIFEST_DIR = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/manifests/themembers-v3-repaired';
const AUDIT_FILE = '/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/audit/url_retry_lideranca.json';

interface Asset {
  type: string;
  name: string;
  url: string;
  sha256: string | null;
  status: string;
  uploadStatus: string;
  driveFileId: string;
  localPath?: string;
}

interface Lesson {
  name: string;
  index: number;
  url: string;
  slug: string;
  description: string;
  links: string[];
  assets: Asset[];
  status: string;
}

interface Module {
  name: string;
  index: number;
  slug: string;
  lessons: Lesson[];
}

interface CourseManifest {
  platform: string;
  course: string;
  courseId: string;
  url: string;
  slug: string;
  discoveredAt: string;
  modules: Module[];
}

interface AuditResult {
  courseId: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  originalUrl: string;
  newUrl?: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  localPath?: string;
  downloadedAt: string;
}

interface AuditLog {
  startedAt: string;
  completedAt?: string;
  totalLessons: number;
  totalAssets: number;
  results: AuditResult[];
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
      if (response.statusCode === 403 || response.statusCode === 404) {
        file.close();
        fs.unlinkSync(destPath);
        resolve(false);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(true);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      resolve(false);
    });
  });
}

async function processCourse(browser: any, courseManifestPath: string, courseId: string, auditLog: AuditLog) {
  console.log(`\n=== Processing course: ${courseId} ===`);

  const manifestContent = JSON.parse(fs.readFileSync(courseManifestPath, 'utf-8')) as CourseManifest;
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login
  console.log('Logging in...');
  await page.goto(LOGIN_URL);
  await sleep(2000);

  const emailInput = await page.$('input[type="email"], input[name="email"], input[id*="email"]');
  if (emailInput) {
    await emailInput.fill(EMAIL);
    await sleep(500);
  }

  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) {
    await passwordInput.fill(PASSWORD);
    await sleep(500);
    await page.keyboard.press('Enter');
    await sleep(3000);
  }

  const allLessons = manifestContent.modules.flatMap(m => m.lessons);
  console.log(`Found ${allLessons.length} lessons`);

  for (const lesson of allLessons) {
    console.log(`\n--- Lesson ${lesson.index}: ${lesson.name} ---`);

    for (const asset of lesson.assets) {
      const isR2Url = asset.url.includes('tm1-private') || asset.url.includes('r2.cloudflarestorage');
      const isAssetsUrl = asset.url.includes('assets.themembers.com.br');

      if (!isR2Url && !isAssetsUrl) {
        console.log(`  Skipping non-URL asset: ${asset.name}`);
        auditLog.results.push({
          courseId,
          lessonName: lesson.name,
          lessonUrl: lesson.url,
          assetName: asset.name,
          originalUrl: asset.url,
          status: 'skipped',
          error: 'Not a URL-only asset (R2 or assets.themembers)',
          downloadedAt: new Date().toISOString()
        });
        continue;
      }

      console.log(`  Processing: ${asset.name}`);
      console.log(`    URL: ${asset.url}`);

      // Try to navigate to lesson and get fresh URL
      let freshUrl: string | null = null;
      let downloadSuccess = false;

      try {
        await page.goto(lesson.url, { timeout: 15000 });
        await sleep(3000);

        // Look for material section with download button
        const materialSelectors = [
          'a[href*=".pdf"]',
          'button[class*="material"]',
          'a[class*="download"]',
          '[class*="material"] a',
          '[class*="resource"] a',
          'a[href*="material"]',
          '[data-testid*="material"]'
        ];

        for (const selector of materialSelectors) {
          const elements = await page.$$(selector);
          for (const el of elements) {
            const href = await el.getAttribute('href');
            if (href && (href.includes('.pdf') || href.includes('material') || href.includes('download'))) {
              freshUrl = href.startsWith('http') ? href : new URL(href, lesson.url).toString();
              break;
            }
          }
          if (freshUrl) break;
        }

        // Try clicking on "Material" or "Baixar" buttons
        if (!freshUrl) {
          const materialButtons = await page.$$('button');
          for (const btn of materialButtons) {
            const text = await btn.textContent();
            if (text && (text.toLowerCase().includes('material') || text.toLowerCase().includes('baixar') || text.toLowerCase().includes('download'))) {
              await btn.click();
              await sleep(2000);
              const newHref = await btn.getAttribute('href') || await page.evaluate(() => {
                const btn = document.querySelector('button:hover, button:focus');
                return btn?.closest('a')?.href;
              });
              if (newHref) {
                freshUrl = newHref;
                break;
              }
            }
          }
        }

        // Use original URL if no fresh URL found
        freshUrl = freshUrl || asset.url;

        // Create destination folder
        const courseFolder = path.join(OUTPUT_DIR, courseId);
        if (!fs.existsSync(courseFolder)) {
          fs.mkdirSync(courseFolder, { recursive: true });
        }

        // Get driveFileId for subfolder
        const drivePath = asset.driveFileId || '';
        const pathParts = drivePath.split('/');
        let lessonFolder = courseFolder;
        if (pathParts.length > 2) {
          const moduleLessonPath = pathParts.slice(-2).join('/').replace(/"/g, '');
          lessonFolder = path.join(courseFolder, path.dirname(moduleLessonPath));
          if (!fs.existsSync(lessonFolder)) {
            fs.mkdirSync(lessonFolder, { recursive: true });
          }
        }

        const destPath = path.join(lessonFolder, asset.name);

        console.log(`    Downloading to: ${destPath}`);
        console.log(`    Using URL: ${freshUrl}`);

        downloadSuccess = await downloadFile(freshUrl, destPath);

        if (downloadSuccess) {
          console.log(`    SUCCESS: Downloaded ${asset.name}`);
          asset.status = 'downloaded';
          asset.localPath = destPath;

          auditLog.results.push({
            courseId,
            lessonName: lesson.name,
            lessonUrl: lesson.url,
            assetName: asset.name,
            originalUrl: asset.url,
            newUrl: freshUrl,
            status: 'success',
            localPath: destPath,
            downloadedAt: new Date().toISOString()
          });
        } else {
          console.log(`    FAILED: Could not download ${asset.name}`);
          auditLog.results.push({
            courseId,
            lessonName: lesson.name,
            lessonUrl: lesson.url,
            assetName: asset.name,
            originalUrl: asset.url,
            status: 'failed',
            error: 'Download failed (403/404 or network error)',
            downloadedAt: new Date().toISOString()
          });
        }

      } catch (err: any) {
        console.log(`    ERROR: ${err.message}`);
        auditLog.results.push({
          courseId,
          lessonName: lesson.name,
          lessonUrl: lesson.url,
          assetName: asset.name,
          originalUrl: asset.url,
          status: 'failed',
          error: err.message,
          downloadedAt: new Date().toISOString()
        });
      }

      await sleep(1000);
    }
  }

  // Save updated manifest
  fs.writeFileSync(courseManifestPath, JSON.stringify(manifestContent, null, 2));
  console.log(`\nSaved updated manifest: ${courseManifestPath}`);

  await context.close();
}

async function main() {
  const auditLog: AuditLog = {
    startedAt: new Date().toISOString(),
    totalLessons: 0,
    totalAssets: 0,
    results: []
  };

  const courses = [
    {
      manifestPath: path.join(MANIFEST_DIR, 'lideranca-visionaria-e-estrategia-de-futuro.json'),
      courseId: 'lideranca-visionaria-e-estrategia-de-futuro'
    },
    {
      manifestPath: path.join(MANIFEST_DIR, 'lideranca-visionaria-e-estrategia-de-futuro-formacao.json'),
      courseId: 'lideranca-visionaria-e-estrategia-de-futuro-formacao'
    }
  ];

  console.log('Starting URL retry for lideranca courses...');
  console.log(`Output directory: ${OUTPUT_DIR}`);

  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Ensure audit dir exists
  const auditDir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: false });

  for (const course of courses) {
    auditLog.totalLessons++;
    const manifest: CourseManifest = JSON.parse(fs.readFileSync(course.manifestPath, 'utf-8'));
    auditLog.totalAssets += manifest.modules.flatMap(m => m.lessons).flatMap(l => l.assets).length;
    await processCourse(browser, course.manifestPath, course.courseId, auditLog);
  }

  await browser.close();

  auditLog.completedAt = new Date().toISOString();

  // Save audit log
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditLog, null, 2));
  console.log(`\n=== Audit log saved to: ${AUDIT_FILE} ===`);
  console.log(`Total results: ${auditLog.results.length}`);

  const successCount = auditLog.results.filter(r => r.status === 'success').length;
  const failedCount = auditLog.results.filter(r => r.status === 'failed').length;
  const skippedCount = auditLog.results.filter(r => r.status === 'skipped').length;

  console.log(`Success: ${successCount}, Failed: ${failedCount}, Skipped: ${skippedCount}`);
}

main().catch(console.error);