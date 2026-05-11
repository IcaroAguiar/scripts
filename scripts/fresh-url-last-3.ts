import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';
const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const OUTPUT_BASE = 'storage/releases/themembers-v3-repaired/cursos';
const TARGET_COURSES = [
  'canva',
  'lideranca-visionaria-e-estrategia-de-futuro-formacao',
  'lideranca-visionaria-e-estrategia-de-futuro'
];

async function main() {
  console.log('=== Fresh URL - Last 3 Courses ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    acceptDownloads: false
  });
  const page = await context.newPage();

  const freshMaterialsByLessonUrl: Record<string, Array<{name: string; url: string}>> = {};
  let lessonsVisited = 0;
  let lessonsWithMaterials = 0;

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

  const allLessonUrls: Array<{course: string; lessonName: string; lessonUrl: string; moduleName: string}> = [];

  for (const courseSlug of TARGET_COURSES) {
    const mfPath = path.join(MANIFESTS_DIR, courseSlug + '.json');
    if (!fs.existsSync(mfPath)) { console.log('No manifest: ' + courseSlug); continue; }

    const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    for (const mod of (manifest.modules || [])) {
      for (const lesson of (mod.lessons || [])) {
        if (lesson.url && !allLessonUrls.find(l => l.lessonUrl === lesson.url)) {
          allLessonUrls.push({
            course: courseSlug,
            moduleName: mod.name,
            lessonName: lesson.name,
            lessonUrl: lesson.url
          });
        }
      }
    }
  }

  console.log(`Target: ${TARGET_COURSES.join(', ')}`);
  console.log(`Lessons to visit: ${allLessonUrls.length}\n`);

  for (const { course, lessonName, lessonUrl } of allLessonUrls) {
    try {
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
      lessonsVisited++;
      if (lessonsVisited % 10 === 0) {
        console.log(`Progress: ${lessonsVisited}/${allLessonUrls.length} | captured: ${Object.keys(freshMaterialsByLessonUrl).length}`);
      }
    } catch(e) {
      console.log(`Failed: ${lessonUrl.substring(0,60)} - ${e.message.substring(0,40)}`);
    }
  }

  console.log(`\nVisited: ${lessonsVisited} | Captured: ${Object.keys(freshMaterialsByLessonUrl).length} lessons with materials`);
  console.log(`Total materials: ${Object.values(freshMaterialsByLessonUrl).reduce((s,a)=>s+a.length,0)}`);

  // Now download each material into proper module/lesson structure
  let downloaded = 0, failed = 0, skipped = 0, alreadyExists = 0;

  for (const [lessonUrl, materials] of Object.entries(freshMaterialsByLessonUrl)) {
    const info = allLessonUrls.find(l => l.lessonUrl === lessonUrl);
    if (!info) continue;

    // Create proper path: OUTPUT_BASE/course/module/lesson/materiais/
    const safeCourse = info.course;
    const safeModule = info.moduleName.replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
    const safeLesson = info.lessonName.replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
    const materiaisDir = path.join(OUTPUT_BASE, safeCourse, safeModule, safeLesson, 'materiais');
    fs.ensureDirSync(materiaisDir);

    for (const mat of materials) {
      if (!mat.url || mat.url.trim() === '') { skipped++; continue; }

      const safeName = mat.name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      const destPath = path.join(materiaisDir, safeName);

      if (fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        if (stats.size > 5000) { alreadyExists++; continue; }
      }

      try {
        execSync(`curl -sL "${mat.url}" -o "${destPath}"`, { timeout: 90000 });
        const stats = fs.statSync(destPath);
        if (stats.size > 5000) {
          downloaded++;
          console.log(`OK ${downloaded}: ${mat.name} (${Math.round(stats.size/1024)}KB) -> ${info.course}/${safeModule.substring(0,30)}`);
        } else {
          failed++;
          console.log(`SMALL ${failed}: ${mat.name} (${stats.size}B)`);
          try { fs.unlinkSync(destPath); } catch {}
        }
      } catch(e) {
        failed++;
        console.log(`FAIL ${failed}: ${mat.name} - ${e.message.substring(0,60)}`);
        try { fs.unlinkSync(destPath); } catch {}
      }
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Downloaded: ${downloaded} | Already: ${alreadyExists} | Failed: ${failed} | Skipped: ${skipped}`);

  fs.writeFileSync('storage/audit/fresh_url_last3_results.json', JSON.stringify({
    downloaded, alreadyExists, failed, skipped, lessonsVisited, lessonsWithMaterials, timestamp: new Date().toISOString()
  }, null, 2));

  await browser.close();
}

main().catch(console.error);