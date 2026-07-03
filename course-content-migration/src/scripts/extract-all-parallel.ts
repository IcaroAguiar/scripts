import { ensureRuntimeDirs, runtimeContext, manifestStore } from './common';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';

const WORKER_COUNT = 3;
const COURSES_PER_WORKER = 4;

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const manifests = await store.listCourseManifests('themembers');

// Get courses that have assets and need re-extraction
const coursesToProcess: { slug: string; path: string }[] = [];
for (const mPath of manifests) {
  const m = await store.readCourse(mPath);
  const hasAssets = m.modules?.some((mod: any) =>
    mod.lessons?.some((l: any) => l.assets?.length > 0)
  );
  if (hasAssets) {
    coursesToProcess.push({ slug: m.slug, path: mPath });
  }
}

console.log(`Total courses to re-extract: ${coursesToProcess.length}`);
console.log(`Workers: ${WORKER_COUNT}, Courses per worker: ${COURSES_PER_WORKER}`);

// Split into batches
const batches: string[][] = [];
for (let i = 0; i < coursesToProcess.length; i += COURSES_PER_WORKER) {
  batches.push(coursesToProcess.slice(i, i + COURSES_PER_WORKER).map(c => c.slug));
}

// Save batches
for (let i = 0; i < batches.length; i++) {
  await fs.writeFile(`storage/extraction-batch-${i}.json`, JSON.stringify(batches[i]));
}

console.log(`\nCreated ${batches.length} batches`);
console.log('Starting parallel extraction...\n');

let completedWorkers = 0;
const startTime = Date.now();

async function runWorker(workerId: number, courseSlugs: string[]): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      '-e',
      `
      const slugs = ${JSON.stringify(courseSlugs)};
      for (const slug of slugs) {
        const { spawn } = require('child_process');
        console.log('[Worker ${workerId}] Starting: ' + slug);
        const start = Date.now();
        
        const proc = spawn('bun', ['run', 'src/scripts/extract.ts'], {
          env: { ...process.env, EXTRACT_COURSE_SLUG: slug, EXTRACT_FORCE: '1' },
          stdio: 'inherit'
        });
        
        proc.on('close', (code) => {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          console.log('[Worker ${workerId}] ' + slug + ' - ' + (code === 0 ? 'OK' : 'FAILED') + ' (' + elapsed + 's)');
        });
        
        // Wait for this course to finish before next
        if (slugs.indexOf(slug) < slugs.length - 1) {
          proc.on('exit', () => new Promise(r => setTimeout(r, 2000)));
        }
      }
      console.log('[Worker ${workerId}] Done');
      `
    ];
    
    const worker = spawn('bun', args, {
      stdio: 'inherit',
      env: process.env
    });
    
    worker.on('close', (code) => {
      completedWorkers++;
      console.log(`\n[Worker ${workerId}] Finished with code ${code}`);
      resolve();
    });
  });
}

// Run workers in parallel
const workers = batches.slice(0, WORKER_COUNT).map((batch, i) => runWorker(i + 1, batch));

await Promise.all(workers);

const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`\n=== All workers done in ${elapsed} minutes ===`);

// Quick verification
console.log('\nVerifying manifests...');
let ok = 0, issues = 0;
for (const { slug, path: mPath } of coursesToProcess) {
  try {
    const m = await store.readCourse(mPath);
    const hasAssets = m.modules?.some((mod: any) => mod.lessons?.some((l: any) => l.assets?.length > 0));
    if (hasAssets) ok++; else issues++;
  } catch {
    issues++;
  }
}
console.log(`Manifests OK: ${ok}, Issues: ${issues}`);