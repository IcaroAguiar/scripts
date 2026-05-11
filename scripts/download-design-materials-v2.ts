import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

const AUTH_PATH = 'storage/auth/themembers-retry-batch4.json';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_PATH = 'storage/audit/url_retry_design_dashboards.json';
const MANIFEST_PATH = 'storage/manifests/themembers-v3-repaired/design-de-dashboards-e-storytelling-com-dados.json';

// Fresh material data from API (captured earlier)
const MATERIALS: Record<string, Array<{name: string; url: string}>> = {
  'f871b37f-95ee-4632-a9b0-e3fd7ac6e44b': [
    { name: 'AULA 01 Design de Dashboards & Storytelling com Dados.zip', url: 'https://assets.themembers.com.br/material/Rpnso4loQZTq7nM4eWktPdyBlYpccBHh.zip' }
  ],
  'dfc4fbf6-8e1b-42a0-b144-813aeb0c7d1a': [
    { name: 'Introdução ao Storytelling de Dados.pdf', url: 'https://tm1-private.b1b50f1e80ed7386ac8c30599d66137e.r2.cloudflarestorage.com/material/Fl4DzALTrKI2h0198MtnYeyCQJIGpgI7.pdf?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=41371d6c23d9ac2aad0bf190e1a5d66e%2F20260509%2Fenam%2Fs3%2Faws4_request&X-Amz-Date=20260509T154653Z&X-Amz-SignedHeaders=host&X-Amz-Expires=86400&X-Amz-Signature=f01ea873fbee2a249e461c1a86531fc4bf31daa0f4f347c804c771cbadb3f4ff' },
    { name: 'AULA 02 Design de Dashboards & Storytelling com Dados.zip', url: 'https://tm1-private.b1b50f1e80ed7386ac8c30599d66137e.r2.cloudflarestorage.com/material/aqT3jEK4ISNbX635T0sLuXeGRIeLRxcW.zip?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=41371d6c23d9ac2aad0bf190e1a5d66e%2F20260508%2Fenam%2Fs3%2Faws4_request&X-Amz-Date=20260508T031259Z&X-Amz-SignedHeaders=host&X-Amz-Expires=86400&X-Amz-Signature=1b9e08fb07db3dc875eafcb6d3bb84c6161d92cac1bc2ee7fcca7e4ad179db14' }
  ],
  '41fff709-ec20-44b5-8341-c7a9e9849a28': [
    { name: 'Análise de Dados.pdf', url: 'https://tm1-private.b1b50f1e80ed7386ac8c30599d66137e.r2.cloudflarestorage.com/material/8nQzoRIfN4QhG3wJNBIydShX26JbjByA.pdf?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=41371d6c23d9ac2aad0bf190e1a5d66e%2F20260509%2Fenam%2Fs3%2Faws4_request&X-Amz-Date=20260509T154655Z&X-Amz-SignedHeaders=host&X-Amz-Expires=86400&X-Amz-Signature=71ec0b447ae47a3d45100ef56762b1704b94b8340a751c31f030c9c693d7302f' },
    { name: 'AULA 03 Design de Dashboards & Storytelling com Dados.zip', url: 'https://assets.themembers.com.br/material/WVtRHWCzZYJCA1zVCa7eZKDiMMsi6n17.zip' }
  ],
  '1b64c377-9267-4640-8fe7-c7d63f524bb4': [
    { name: 'Tipos de Visuais e suas Aplicações.pdf', url: 'https://tm1-private.b1b50f1e80ed7386ac8c30599d66137e.r2.cloudflarestorage.com/material/xxMWW3jj5fWJvB1REBbOfZiNfiXSHpDi.pdf?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=41371d6c23d9ac2aad0bf190e1a5d66e%2F20260509%2Fenam%2Fs3%2Faws4_request&X-Amz-Date=20260509T154657Z&X-Amz-SignedHeaders=host&X-Amz-Expires=86400&X-Amz-Signature=6385d51355d34e3a73eaac2cf0b17fee4da72b3b7ce06c10679a6af194a2f262' },
    { name: 'AULA 04 Design de Dashboards & Storytelling com Dados.zip', url: 'https://assets.themembers.com.br/material/ESVB1YprEKzpO3GbQv0a7Cut2QvTdnMt.zip' }
  ]
};

function cleanPathComponent(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 100);
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

async function sha256File(filePath: string): Promise<string> {
  const crypto = await import('crypto');
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function updateManifest(lessonId: string, assetName: string, localPath: string, sha256: string) {
  try {
    const manifest = await fs.readJson(MANIFEST_PATH);
    let updated = false;

    for (const mod of manifest.modules ?? []) {
      for (const lesson of mod.lessons ?? []) {
        if (lesson.url.includes(lessonId)) {
          for (const asset of lesson.assets ?? []) {
            const assetComparable = (n: string) =>
              n.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
            if (assetComparable(asset.name) === assetComparable(assetName)) {
              asset.localPath = localPath;
              asset.status = 'downloaded';
              asset.sha256 = sha256;
              asset.url = `file://${localPath}`;
              delete asset.lastError;
              updated = true;
              console.log(`  Updated manifest for: ${asset.name}`);
            }
          }
        }
      }
    }

    if (updated) {
      await fs.writeJson(MANIFEST_PATH, manifest, { spaces: 2 });
    }
  } catch (e) {
    console.log(`  Manifest update error: ${e.message}`);
  }
}

async function main() {
  const results: any[] = [];

  console.log('=== Processing materials from API ===\n');

  for (const [lessonId, materials] of Object.entries(MATERIALS)) {
    console.log(`Lesson: ${lessonId}`);

    for (const mat of materials) {
      const safeName = cleanPathComponent(mat.name);
      const targetDir = path.join(DOWNLOADS_DIR, 'design-de-dashboards-e-storytelling-com-dados', '01-module-01', `lesson-${lessonId.slice(0, 8)}`, 'materiais');
      const targetPath = path.join(targetDir, safeName);

      await fs.ensureDir(targetDir);

      // Check if exists
      if (await fs.pathExists(targetPath)) {
        console.log(`  EXISTS: ${mat.name}`);
        results.push({ lessonId, name: mat.name, status: 'skipped', reason: 'already exists' });
        continue;
      }

      // Try download with retry
      let downloaded = false;
      let lastError = '';

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`  Downloading (attempt ${attempt}): ${mat.name}`);
          await fetchToFile(mat.url, targetPath, 120000);
          const stats = await fs.stat(targetPath);
          console.log(`  SUCCESS: ${(stats.size / 1024).toFixed(1)} KB`);
          downloaded = true;
          break;
        } catch (e: any) {
          lastError = e.message;
          console.log(`  Attempt ${attempt} failed: ${lastError}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      if (downloaded) {
        const sha = await sha256File(targetPath);
        results.push({ lessonId, name: mat.name, status: 'downloaded', path: targetPath, sha });

        // Update manifest
        await updateManifest(lessonId, mat.name, targetPath, sha);
      } else {
        results.push({ lessonId, name: mat.name, status: 'failed', error: lastError });
      }
    }
    console.log();
  }

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

  const downloaded = results.filter(r => r.status === 'downloaded').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  console.log(`=== Summary ===`);
  console.log(`Downloaded: ${downloaded}, Failed: ${failed}, Skipped: ${skipped}`);
  console.log(`Output: ${OUTPUT_PATH}`);
}

main().catch(console.error);