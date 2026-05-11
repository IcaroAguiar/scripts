import fs from 'fs-extra';
import path from 'node:path';
import type {
  CourseManifest,
  DriveCourseTree,
  DriveFileRef,
  DriveFolderRef,
  DriveStorageAdapter,
  DriveUploadResult,
  LessonManifest
} from '../types';
import { lessonDir } from '../filesystem/lesson-writer';
import { numberedName } from '../utils/slug';

export class LocalDriveStorageAdapter implements DriveStorageAdapter {
  constructor(
    private readonly exportDir: string,
    private readonly rootFolderName: string,
    private readonly downloadsDir: string
  ) {}

  async ensureRootFolder(): Promise<DriveFolderRef> {
    const rootPath = path.join(this.exportDir, this.rootFolderName);
    await fs.ensureDir(rootPath);
    return { id: rootPath, name: this.rootFolderName, path: rootPath };
  }

  async ensureCourseTree(manifest: CourseManifest): Promise<DriveCourseTree> {
    const root = await this.ensureRootFolder();
    const platformPath = path.join(root.path, manifest.platform);
    const coursePath = path.join(platformPath, manifest.course);
    const manifestsPath = path.join(platformPath, '_manifests');
    await fs.ensureDir(coursePath);
    await fs.ensureDir(manifestsPath);

    return {
      root,
      platform: { id: platformPath, name: manifest.platform, path: platformPath },
      course: { id: coursePath, name: manifest.course, path: coursePath },
      manifests: { id: manifestsPath, name: '_manifests', path: manifestsPath }
    };
  }

  async uploadLessonFiles(manifest: CourseManifest, lesson: LessonManifest): Promise<DriveUploadResult[]> {
    const tree = await this.ensureCourseTree(manifest);
    const mod = manifest.modules.find((candidate) => candidate.lessons.includes(lesson));
    if (!mod) return [];

    const sourceDir = lessonDir(this.downloadsDir, manifest, mod, lesson);
    const destinationDir = path.join(tree.course.path, numberedName(mod.index, mod.name), numberedName(lesson.index, lesson.name));
    await fs.ensureDir(destinationDir);

    if (!(await fs.pathExists(sourceDir))) {
      return lesson.assets.map((asset) => ({
        assetUrl: asset.url,
        status: 'failed',
        error: `local lesson directory not found: ${sourceDir}`
      }));
    }

    await fs.copy(sourceDir, destinationDir, { overwrite: false, errorOnExist: false });

    return lesson.assets.map((asset) => {
      const filePath = asset.localPath
        ? path.join(destinationDir, asset.type === 'audio' ? 'audios' : 'materiais', path.basename(asset.localPath))
        : destinationDir;
      return {
        assetUrl: asset.url,
        status: 'uploaded',
        file: { id: filePath, name: path.basename(filePath), path: filePath }
      };
    });
  }

  async uploadManifest(manifest: CourseManifest): Promise<DriveFileRef> {
    const tree = await this.ensureCourseTree(manifest);
    const filePath = path.join(tree.manifests.path, `${manifest.slug}.json`);
    await fs.writeJson(filePath, manifest, { spaces: 2 });
    return { id: filePath, name: `${manifest.slug}.json`, path: filePath };
  }
}
