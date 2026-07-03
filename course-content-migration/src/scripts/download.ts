import { env, ensureRuntimeDirs, manifestStore, runtimeContext } from './common';
import { Downloader } from '../core/download/downloader';
import {
  filterCoursesByProducts,
  loadProductLessonNameMapFromJson,
  loadProductsFromJson,
  parseProductsArg
} from './discover-products';
import { resolveManifestLessonDisplayNames } from './lesson-display-name-resolver';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const runtimeEnv = env();
const downloader = new Downloader(context.downloadsDir, context.logsDir, runtimeEnv.DOWNLOAD_CONCURRENCY);
const manifestPaths = await store.listCourseManifests(context.platform);
const manifests = await Promise.all(manifestPaths.map((manifestPath) => store.readCourse(manifestPath)));

const cliProducts = parseProductsArg(process.argv.slice(2));
const selectedProducts =
  cliProducts.length > 0 ? cliProducts : (await loadProductsFromJson()).products;
const productsSource = cliProducts.length > 0 ? 'cli' : 'json';
const { lessonNamesByProductKey } = await loadProductLessonNameMapFromJson().catch(() => ({
  lessonNamesByProductKey: new Map<string, string[]>()
}));
const { filteredCourses: filteredManifests, missingProducts } = filterCoursesByProducts(
  manifests.map((manifest) => ({ ...manifest, name: manifest.course })),
  selectedProducts
);

const scopedManifests = filteredManifests.map((manifest) =>
  resolveManifestLessonDisplayNames(manifest, lessonNamesByProductKey)
);
const debugDownload = process.env.DOWNLOAD_DEBUG === '1';

const lessonsCount = scopedManifests.reduce(
  (sum, manifest) =>
    sum + manifest.modules.reduce((moduleSum, module) => moduleSum + module.lessons.length, 0),
  0
);
const assetsCount = scopedManifests.reduce(
  (sum, manifest) =>
    sum +
    manifest.modules.reduce(
      (moduleSum, module) =>
        moduleSum + module.lessons.reduce((lessonSum, lesson) => lessonSum + lesson.assets.length, 0),
      0
    ),
  0
);

console.log(
  `[DOWNLOAD] product filter summary: source=${productsSource} totalFound=${manifests.length} totalFiltered=${filteredManifests.length} selectedProducts=${selectedProducts.length} missingProducts=${missingProducts.length}`
);
console.log(`[DOWNLOAD] scoped content: lessons=${lessonsCount} assets=${assetsCount}`);
if (missingProducts.length > 0) {
  console.log(`[DOWNLOAD] missing products: ${missingProducts.join(' | ')}`);
}

if (filteredManifests.length === 0) {
  console.log('[DOWNLOAD] no courses matched selected products; skipping download run');
  process.exit(0);
}

if (assetsCount === 0) {
  console.log('[DOWNLOAD] no assets found in selected manifests. Run extract before download.');
  process.exit(0);
}

for (const manifest of scopedManifests) {
  if (runtimeEnv.THEMEMBERS_COURSE_URL && manifest.url !== runtimeEnv.THEMEMBERS_COURSE_URL) {
    continue;
  }
  if (debugDownload) {
    console.log(`[DOWNLOAD][DEBUG] course=${manifest.course} modules=${manifest.modules.length}`);
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons) {
        console.log(
          `[DOWNLOAD][DEBUG] lesson idx=${lesson.index} original="${lesson.name}" display="${lesson.displayName ?? lesson.name}" assets=${lesson.assets.length}`
        );
      }
    }
  }
  const updated = await downloader.downloadCourse(manifest);
  await store.saveCourse(updated);
}
