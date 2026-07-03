import { describe, expect, test } from 'bun:test';
import type { CourseManifest } from '../src/core/types';
import { resolveManifestLessonDisplayNames } from '../src/scripts/lesson-display-name-resolver';
import { normalizeProductName } from '../src/scripts/discover-products';

function makeManifest(course: string, lessonNames: string[]): CourseManifest {
  return {
    platform: 'themembers',
    course,
    courseId: 'course-id',
    url: 'https://example.com/course',
    slug: 'course-slug',
    discoveredAt: new Date().toISOString(),
    modules: [
      {
        name: 'Modulo 1',
        index: 1,
        slug: 'modulo-1',
        lessons: lessonNames.map((name, i) => ({
          name,
          index: i + 1,
          url: `https://example.com/lesson/${i + 1}`,
          slug: `lesson-${i + 1}`,
          description: '',
          links: [],
          assets: []
        }))
      }
    ]
  };
}

describe('lesson display name resolver', () => {
  test('resolves lesson display names by course and lesson order', () => {
    const manifest = makeManifest('Alta Performance com Gustavo Borges', [
      'ConcluidoAula 01 - Abertura',
      'ConcluidoAula 02 - Longo Prazo'
    ]);
    const map = new Map<string, string[]>();
    map.set(normalizeProductName('Alta Performance com Gustavo Borges'), [
      'Aula 01 - Abertura Cinco Pilares',
      'Aula 02 - Longo Prazo'
    ]);

    const resolved = resolveManifestLessonDisplayNames(manifest, map);
    expect(resolved.modules[0]?.lessons[0]?.displayName).toBe('Aula 01 - Abertura Cinco Pilares');
    expect(resolved.modules[0]?.lessons[1]?.displayName).toBe('Aula 02 - Longo Prazo');
  });

  test('falls back to original lesson name when product has no lesson mapping', () => {
    const manifest = makeManifest('Curso Sem Mapeamento', ['ConcluidoAula 01 - Nome']);
    const resolved = resolveManifestLessonDisplayNames(manifest, new Map());
    expect(resolved.modules[0]?.lessons[0]?.displayName).toBe('ConcluidoAula 01 - Nome');
  });
});
