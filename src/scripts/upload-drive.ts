import { env, ensureRuntimeDirs, manifestStore, runtimeContext } from './common';
import { LocalDriveStorageAdapter } from '../core/drive/local-drive-storage';
import { Logger } from '../core/logger/logger';

const context = runtimeContext(true);
await ensureRuntimeDirs(context);

const config = env();
const logger = new Logger(context.logsDir);
const store = manifestStore(context);
const drive = new LocalDriveStorageAdapter(config.DRIVE_EXPORT_DIR, config.DRIVE_ROOT_FOLDER_NAME, context.downloadsDir);

const manifests = await store.listCourseManifests(context.platform);
for (const manifestPath of manifests) {
  const manifest = await store.readCourse(manifestPath);
  if (config.THEMEMBERS_COURSE_URL && manifest.url !== config.THEMEMBERS_COURSE_URL) {
    continue;
  }
  await drive.ensureCourseTree(manifest);

  for (const mod of manifest.modules) {
    for (const lesson of mod.lessons) {
      const results = await drive.uploadLessonFiles(manifest, lesson);
      for (const result of results) {
        const asset = lesson.assets.find((candidate) => candidate.url === result.assetUrl);
        if (!asset) continue;
        asset.uploadStatus = result.status;
        asset.driveFileId = result.file?.id;
        asset.driveWebUrl = result.file?.webUrl;
        asset.lastError = result.error ?? asset.lastError;
      }
    }
  }

  const manifestRef = await drive.uploadManifest(manifest);
  await store.saveCourse(manifest);
  await logger.log('DRIVE', `staged manifest for Drive ${manifestRef.path}`);
}
