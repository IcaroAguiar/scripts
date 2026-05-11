import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const OUTPUT_BASE = 'storage/releases/themembers-v3-repaired/cursos';

async function main() {
  console.log('=== Fresh URL Downloader (Headless + Curl) ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: false
  });
  const page = await context.newPage();

  const freshMaterialsByLessonUrl: Record<string, Array<{name: string; url: string}>> = {};
  let lessonsVisited = 0;
  let lessonsWithMaterials = 0;

  // Intercept API responses to capture fresh material URLs
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/auth/home/materials/')) {
      try {
        const data = await res.json();
        if (data && Array.isArray(data) && data.length > 0) {
          const currentUrl = page.url();
          if (!freshMaterialsByLessonUrl[currentUrl]) {
            freshMaterialsByLessonUrl[currentUrl] = [];
            lessonsWithMaterials++;
          }
          for (const m of data) {
            if (!freshMaterialsByLessonUrl[currentUrl].find(x => x.name === m.material_name)) {
              freshMaterialsByLessonUrl[currentUrl].push({
                name: m.material_name,
                url: m.material_url
              });
            }
          }
        }
      } catch {}
    }
  });

  // Load all manifests and collect all lesson URLs
  const allLessonUrls: Array<{course: string; lessonName: string; lessonUrl: string}> = [];

  const manifestFiles = fs.readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json'));

  for (const mf of manifestFiles) {
    const courseSlug = mf.replace('.json', '');
    const manifest = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, mf), 'utf8'));

    for (const mod of (manifest.modules || [])) {
      for (const lesson of (mod.lessons || [])) {
        if (lesson.url && !allLessonUrls.find(l => l.lessonUrl === lesson.url)) {
          allLessonUrls.push({
            course: courseSlug,
            lessonName: lesson.name,
            lessonUrl: lesson.url
          });
        }
      }
    }
  }

  console.log(`Total unique lesson pages: ${allLessonUrls.length}\n`);

  // Visit each lesson page to capture fresh material URLs
  for (const { course, lessonName, lessonUrl } of allLessonUrls) {
    try {
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
      lessonsVisited++;

      if (lessonsVisited % 25 === 0) {
        const captured = Object.keys(freshMaterialsByLessonUrl).length;
        console.log(`Progress: ${lessonsVisited}/${allLessonUrls.length} lessons | ${captured} with materials captured`);
      }
    } catch(e) {
      console.log(`Failed: ${lessonUrl.substring(0,70)} - ${e.message.substring(0,60)}`);
    }
  }

  console.log(`\nVisited ${lessonsVisited} lessons`);
  console.log(`Captured fresh URLs from ${lessonsWithMaterials} lessons`);
  console.log(`Total materials captured: ${Object.values(freshMaterialsByLessonUrl).reduce((s, a) => s + a.length, 0)}`);

  // Download fresh materials with curl
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;
  let alreadyExists = 0;

  for (const [lessonUrl, materials] of Object.entries(freshMaterialsByLessonUrl)) {
    const info = allLessonUrls.find(l => l.lessonUrl === lessonUrl);
    if (!info) continue;

    const courseDir = path.join(OUTPUT_BASE, info.course);
    fs.ensureDirSync(courseDir);

    for (const mat of materials) {
      if (!mat.url || mat.url.trim() === '') {
        skipped++;
        continue;
      }

      const safeName = mat.name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      const destPath = path.join(courseDir, safeName);

      // Skip if already exists with good size
      if (fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        if (stats.size > 5000) {
          alreadyExists++;
          continue;
        }
      }

      // Download with curl
      try {
        execSync(`curl -sL "${mat.url}" -o "${destPath}"`, { timeout: 90000 });
        const stats = fs.statSync(destPath);

        if (stats.size > 5000) {
          downloaded++;
          const sizeMB = Math.round(stats.size / 1024 / 10) / 100;
          console.log(`OK ${downloaded}: ${mat.name} (${sizeMB}MB) -> ${info.course}`);
        } else {
          failed++;
          console.log(`SMALL ${failed}: ${mat.name} (${stats.size}B) - removing`);
          try { fs.unlinkSync(destPath); } catch {}
        }
      } catch(e) {
        failed++;
        console.log(`FAIL ${failed}: ${mat.name} - ${e.message.substring(0,80)}`);
        try { fs.unlinkSync(destPath); } catch {}
      }
    }
  }

  console.log(`\n=== Download Results ===`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Already existed: ${alreadyExists}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped (no URL): ${skipped}`);

  const total = downloaded + alreadyExists;
  console.log(`\nTotal usable: ${total} materials`);

  fs.writeFileSync('storage/audit/fresh_url_download_results.json', JSON.stringify({
    downloaded,
    alreadyExists,
    failed,
    skipped,
    lessonsVisited,
    lessonsWithMaterials,
    totalMaterials: total,
    timestamp: new Date().toISOString()
  }, null, 2));

  await browser.close();
}

main().catch(console.error);