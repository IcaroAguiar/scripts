import fs from 'fs-extra';
import path from 'node:path';
import { ensureRuntimeDirs, runtimeContext, manifestStore } from './common';

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

async function findMatchingDir(basePath: string, targetName: string): Promise<string | null> {
  const entries = await fs.readdir(basePath, { withFileTypes: true });
  const targetNorm = normalize(targetName);
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryNorm = normalize(entry.name).replace(/^\d+/, '');
    if (entryNorm === targetNorm || targetNorm.includes(entryNorm)) {
      return path.join(basePath, entry.name);
    }
  }
  
  // Fallback: match by index prefix
  const targetIndex = targetName.match(/^(\d+)/)?.[1];
  if (targetIndex) {
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(targetIndex)) {
        return path.join(basePath, entry.name);
      }
    }
  }
  
  return null;
}

async function main(): Promise<void> {
  const context = runtimeContext(true);
  await ensureRuntimeDirs(context);

  const platform = 'themembers';
  const dryRun = process.env.DRY_RUN === '1';
  const downloadsDir = path.join(context.downloadsDir, platform);

  console.log(`Downloads: ${downloadsDir}`);
  console.log(`Dry run: ${dryRun}\n`);

  const store = manifestStore(context);
  const manifests = await store.listCourseManifests(platform);

  let totalRemoved = 0;

  for (const manifestPath of manifests) {
    const m = await store.readCourse(manifestPath);
    if (!m.course || !m.modules?.length) continue;

    const coursePath = path.join(downloadsDir, m.course);
    if (!(await fs.pathExists(coursePath))) continue;

    console.log(`Course: ${m.course}`);

    for (const mod of m.modules) {
      const modPath = await findMatchingDir(coursePath, mod.name);
      if (!modPath) {
        console.log(`  Skipping mod: ${mod.name} (not found)`);
        continue;
      }

      const lessons = await fs.readdir(modPath, { withFileTypes: true });

      for (const lessonDir of lessons) {
        if (!lessonDir.isDirectory()) continue;

        const lessonPath = path.join(modPath, lessonDir.name);
        const cleanLessonName = lessonDir.name.replace(/^\d+\s*-\s*/, '').trim();
        
        const manifestLesson = mod.lessons.find(
          (l) => normalize(l.name) === normalize(cleanLessonName) ||
                 normalize(l.name).includes(normalize(cleanLessonName).slice(0, 20))
        );

        if (!manifestLesson) continue;

        const expected = new Set(
          manifestLesson.assets
            .filter((a) => a.status !== 'failed' && !a.url.startsWith('unresolved://'))
            .map((a) => normalize(a.name))
        );

        for (const subdir of ['materiais', 'audios']) {
          const subdirPath = path.join(lessonPath, subdir);
          if (!(await fs.pathExists(subdirPath))) continue;

          const files = await fs.readdir(subdirPath);
          for (const file of files) {
            // Skip thumbnails and other non-asset files
            if (file.toLowerCase().includes('thumbnail') || file.toLowerCase().endsWith('.tmp')) continue;
            
            if (!expected.has(normalize(file))) {
              console.log(`  REMOVE ${lessonDir.name}/${subdir}/${file}`);
              if (!dryRun) {
                await fs.remove(path.join(subdirPath, file));
                totalRemoved++;
              }
            }
          }
        }
      }
    }
  }

  console.log(`\nTotal: ${totalRemoved} files to remove`);
  if (dryRun) console.log('DRY RUN - no changes');
}

main();