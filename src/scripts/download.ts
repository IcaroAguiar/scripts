import { env, ensureRuntimeDirs, manifestStore, runtimeContext } from './common';
import { Downloader } from '../core/download/downloader';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const store = manifestStore(context);
const runtimeEnv = env();
const downloader = new Downloader(context.downloadsDir, context.logsDir, runtimeEnv.DOWNLOAD_CONCURRENCY);
const manifests = await store.listCourseManifests(context.platform);

for (const manifestPath of manifests) {
  const manifest = await store.readCourse(manifestPath);
  if (runtimeEnv.THEMEMBERS_COURSE_URL && manifest.url !== runtimeEnv.THEMEMBERS_COURSE_URL) {
    continue;
  }
  const updated = await downloader.downloadCourse(manifest);
  await store.saveCourse(updated);
}
