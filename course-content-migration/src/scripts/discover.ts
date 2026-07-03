import fs from 'fs-extra';
import path from 'node:path';
import { Logger } from '../core/logger/logger';
import { slugify } from '../core/utils/slug';
import {
  filterCoursesByProducts,
  loadProductsFromJson,
  parseProductsArg
} from './discover-products';
import { ensureRuntimeDirs, manifestStore, platformAdapter, runtimeContext } from './common';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const adapter = platformAdapter();
const store = manifestStore(context);
const logger = new Logger(context.logsDir);

const discoveredCourses = await adapter.discoverCourses(context);
const cliProducts = parseProductsArg(process.argv.slice(2));
const productsSource = cliProducts.length > 0 ? 'cli' : 'json';
const selectedProducts =
  cliProducts.length > 0 ? cliProducts : (await loadProductsFromJson()).products;
const { filteredCourses: courses, missingProducts } = filterCoursesByProducts(discoveredCourses, selectedProducts);

await logger.log('DISCOVER', `course filter summary`, {
  source: productsSource,
  totalFound: discoveredCourses.length,
  totalFiltered: courses.length,
  selectedProducts: selectedProducts.length,
  missingProductsCount: missingProducts.length,
  missingProducts
});

if (courses.length === 0) {
  await logger.log('SKIPPED', 'no courses matched selected products; skipping discovery run');
  process.exit(0);
}

await store.saveIndex(adapter.platform, courses);
const forceDiscover = process.env.DISCOVER_FORCE === '1';

async function runCourseWorker(course: { id: string; name: string; url: string }, timeoutMs: number): Promise<void> {
  const child = Bun.spawn(['bun', 'run', 'src/scripts/discover-one.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DISCOVER_COURSE_ID: course.id,
      DISCOVER_COURSE_NAME: course.name,
      DISCOVER_COURSE_URL: course.url
    },
    stdout: 'inherit',
    stderr: 'inherit'
  });

  let timeout: Timer | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill(9);
          reject(new Error(`course worker timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
    if (exitCode !== 0) throw new Error(`course worker exited with code ${exitCode}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function saveTimedOutManifest(course: { id: string; name: string; url: string }, error: string): Promise<void> {
  await store.saveCourse({
    platform: adapter.platform,
    course: course.name,
    courseId: course.id,
    url: course.url,
    slug: slugify(course.name),
    discoveredAt: new Date().toISOString(),
    modules: [
      {
        name: 'Discovery failed',
        index: 1,
        slug: 'discovery-failed',
        lessons: [
          {
            name: 'Discovery failed',
            index: 1,
            url: course.url,
            slug: 'discovery-failed',
            description: '',
            links: [],
            assets: [],
            status: 'failed',
            lastError: error
          }
        ]
      }
    ]
  });
}

for (const course of courses) {
  const existingManifestPath = path.join(context.manifestDir, adapter.platform, `${slugify(course.name)}.json`);
  if (!forceDiscover && (await fs.pathExists(existingManifestPath))) {
    await logger.log('SKIPPED', `manifest already exists ${existingManifestPath}`);
    continue;
  }

  await logger.log('DISCOVER', `discovering course ${course.name}`, { url: course.url });
  try {
    await runCourseWorker(course, Number(process.env.DISCOVER_COURSE_TIMEOUT_MS ?? 60_000));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.log('FAILED', `course discovery failed ${course.name}`, {
      error: message
    });
    await saveTimedOutManifest(course, message);
  }
}
