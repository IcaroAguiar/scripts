#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createBrowserContext } from '../core/browser/browser';
import type { BrowserContext, Page } from 'playwright';

const TARGET_COURSES = [
  'curso-completo-curriculo-profissional',
  'design-de-dashboards-e-storytelling-com-dados',
  'excel-essencial',
  'figma'
];

const MANIFEST_DIR = 'storage/manifests/themembers';
const OUTPUT_FILE = 'storage/audit/restore_candidates_focused_diagnostics.json';

interface DiagnosticResult {
  course: string;
  courseUrl: string;
  modules: Array<{
    name: string;
    url: string;
    lessons: Array<{
      name: string;
      url: string;
      assetsFound: string[];
      assetLinks: string[];
    }>;
  }>;
}

async function extractMaterialsFromLesson(page: Page, lessonUrl: string, lessonName: string): Promise<string[]> {
  const materials: string[] = [];
  try {
    await page.goto(lessonUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const assetLinks = await page.evaluate(() => {
      const links: string[] = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').trim();
        if (href && (href.includes('.pdf') || href.includes('.zip') || href.includes('.xlsx') ||
            href.includes('.mp3') || href.includes('.mp4') || text.includes('material') ||
            text.includes('download') || text.includes('aula') || text.includes('PDF') ||
            text.includes('Estudo') || text.includes('Audiobook') || text.includes('Formatacao'))) {
          links.push(`${text} | ${href}`);
        }
      });
      return links;
    });

    const apiMaterials = await page.evaluate(async () => {
      try {
        const resp = await fetch('/api/auth/home/materials/');
        if (resp.ok) {
          const data = await resp.json();
          return Array.isArray(data) ? data.map((m: any) => m.name || m.fileName || JSON.stringify(m)) : [];
        }
      } catch {}
      return [];
    });

    materials.push(...assetLinks, ...apiMaterials.map((m: string) => `API: ${m}`));
  } catch (e) {
    materials.push(`ERROR: ${e.message}`);
  }
  return [...new Set(materials)];
}

async function main() {
  console.log('=== FASE 4: Focused Asset Discovery Diagnostics ===\n');

  const authFile = 'storage/auth/themembers.json';
  if (!existsSync(authFile)) {
    console.error('No auth file found. Run login first.');
    process.exit(1);
  }

  const results: DiagnosticResult[] = [];

  const { browser, context, page } = await createBrowserContext(
    `file://${authFile}`,
    'themembers'
  );

  try {
    for (const courseSlug of TARGET_COURSES) {
      const manifestFile = join(MANIFEST_DIR, `${courseSlug}.json`);
      if (!existsSync(manifestFile)) {
        console.log(`SKIP: ${courseSlug} - manifest not found`);
        continue;
      }

      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const courseUrl = manifest.url;
      console.log(`\n--- ${courseSlug} ---`);
      console.log(`URL: ${courseUrl}`);
      console.log(`Modules: ${manifest.modules?.length || 0}`);

      const courseResult: DiagnosticResult = {
        course: courseSlug,
        courseUrl,
        modules: []
      };

      try {
        await page.goto(courseUrl, { timeout: 20000, waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        for (let mi = 0; mi < (manifest.modules?.length || 0); mi++) {
          const mod = manifest.modules[mi];
          console.log(`  Module ${mi + 1}: ${mod.name}`);
          console.log(`    URL: ${mod.url}`);

          const modResult = {
            name: mod.name,
            url: mod.url || '',
            lessons: [] as DiagnosticResult['modules'][0]['lessons']
          };

          try {
            if (mod.url) {
              await page.goto(mod.url, { timeout: 15000, waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(1000);
            }
          } catch (e) {
            console.log(`    ERROR loading module: ${e.message}`);
          }

          for (let li = 0; li < (mod.lessons?.length || 0); li++) {
            const lesson = mod.lessons[li];
            console.log(`    Lesson ${li + 1}: ${lesson.name}`);
            console.log(`      URL: ${lesson.url}`);

            const assets = await extractMaterialsFromLesson(page, lesson.url, lesson.name);
            console.log(`      Materials found: ${assets.length}`);
            assets.forEach(a => console.log(`        - ${a.substring(0, 100)}`));

            modResult.lessons.push({
              name: lesson.name,
              url: lesson.url,
              assetsFound: assets.filter(a => !a.startsWith('ERROR')),
              assetLinks: assets
            });
          }

          courseResult.modules.push(modResult);
        }
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
      }

      results.push(courseResult);
    }

    writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`\n\nResults written to: ${OUTPUT_FILE}`);

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });