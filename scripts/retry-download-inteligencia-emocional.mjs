import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';

const BASE_URL = 'https://alunos.tetraeducacao.com.br';
const LOGIN_EMAIL = 'lucas@tetraeducacao.com.br';
const LOGIN_PASSWORD = '28778422';
const MANIFEST_PATH = 'storage/manifests/themembers-v3-repaired/inteligencia-emocional.json';
const OUTPUT_DIR = 'storage/downloads/themembers-v3-retry/inteligencia-emocional';
const AUDIT_PATH = 'storage/audit/url_retry_inteligencia_emocional.json';
const MATERIALS_API = 'https://api.themembers.com.br/api/auth/home/materials';

const audit = {
  startedAt: new Date().toISOString(),
  course: 'inteligencia-emocional',
  totalAssets: 0,
  results: [],
  errors: []
};

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const file = fs.createWriteStream(destPath);

    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': 'https://alunos.tetraeducacao.com.br/'
      }
    }, (response) => {
      if (response.statusCode === 403 || response.statusCode === 404) {
        file.close();
        if (fs.existsSync(destPath)) { fs.unlinkSync(destPath); }
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch {} }
      reject(err);
    });
  });
}

async function getFreshMaterialUrls(page, lessonId) {
  const cookies = await page.context().cookies();
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

  try {
    const response = await page.request.get(`${MATERIALS_API}/${lessonId}`, {
      headers: { 'Cookie': cookieStr }
    });
    const body = await response.text();
    if (response.status() === 200) {
      const materials = JSON.parse(body);
      const urlMap = {};
      for (const mat of materials) {
        if (mat.material_url) {
          urlMap[mat.material_name] = mat.material_url;
        }
      }
      return urlMap;
    }
  } catch (e) {
    console.log(`  API call failed: ${e.message}`);
  }
  return {};
}

function getLessonIdFromUrl(url) {
  const parts = url.split('/');
  return parts[parts.length - 1];
}

async function process() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[name*="email"], input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[name*="password"], input[type="password"]', LOGIN_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForURL('**/homepage**', { timeout: 10000 });
  console.log('Logged in successfully');

  await page.waitForTimeout(2000);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  const pendingAssets = [];
  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons) {
      for (const asset of lesson.assets) {
        if (asset.status === 'pending' && asset.url && asset.url.includes('tm1-private')) {
          pendingAssets.push({
            lessonName: lesson.name,
            lessonIndex: lesson.index,
            lessonUrl: lesson.url,
            moduleName: mod.name,
            name: asset.name,
            url: asset.url,
            driveFileId: asset.driveFileId,
            drivePath: asset.driveFileId?.replace('storage/drive-export/EAD Migration Bot/themembers/', '')
          });
        }
      }
    }
  }

  audit.totalAssets = pendingAssets.length;
  console.log(`Found ${pendingAssets.length} pending URL-only assets`);

  // Group by lesson to minimize API calls
  const byLesson = {};
  for (const asset of pendingAssets) {
    const lessonId = getLessonIdFromUrl(asset.lessonUrl);
    if (!byLesson[lessonId]) {
      byLesson[lessonId] = { lessonName: asset.lessonName, lessonUrl: asset.lessonUrl, assets: [] };
    }
    byLesson[lessonId].assets.push(asset);
  }

  for (const [lessonId, lessonData] of Object.entries(byLesson)) {
    console.log(`\n=== Lesson: ${lessonData.lessonName} (${lessonId}) ===`);

    // Get fresh URLs from API
    const freshUrls = await getFreshMaterialUrls(page, lessonId);
    console.log(`  Fresh URLs from API: ${Object.keys(freshUrls).length}`);

    for (const asset of lessonData.assets) {
      console.log(`\n--- Processing: ${asset.name} ---`);
      const result = {
        name: asset.name,
        lessonName: asset.lessonName,
        status: 'pending',
        error: null,
        urlUsed: asset.url,
        localPath: null
      };

      try {
        // Use fresh URL if available, otherwise original
        let downloadUrl = freshUrls[asset.name] || asset.url;
        if (freshUrls[asset.name]) {
          console.log(`  Using FRESH URL from API`);
        } else {
          console.log(`  Using ORIGINAL URL (fresh URL not in API response)`);
        }

        // Determine output path
        let outputPath;
        if (asset.drivePath) {
          const drivePathParts = asset.drivePath.split('/');
          outputPath = path.join(OUTPUT_DIR, drivePathParts.slice(0, -1).join('/'), 'materiais', path.basename(asset.name));
        } else {
          outputPath = path.join(OUTPUT_DIR, `${asset.lessonIndex} - ${asset.lessonName}`, 'materiais', asset.name);
        }

        console.log(`  Downloading from: ${downloadUrl.substring(0, 80)}...`);
        console.log(`  To: ${outputPath}`);

        await downloadFile(downloadUrl, outputPath);
        const stats = fs.statSync(outputPath);
        result.status = 'success';
        result.localPath = outputPath;
        result.sizeBytes = stats.size;
        console.log(`  SUCCESS: ${stats.size} bytes`);

        // Update manifest
        manifest.modules.forEach(mod => {
          mod.lessons.forEach(lesson => {
            lesson.assets.forEach(a => {
              if (a.name === asset.name && a.url === asset.url && !a.localPath) {
                a.localPath = outputPath;
                a.relativePath = path.relative('storage/downloads', outputPath);
                a.status = 'downloaded';
              }
            });
          });
        });

      } catch (e) {
        result.status = 'error';
        result.error = e.message;
        console.log(`  ERROR: ${e.message}`);
        audit.errors.push({ asset: asset.name, error: e.message });
      }

      audit.results.push(result);
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nManifest updated');

  audit.finishedAt = new Date().toISOString();
  audit.successCount = audit.results.filter(r => r.status === 'success').length;
  audit.errorCount = audit.errors.length;
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(audit, null, 2));
  console.log(`\nAudit saved to ${AUDIT_PATH}`);
  console.log(`Success: ${audit.successCount}, Errors: ${audit.errorCount}`);

  await browser.close();
}

process().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
