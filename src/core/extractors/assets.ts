import path from 'node:path';
import type { Page } from 'playwright';
import type { Asset, AssetType } from '../types';
import { cleanName } from '../utils/slug';

const audioExtensions = new Set(['.mp3', '.wav', '.m4a', '.ogg']);
const documentExtensions = new Set(['.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const ignoredAssetPatterns = [
  /assets\.themembers\.com\.br\/profile\//i,
  /assets\.themembers\.com\.br\/banner_lesson\//i,
  /emoji-datasource/i,
  /\/images\/icons\//i,
  /\/avatar/i,
  /\/profile\//i
];

export function classifyAsset(url: string): AssetType {
  const ext = path.extname(new URL(url, 'https://placeholder.local').pathname).toLowerCase();
  if (audioExtensions.has(ext)) return 'audio';
  if (documentExtensions.has(ext)) return 'document';
  if (imageExtensions.has(ext)) return 'image';
  if (/^https?:\/\//i.test(url)) return 'external-link';
  return 'unknown';
}

export function assetNameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const basename = path.basename(parsed.pathname);
    return cleanName(decodeURIComponent(basename || fallback), fallback);
  } catch {
    return cleanName(fallback);
  }
}

function isIgnoredUiAsset(url: string): boolean {
  return ignoredAssetPatterns.some((pattern) => pattern.test(url));
}

function isRelevantExternalAsset(url: string): boolean {
  return /drive\.google\.com|docs\.google\.com/i.test(url);
}

/**
 * Find the DOM scope that belongs to the current lesson.
 * Strategy:
 * 1. Look for a heading that matches the lesson name.
 * 2. Walk up to find a content container that is NOT nav/aside/sidebar.
 * 3. If no container found, create a virtual boundary from the lesson heading
 *    to the next lesson heading or section break.
 */
