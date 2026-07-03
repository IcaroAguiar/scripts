import fs from 'fs-extra';
import path from 'node:path';
import type { CourseManifest, LessonManifest, ModuleManifest } from '../types';
import { cleanName, numberedName } from '../utils/slug';

function resolvedLessonName(lesson: LessonManifest): string {
  return lesson.displayName && lesson.displayName.trim() ? lesson.displayName : lesson.name;
}

export function lessonDir(downloadsDir: string, manifest: CourseManifest, mod: ModuleManifest, lesson: LessonManifest): string {
  return path.join(
    downloadsDir,
    manifest.platform,
    numberedName(1, manifest.course).replace(/^01 - /, ''),
    numberedName(mod.index, mod.name),
    cleanName(resolvedLessonName(lesson))
  );
}

export async function writeLessonFiles(
  downloadsDir: string,
  manifest: CourseManifest,
  mod: ModuleManifest,
  lesson: LessonManifest
): Promise<void> {
  const dir = lessonDir(downloadsDir, manifest, mod, lesson);
  const lessonDisplayName = resolvedLessonName(lesson);
  await fs.ensureDir(path.join(dir, 'materiais'));
  await fs.ensureDir(path.join(dir, 'audios'));
  await fs.writeFile(path.join(dir, 'descricao.md'), lesson.description || '');
  await fs.writeFile(path.join(dir, 'links.txt'), `${lesson.links.join('\n')}${lesson.links.length ? '\n' : ''}`);
  await fs.writeJson(
    path.join(dir, 'metadata.json'),
    {
      platform: manifest.platform,
      course: manifest.course,
      module: mod.name,
      lesson: lesson.name,
      ...(lessonDisplayName !== lesson.name ? { lessonDisplayName } : {}),
      url: lesson.url,
      assets: lesson.assets
    },
    { spaces: 2 }
  );
}

export function assetTargetPath(
  downloadsDir: string,
  manifest: CourseManifest,
  mod: ModuleManifest,
  lesson: LessonManifest,
  assetName: string,
  kind: 'materiais' | 'audios'
): string {
  return path.join(lessonDir(downloadsDir, manifest, mod, lesson), kind, assetName);
}
