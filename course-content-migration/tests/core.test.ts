import { describe, expect, test } from 'bun:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { classifyAsset, extractLessonContentFromPage } from '../src/core/extractors/assets';
import { courseManifestSchema } from '../src/core/manifest/schema';
import { cleanName, numberedName, slugify } from '../src/core/utils/slug';
import { LocalDriveStorageAdapter } from '../src/core/drive/local-drive-storage';
import { lessonDir, writeLessonFiles } from '../src/core/filesystem/lesson-writer';
import type { CourseManifest } from '../src/core/types';

function sampleManifest(): CourseManifest {
  return {
    platform: 'themembers',
    course: 'Curso XYZ',
    courseId: 'curso-xyz',
    url: 'https://example.com/course',
    slug: 'curso-xyz',
    discoveredAt: new Date().toISOString(),
    modules: [
      {
        name: 'Introdução',
        index: 1,
        slug: 'introducao',
        lessons: [
          {
            name: 'Aula Inicial',
            index: 1,
            url: 'https://example.com/lesson',
            slug: 'aula-inicial',
            description: 'Descrição',
            links: ['https://external.example'],
            assets: [
              {
                type: 'document',
                name: 'apostila.pdf',
                url: 'https://example.com/apostila.pdf',
                sha256: null,
                status: 'pending',
                uploadStatus: 'pending'
              }
            ]
          }
        ]
      }
    ]
  };
}

describe('asset classification', () => {
  test('classifies initial supported asset types', () => {
    expect(classifyAsset('https://example.com/file.pdf')).toBe('document');
    expect(classifyAsset('https://example.com/audio.mp3')).toBe('audio');
    expect(classifyAsset('https://example.com/image.webp')).toBe('image');
    expect(classifyAsset('https://example.com/page')).toBe('external-link');
  });
});

describe('external material links', () => {
  test('keeps Google Drive links as relevant external assets', async () => {
    const page = {
      locator: () => ({
        first: () => ({
          innerText: async () => 'Descrição'
        })
      }),
      evaluate: async () => ({
        description: 'Descrição',
        materialNames: [],
        urls: ['https://drive.google.com/file/d/example/view', 'https://example.com/apostila.pdf']
      })
    } as never;

    const content = await extractLessonContentFromPage(page);

    expect(content.links).toContain('https://drive.google.com/file/d/example/view');
    expect(content.assets.some((asset) => asset.type === 'external-link' && asset.url.includes('drive.google.com'))).toBe(
      true
    );
  });

  test('ignores UI avatar and emoji image assets', async () => {
    const page = {
      locator: () => ({
        first: () => ({
          innerText: async () => 'Descrição'
        })
      }),
      evaluate: async () => ({
        description: 'Descrição',
        materialNames: [],
        urls: [
          'https://assets.themembers.com.br/profile/avatar.png',
          'https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/1f386.png',
          'https://assets.themembers.com.br/banner_lesson/banner.png',
          'https://alunos.tetraeducacao.com.br/images/icons/CheckCircleVoid.svg'
        ]
      })
    } as never;

    const content = await extractLessonContentFromPage(page);

    expect(content.assets).toHaveLength(0);
  });

  test('records material names without exposed URLs as failed unresolved assets', async () => {
    const page = {
      evaluate: async () => ({
        description: 'Aula 01',
        materialNames: ['Slides Aula 01.pdf'],
        urls: []
      })
    } as never;

    const content = await extractLessonContentFromPage(page);

    expect(content.assets).toHaveLength(1);
    expect(content.assets[0]?.type).toBe('document');
    expect(content.assets[0]?.name).toBe('Slides Aula 01.pdf');
    expect(content.assets[0]?.url).toBe('unresolved://Slides%20Aula%2001.pdf');
    expect(content.assets[0]?.status).toBe('failed');
    expect(content.assets[0]?.lastError).toContain('no downloadable URL');
  });
});

describe('filesystem naming', () => {
  test('normalizes unsafe names and preserves order prefix', () => {
    expect(cleanName('  Aula: inicial 🚀 / teste  ')).toBe('Aula inicial teste');
    expect(numberedName(2, 'Módulo Áudio')).toBe('02 - Modulo Audio');
    expect(slugify('Curso Ágil para EAD')).toBe('curso-agil-para-ead');
  });

  test('uses lesson display name for lesson directory without numbering', () => {
    const manifest = sampleManifest();
    const module = manifest.modules[0]!;
    const lesson = {
      ...module.lessons[0]!,
      index: 7,
      name: 'ConcluidoAula 07 - Nome Original',
      displayName: 'Aula 07 - Nome Final'
    };
    const dir = lessonDir('/tmp/downloads', manifest, module, lesson);
    expect(dir.endsWith(path.join('01 - Introducao', 'Aula 07 - Nome Final'))).toBe(true);
  });

  test('writes metadata with lessonDisplayName only when different from lesson name', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lesson-files-'));
    const manifest = sampleManifest();
    const module = manifest.modules[0]!;
    const lesson = {
      ...module.lessons[0]!,
      name: 'ConcluidoAula 01 - Abertura',
      displayName: 'Aula 01 - Abertura'
    };

    await writeLessonFiles(tmp, manifest, module, lesson);
    const metaPath = path.join(lessonDir(tmp, manifest, module, lesson), 'metadata.json');
    const metadata = await fs.readJson(metaPath);
    expect(metadata.lesson).toBe('ConcluidoAula 01 - Abertura');
    expect(metadata.lessonDisplayName).toBe('Aula 01 - Abertura');

    const lessonWithoutOverride = { ...lesson, displayName: lesson.name };
    await writeLessonFiles(tmp, manifest, module, lessonWithoutOverride);
    const metaPathNoDiff = path.join(lessonDir(tmp, manifest, module, lessonWithoutOverride), 'metadata.json');
    const metadataNoDiff = await fs.readJson(metaPathNoDiff);
    expect(metadataNoDiff.lessonDisplayName).toBeUndefined();
  });
});

describe('manifest schema', () => {
  test('accepts the MVP course manifest shape', () => {
    expect(courseManifestSchema.parse(sampleManifest()).course).toBe('Curso XYZ');
  });
});

describe('local Drive staging adapter', () => {
  test('creates root, platform, course and manifest folders', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ead-drive-'));
    const adapter = new LocalDriveStorageAdapter(tmp, 'EAD Migration Bot', path.join(tmp, 'downloads'));
    const manifest = sampleManifest();

    const tree = await adapter.ensureCourseTree(manifest);
    const manifestRef = await adapter.uploadManifest(manifest);

    expect(await fs.pathExists(tree.course.path)).toBe(true);
    expect(await fs.pathExists(tree.manifests.path)).toBe(true);
    expect(await fs.pathExists(manifestRef.path)).toBe(true);
  });
});
