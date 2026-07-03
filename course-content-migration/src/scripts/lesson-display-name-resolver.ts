import type { CourseManifest } from '../core/types';
import { normalizeProductName } from './discover-products';

export function resolveManifestLessonDisplayNames(
  manifest: CourseManifest,
  lessonNamesByProductKey: Map<string, string[]>
): CourseManifest {
  const lessonNames = lessonNamesByProductKey.get(normalizeProductName(manifest.course)) ?? [];
  let lessonCursor = 0;
  const modules = manifest.modules.map((mod) => ({
    ...mod,
    lessons: mod.lessons.map((lesson) => {
      const resolvedName = lessonNames[lessonCursor];
      lessonCursor += 1;
      return {
        ...lesson,
        displayName: resolvedName && resolvedName.trim() ? resolvedName : lesson.name
      };
    })
  }));
  return { ...manifest, modules };
}
