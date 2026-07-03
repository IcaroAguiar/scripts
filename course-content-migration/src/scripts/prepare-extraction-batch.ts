import { ensureRuntimeDirs, runtimeContext, manifestStore } from './common';
import fs from 'fs-extra';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const manifests = await store.listCourseManifests('themembers');

// Filter courses that have lessons with assets (already discovered)
const coursesToProcess = [];
for (const mPath of manifests) {
  const m = await store.readCourse(mPath);
  const hasAssets = m.modules?.some(mod =>
    mod.lessons?.some(lesson => lesson.assets?.length > 0)
  );
  if (hasAssets) {
    coursesToProcess.push({
      path: mPath,
      slug: m.slug,
      course: m.course,
      lessonCount: m.modules?.reduce((acc: number, mod: any) => acc + (mod.lessons?.length || 0), 0) || 0
    });
  }
}

console.log(`Courses to re-extract: ${coursesToProcess.length}`);
for (const c of coursesToProcess) {
  console.log(`  - ${c.course} (${c.lessonCount} lessons)`);
}

const manifest = JSON.stringify(coursesToProcess.map(c => ({ slug: c.slug, course: c.course, path: c.path })), null, 2);
await fs.writeFile('storage/extraction-batch.json', manifest);
console.log('\nBatch saved to storage/extraction-batch.json');
console.log('Run: bun run src/scripts/extract-all-parallel.ts');