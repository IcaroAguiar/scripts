import fs from 'fs-extra';
import path from 'node:path';
import { sha256File } from '../core/download/hash';

const MANIFESTS_DIR = 'storage/manifests/themembers-v3-repaired';
const DOWNLOADS_DIR = 'storage/downloads/themembers-v3-retry';
const OUTPUT_AUDIT = 'storage/audit/url_retry_gesao_performance.json';
const COURSE_SLUG = 'gestao-de-performance-e-cultura-de-resultados';

function cleanPath(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchToFile(url: string, targetPath: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(targetPath, buf);
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const manifestPath = path.join(MANIFESTS_DIR, `${COURSE_SLUG}.json`);
  const manifest = await fs.readJson(manifestPath);

  const r2Assets = [];
  const unresolvedAssets = [];

  for (const mod of manifest.modules ?? []) {
    for (const lesson of mod.lessons ?? []) {
      for (const asset of lesson.assets ?? []) {
        if (asset.url.startsWith('https://tm1-private') && asset.status === 'pending') {
          r2Assets.push({ mod, lesson, asset });
        } else if (asset.url.startsWith('unresolved://') && asset.status === 'failed') {
          unresolvedAssets.push({ mod, lesson, asset });
        }
      }
    }
  }

  console.log(`R2 URL assets (direct download): ${r2Assets.length}`);
  console.log(`Unresolved assets (need browser click): ${unresolvedAssets.length}`);

  const audit: any[] = [];

  for (const { mod, lesson, asset } of r2Assets) {
    const targetDir = path.join(
      DOWNLOADS_DIR,
      COURSE_SLUG,
      cleanPath(mod.name),
      cleanPath(lesson.name),
      'materiais'
    );
    await fs.ensureDir(targetDir);
    const targetPath = path.join(targetDir, cleanPath(asset.name));

    console.log(`\nDownloading: ${asset.name}`);
    console.log(`  URL: ${asset.url.slice(0, 80)}...`);

    try {
      const status = await fetchToFile(asset.url, targetPath, 120_000);
      const sha = await sha256File(targetPath);

      console.log(`  Downloaded: ${targetPath}`);
      console.log(`  SHA256: ${sha}`);
      console.log(`  Status: ${status}`);

      asset.localPath = targetPath;
      asset.status = 'downloaded';
      asset.sha256 = sha;
      delete asset.lastError;

      audit.push({
        assetName: asset.name,
        status: 'downloaded',
        localPath: targetPath,
        sha256: sha,
        urlUsed: asset.url,
      });
    } catch (e) {
      console.log(`  FAILED: ${e}`);
      audit.push({
        assetName: asset.name,
        status: 'failed',
        error: String(e),
        urlAttempted: asset.url,
      });
    }
  }

  await fs.writeJson(path.join(MANIFESTS_DIR, `${COURSE_SLUG}.json`), manifest, { spaces: 2 });
  await fs.writeJson(OUTPUT_AUDIT, audit, { spaces: 2 });

  const downloaded = audit.filter((a) => a.status === 'downloaded').length;
  const failed = audit.filter((a) => a.status === 'failed').length;

  console.log(`\n=== Direct Download Summary ===`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Audit: ${OUTPUT_AUDIT}`);
  console.log(`\nUnresolved assets (need browser): ${unresolvedAssets.length}`);
  for (const { mod, lesson, asset } of unresolvedAssets) {
    console.log(`  - ${asset.name} (${lesson.name})`);
  }
}

main().catch(console.error);