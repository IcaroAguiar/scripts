import fs from 'fs-extra';
import path from 'node:path';
import { runtimeContext, manifestStore } from './common';

const context = runtimeContext(true);

interface AssetInfo {
  name: string;
  url: string;
}

interface LessonManifest {
  name: string;
  assets: AssetInfo[];
}

interface ModuleManifest {
  name: string;
  lessons: LessonManifest[];
}

interface CourseManifest {
  name: string;
  modules: ModuleManifest[];
}

async function getManifestAssets(manifest: CourseManifest): Promise<Map<string, Set<string>>> {
  const courseAssets = new Map<string, Set<string>>();

  for (const mod of manifest.modules) {
    const modSlug = mod.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 30);

    for (const lesson of mod.lessons) {
      const lessonSlug = lesson.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 30);
      const key = `${modSlug}/${lessonSlug}`;

      const validAssets = new Set<string>();
      for (const asset of lesson.assets) {
        if (asset.url.startsWith('unresolved://') || asset.status === 'failed') continue;
        validAssets.add(asset.name.toLowerCase());
      }

      courseAssets.set(key, validAssets);
    }
  }

  return courseAssets;
}

function parseDirKey(dirName: string): string {
  return dirName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 30);
}

async function main(): Promise<void> {
  const platform = process.env.CLEANUP_FILES_PLATFORM ?? 'themembers';
  const dryRun = process.env.DRY_RUN === '1';
  const downloadsDir = path.join(context.downloadsDir, platform);

  console.log(`Downloads dir: ${downloadsDir}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  if (!(await fs.pathExists(downloadsDir))) {
    console.log('Downloads directory does not exist');
    return;
  }

  const courseDirs = await fs.readdir(downloadsDir);
  let totalRemoved = 0;

  for (const courseDir of courseDirs) {
    const manifestPath = path.join(context.manifestDir, platform, `${courseDir}.json`);

    if (!(await fs.pathExists(manifestPath))) {
      console.log(`No manifest for: ${courseDir}, skipping...`);
      continue;
    }

    const manifest: CourseManifest = await fs.readJson(manifestPath);
    const expectedAssets = await getManifestAssets(manifest);

    const coursePath = path.join(downloadsDir, courseDir);

    if (!(await fs.pathExists(coursePath))) continue;

    const modDirs = await fs.readdir(coursePath, { withFileTypes: true });

    for (const modDir of modDirs) {
      if (!modDir.isDirectory()) continue;
      const modSlug = parseDirKey(modDir.name);
      const modPath = path.join(coursePath, modDir.name);

      const lessonDirs = await fs.readdir(modPath, { withFileTypes: true });

      for (const lessonDir of lessonDirs) {
        if (!lessonDir.isDirectory()) continue;
        const lessonSlug = parseDirKey(lessonDir.name);
        const key = `${modSlug}/${lessonSlug}`;

        const expected = expectedAssets.get(key) ?? new Set<string>();

        const lessonPath = path.join(modPath, lessonDir.name);

        for (const subdir of ['materiais', 'audios']) {
          const subdirPath = path.join(lessonPath, subdir);
          if (!(await fs.pathExists(subdirPath))) continue;

          const files = await fs.readdir(subdirPath);

          for (const file of files) {
            const fileLower = file.toLowerCase();
            if (expected.has(fileLower)) continue;

            console.log(`Extra file: ${courseDir}/${modDir.name}/${lessonDir.name}/${subdir}/${file}`);
            totalRemoved += 1;

            if (!dryRun) {
              await fs.remove(path.join(subdirPath, file));
            }
          }
        }
      }
    }
  }

  console.log('');
  console.log(`=== Summary ===`);
  console.log(`Extra files found: ${totalRemoved}`);

  if (dryRun) {
    console.log('');
    console.log('DRY RUN - no files deleted. Run without DRY_RUN=1 to apply.');
  }
}

await main();