function findLessonScope(root: Document, lessonName?: string): Element | null {
  const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4'));

  // Try to match by lesson name first
  let lessonHeading: Element | null = null;
  if (lessonName) {
    const normalizedLesson = lessonName.toLowerCase().replace(/\s+/g, ' ').trim();
    lessonHeading =
      headings.find((h) => {
        const text = (h.textContent ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
        return text === normalizedLesson || text.includes(normalizedLesson) || normalizedLesson.includes(text);
      }) ?? null;
  }

  // Fallback: first heading that looks like a lesson
  if (!lessonHeading) {
    lessonHeading =
      headings.find((h) => /aula|conteúdo|lesson|class\b/i.test(h.textContent ?? '')) ?? null;
  }

  if (!lessonHeading) return null;

  // Walk up looking for a content container
  let container: Element | null = lessonHeading;
  const excludedTags = new Set(['NAV', 'ASIDE', 'HEADER', 'FOOTER']);
  const excludedClasses = /sidebar|sidenav|menu|navigation|nav-|global-|header|footer/i;

  while (container && container !== root.body) {
    const tag = container.tagName;
    const classAttr = container.getAttribute('class') ?? '';
    const role = container.getAttribute('role') ?? '';

    if (
      !excludedTags.has(tag) &&
      !excludedClasses.test(classAttr) &&
      role !== 'navigation' &&
      role !== 'complementary'
    ) {
      // Prefer semantic content containers
      if (
        tag === 'ARTICLE' ||
        tag === 'MAIN' ||
        tag === 'SECTION' ||
        /content|lesson|aula|material|body/i.test(classAttr)
      ) {
        return container;
      }
    }
    container = container.parentElement;
  }

  // Last resort: use body but we'll filter by position
  return root.body;
}

/**
 * Check if an element is visually/logically inside the lesson scope.
 * If scope is body, we use position-based filtering.
 */
function isInsideLessonScope(element: Element, lessonHeading: Element | null, scope: Element): boolean {
  if (scope !== document.body) {
    return scope.contains(element);
  }

  // Position-based filtering when scope is body
  if (!lessonHeading) return true;

  const position = lessonHeading.compareDocumentPosition(element);
  const isAfterHeading = (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  if (!isAfterHeading) return false;

  // Stop at next lesson-like heading
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'));
  const headingIndex = headings.indexOf(lessonHeading);
  for (let i = headingIndex + 1; i < headings.length; i += 1) {
    const nextHeading = headings[i];
    if (!nextHeading) continue;
    const nextText = (nextHeading.textContent ?? '').toLowerCase();
    if (/aula\s*\d|módulo\s*\d|modulo\s*\d|lesson\s*\d|próxima aula| próximo módulo/i.test(nextText)) {
      const nextPos = lessonHeading.compareDocumentPosition(nextHeading);
      const elemPos = lessonHeading.compareDocumentPosition(element);
      if ((nextPos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          (elemPos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          nextHeading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
        // element is after nextHeading — outside scope
        return false;
      }
      break;
    }
  }

  return true;
}

export async function extractLessonContentFromPage(
  page: Page,
  lessonName?: string
): Promise<{
  description: string;
  links: string[];
  assets: Asset[];
}> {
  const result = await page.evaluate((name) => {
    const pickText = (element: Element | null) =>
      (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20_000);

    function findLessonScope(root: Document, lessonName?: string): Element | null {
      if (!lessonName) return null;
      const headings = root.querySelectorAll('h1, h2, h3, h4');
      const normName = lessonName.toLowerCase().replace(/\s+/g, ' ').trim();
      for (const h of headings) {
        const text = (h.textContent ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (text === normName || text.includes(normName) || normName.includes(text)) {
          let current: Element | null = h;
          while (current && !current.classList.contains('lesson') && !current.classList.contains('container') && !current.classList.contains('content')) {
            current = current.parentElement;
          }
          return current ?? h;
        }
      }
      return null;
    }

    function isInsideLessonScope(element: Element, lessonHeading: Element | null, scope: Element): boolean {
      if (scope !== document.body) {
        return scope.contains(element);
      }
      if (!lessonHeading) return true;
      const position = lessonHeading.compareDocumentPosition(element);
      const isAfterHeading = (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (!isAfterHeading) return false;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'));
      const headingIndex = headings.indexOf(lessonHeading);
      for (let i = headingIndex + 1; i < headings.length; i += 1) {
        const nextHeading = headings[i];
        if (!nextHeading) continue;
        const nextText = (nextHeading.textContent ?? '').toLowerCase();
        if (/aula\s*\d|módulo\s*\d|modulo\s*\d|lesson\s*\d|próxima aula| próximo módulo/i.test(nextText)) {
          const nextPos = lessonHeading.compareDocumentPosition(nextHeading);
          const elemPos = lessonHeading.compareDocumentPosition(element);
          if ((nextPos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
              (elemPos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
              nextHeading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return false;
          }
          break;
        }
      }
      return true;
    }

    const rawScope = findLessonScope(document, name);
    const scope = rawScope ?? document.body;
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'));
    const lessonHeading =
      (name
        ? headings.find((h) => {
            const text = (h.textContent ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
            const norm = name.toLowerCase().replace(/\s+/g, ' ').trim();
            return text === norm || text.includes(norm) || norm.includes(text);
          })
        : null) ??
      headings.find((h) => /aula|conteúdo|lesson|class\b/i.test(h.textContent ?? '')) ??
      null;

    // --- DESCRIPTION ---
    const descriptionParts: string[] = [];
    if (lessonHeading) {
      const allParagraphs = Array.from(
        scope.querySelectorAll('p, li, a, div, section, article')
      );
      for (const element of allParagraphs) {
        if (!isInsideLessonScope(element, lessonHeading, scope)) continue;
        const position = lessonHeading.compareDocumentPosition(element);
        if ((position & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue;
        const text = pickText(element);
        if (!text) continue;
        if (/Comentários|Dúvidas|Adicionar um comentário|Aulas\s*•|Material complementar/i.test(text)) break;
        if (/Notificações|Marcar todas como lidas|você tem uma nova dúvida/i.test(text)) continue;
        if (text === pickText(lessonHeading)) continue;
        if (descriptionParts.includes(text)) continue;
        descriptionParts.push(text);
        if (descriptionParts.join('\n\n').length > 4_000) break;
      }
    }
    const description = descriptionParts.join('\n\n') || pickText(lessonHeading) || '';

    // --- MATERIAL NAMES (scoped) ---
    const materialNames = new Set<string>();
    const materialFilePattern =
      /^[\p{L}\p{N}][\p{L}\p{N}\s._()'+-]{0,158}\.(?:pdf|zip|docx?|xlsx?|pptx?|mp3|m4a|wav|ogg)$/iu;
    const normalizeMaterialName = (value: string) =>
      value
        .replace(/^.*Material complementar/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Only look inside scope, excluding children of sidebars/nav
    const scopeTextElements = Array.from(
      scope.querySelectorAll('p, span, a, button, div')
    ).filter((el) => {
      const tag = el.tagName;
      const cls = el.getAttribute('class') ?? '';
      if (tag === 'NAV' || tag === 'ASIDE') return false;
      if (/sidebar|sidenav|menu|navigation|nav-|global-/i.test(cls)) return false;
      if (!isInsideLessonScope(el, lessonHeading, scope)) return false;
      return true;
    });

    for (const element of scopeTextElements) {
      if (element.children.length > 0) continue;
      const text = pickText(element);
      if (materialFilePattern.test(text)) materialNames.add(text);
    }

    const materialContainers = Array.from(
      scope.querySelectorAll('div, section, article')
    ).filter((el) => {
      if (!/Material complementar/i.test(pickText(el))) return false;
      if (!isInsideLessonScope(el, lessonHeading, scope)) return false;
      return !Array.from(el.children).some((child) => /Material complementar/i.test(pickText(child)));
    });

    for (const container of materialContainers) {
      const matches =
        pickText(container).match(/[^\n]+?\.(?:pdf|zip|docx?|xlsx?|pptx?|mp3|m4a|wav|ogg)\b/gi) ?? [];
      for (const match of matches) {
        const materialName = normalizeMaterialName(match);
        if (materialName && materialName.length <= 160) materialNames.add(materialName);
      }
    }

    // --- URLS (scoped) ---
    const values = new Set<string>();
    const urlElements = Array.from(
      scope.querySelectorAll('a[href], audio[src], source[src], img[src]')
    ).filter((el) => isInsideLessonScope(el, lessonHeading, scope));

    for (const anchor of urlElements.filter((el) => el.tagName === 'A')) {
      values.add((anchor as HTMLAnchorElement).href);
    }
    for (const audio of urlElements.filter((el) => el.tagName === 'AUDIO')) {
      values.add((audio as HTMLAudioElement).src);
    }
    for (const source of urlElements.filter((el) => el.tagName === 'SOURCE')) {
      values.add((source as HTMLSourceElement).src);
    }
    for (const img of urlElements.filter((el) => el.tagName === 'IMG')) {
      values.add((img as HTMLImageElement).src);
    }

    return {
      description,
      materialNames: Array.from(materialNames),
      urls: Array.from(values)
    };
  }, lessonName);

  const { description, materialNames, urls } = result;

  const links = urls.filter((url) => classifyAsset(url) === 'external-link' && isRelevantExternalAsset(url));
  const assets = urls
    .filter((url) => !isIgnoredUiAsset(url))
    .map((url, index): Asset => {
      const type = classifyAsset(url);
      return {
        type,
        name: assetNameFromUrl(url, `asset-${index + 1}`),
        url,
        sha256: null,
        status: type === 'external-link' ? 'skipped' : 'pending',
        uploadStatus: 'pending'
      };
    })
    .filter((asset) => asset.type !== 'image')
    .filter((asset) => asset.type !== 'external-link' || isRelevantExternalAsset(asset.url));

  for (const materialName of materialNames) {
    if (assets.some((asset) => asset.name === materialName)) continue;
    assets.push({
      type: classifyAsset(materialName),
      name: assetNameFromUrl(materialName, materialName),
      url: `unresolved://${encodeURIComponent(materialName)}`,
      sha256: null,
      status: 'failed',
      uploadStatus: 'pending',
      lastError: 'Material appears in the lesson page, but no downloadable URL was exposed in the DOM.'
    });
  }

  return { description, links, assets };
}

/**
 * Check if a material from the API response is likely present in the current lesson DOM.
 * Used to filter out API materials that belong to other lessons.
 */
export function isMaterialVisibleInLessonScope(
  materialName: string,
  pageText: string
): boolean {
  const normalized = materialName.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = pageText.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.includes(normalized);
}
