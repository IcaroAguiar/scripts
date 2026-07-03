import path from 'node:path';
import fs from 'fs-extra';
import type { BrowserContext, Page, Response } from 'playwright';
import { fillLoginForm, persistStorageState } from '../../core/auth/session';
import { createBrowserContext, expandAccordions, scrollToBottom, waitForHydration } from '../../core/browser/browser';
import { loadEnv } from '../../core/config/env';
import { assetNameFromUrl, classifyAsset, extractLessonContentFromPage } from '../../core/extractors/assets';
import { Logger } from '../../core/logger/logger';
import type { Asset, CourseManifest, CourseRef, LessonManifest, PlatformAdapter, RuntimeContext } from '../../core/types';
import { slugify } from '../../core/utils/slug';

function absoluteUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl).toString();
}

function isCourseUrl(url: string, text: string): boolean {
  const value = `${url} ${text}`;
  return /\/curso\/|\/course\/|\/courses\//i.test(url) && !/dashboard|homepage|favoritos|community/i.test(value);
}

function isLessonUrl(url: string, text: string): boolean {
  const value = `${url} ${text}`;
  return /\/curso\/.*\/aula-|\/aula\/|\/lesson\/|\/conteudo\/|\/content\/|watch/i.test(value);
}

async function linkCandidates(page: Page, patterns: RegExp[]): Promise<CourseRef[]> {
  const anchors = page.locator('a[href]');
  const count = await anchors.count();
  const courses = new Map<string, CourseRef>();

  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    const href = await anchor.getAttribute('href');
    const text = (await anchor.innerText().catch(() => '')).trim();
    if (!href) continue;
    const url = absoluteUrl(href, page.url());
    const name = text || nameFromCourseUrl(url);
    if (!patterns.some((pattern) => pattern.test(url) || pattern.test(text))) continue;
    if (!isCourseUrl(url, name)) continue;
    courses.set(url, { id: slugify(name || url), name: name || url, url });
  }

  return Array.from(courses.values());
}

function nameFromCourseUrl(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const routeIndex = parts.findIndex((part) => part === 'courses' || part === 'curso');
  const slug = routeIndex >= 0 ? parts[routeIndex + 2] : undefined;
  return slug ? slug.replace(/-/g, ' ') : url;
}

async function coursesFromSelect(page: Page): Promise<CourseRef[]> {
  const orgId = await page.evaluate(() => {
    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((anchor) => anchor.href);
    for (const href of hrefs) {
      const match = href.match(/\/(?:courses|curso)\/([^/]+)\//);
      if (match?.[1]) return match[1];
    }
    return null;
  });

  if (!orgId) return [];

  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLOptionElement>('select option'))
      .map((option) => ({ name: option.textContent?.replace(/\s+/g, ' ').trim() ?? '', id: option.value }))
      .filter((option) => option.name && option.id)
  );

  const origin = new URL(page.url()).origin;
  return options.map((option) => ({
    id: slugify(option.name),
    name: option.name,
    url: `${origin}/courses/${orgId}/${slugify(option.name)}/${option.id}`
  }));
}

async function extractPageLinks(page: Page): Promise<Array<{ name: string; url: string }>> {
  const baseUrl = page.url();
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((anchor) => ({
      name: anchor.innerText.trim() || anchor.getAttribute('aria-label') || anchor.title || anchor.href,
      href: anchor.href
    }))
  );

  return links
    .filter((link) => link.href && link.name)
    .map((link) => ({ name: link.name, url: absoluteUrl(link.href, baseUrl) }));
}

async function firstLinkUrl(page: Page, selector: string): Promise<string | null> {
  return page
    .locator(selector)
    .first()
    .getAttribute('href', { timeout: 3_000 })
    .then((href) => (href ? absoluteUrl(href, page.url()) : null))
    .catch(() => null);
}

async function allLinksUrl(page: Page, selector: string): Promise<string[]> {
  const hrefs = await page.locator(selector).evaluateAll((elements) =>
    elements.map((el) => el.getAttribute('href')).filter((href): href is string => !!href)
  );
  return hrefs.map((href) => absoluteUrl(href, page.url()));
}

async function moduleNameFromPage(page: Page, fallback: string): Promise<string> {
  const moduleUrl = page.url();
  const urlMatch = moduleUrl.match(/\/modulo[s]?-(\d+)/i);
  const moduleOrder = urlMatch ? urlMatch[1].padStart(2, '0') : null;

  const domName = await page
    .locator('h2, h1, a[href*="/modulos/"]')
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .find((text) => /módulo|modulo/i.test(text))
    )
    .catch(() => null);

  if (domName && moduleOrder) {
    return `Módulo ${moduleOrder} - ${domName}`;
  }
  if (domName) return domName;
  if (moduleOrder) return `Módulo ${moduleOrder}`;
  return fallback;
}

async function lessonLinksFromModulePage(page: Page): Promise<Array<{ name: string; url: string }>> {
  const links = await page.evaluate(() => {
    const deriveLessonName = (anchor: HTMLAnchorElement): string => {
      const explicitTitle =
        anchor.getAttribute('title')?.trim() ||
        anchor.getAttribute('aria-label')?.trim() ||
        anchor.querySelector<HTMLElement>('h1, h2, h3, h4, strong, [class*="title"], [class*="name"]')?.innerText?.trim();
      if (explicitTitle) return explicitTitle.replace(/\s+/g, ' ').trim();

      const lines = (anchor.textContent ?? '')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const aulaLine = lines.find((line) => /aula\s*\d+/i.test(line));
      if (aulaLine) return aulaLine;
      const shortest = [...lines].sort((a, b) => a.length - b.length)[0];
      if (shortest) return shortest;
      return '';
    };

    const result: Array<{ name: string; href: string }> = [];
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const href = anchor.href;
      if (!/\/curso\/.*\/aula-/i.test(href)) continue;
      result.push({
        name: deriveLessonName(anchor).replace(/^lesson banner\s*/i, ''),
        href
      });
      if (result.length >= 500) break;
    }
    return result;
  });

  const seen = new Set<string>();
  return links
    .map((link) => ({
      name: link.name || nameFromCourseUrl(link.href),
      url: absoluteUrl(link.href, page.url())
    }))
    .filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
}

async function lessonLinksFromModulePageWithTimeout(
  page: Page,
  timeoutMs: number
): Promise<Array<{ name: string; url: string }>> {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      lessonLinksFromModulePage(page),
      new Promise<Array<{ name: string; url: string }>>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`lesson link extraction timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function gotoDomContentLoaded(page: Page, url: string, timeoutMs = 15_000): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
}

function isResolvableMaterial(asset: Asset): boolean {
  return asset.url.startsWith('unresolved://');
}

function isSignedMaterialUrl(url: string): boolean {
  return /cloudflarestorage\.com|\/material\//i.test(url) && /X-Amz-Signature=/i.test(url);
}

function comparableMaterialName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

type RawMaterial = { name: string; url: string };

function rawMaterialsToAssets(materials: RawMaterial[]): Asset[] {
  return materials.map((material, index): Asset => {
    const type = classifyAsset(material.url);
    return {
      type,
      name: material.name.replace(/_/g, ' ') || assetNameFromUrl(material.url, `material-${index + 1}`),
      url: material.url,
      sha256: null,
      status: type === 'external-link' ? 'skipped' : 'pending',
      uploadStatus: 'pending'
    };
  });
}

async function materialsFromResponse(response: Response): Promise<RawMaterial[]> {
  if (!response.url().includes('/api/auth/home/materials/')) return [];
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => ({
      name:
        typeof item?.material_name === 'string'
          ? item.material_name
          : typeof item?.name === 'string'
            ? item.name
            : '',
      url:
        typeof item?.material_url === 'string'
          ? item.material_url
          : typeof item?.url === 'string'
            ? item.url
            : ''
    }))
    .filter((item) => item.name && item.url);
}

function watchMaterialResponses(page: Page): { stop(): void; assets(): Asset[] } {
  const materials: RawMaterial[] = [];
  const seen = new Set<string>();
  const onResponse = async (response: Response) => {
    for (const material of await materialsFromResponse(response)) {
      const key = `${material.name}\n${material.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      materials.push(material);
    }
  };
  page.on('response', onResponse);
  return {
    stop: () => page.off('response', onResponse),
    assets: () => rawMaterialsToAssets(materials)
  };
}

interface DomMaterialsProbe {
  names: string[];
  debug: {
    lessonName: string;
    pageUrl: string;
    headingText: string | null;
    containerTag: string | null;
    containerClass: string | null;
    candidateCount: number;
    rawCandidates: Array<{ tag: string; className: string; text: string }>;
  };
}

async function stabilizeMaterialsPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const heading = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, strong'))
      .find((el) => /material complementar/i.test(normalize(el.innerText || el.textContent || '')));
    if (!heading) return;

    const isScrollable = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 8;
    let scrollable: HTMLElement | null = null;
    for (let node: HTMLElement | null = heading.parentElement; node; node = node.parentElement) {
      if (isScrollable(node)) {
        scrollable = node;
        break;
      }
    }
    if (!scrollable) return;

    const target = scrollable;
    target.scrollTop = target.scrollHeight;
    target.scrollTop = 0;
  });
  await page.waitForTimeout(200);
}

async function extractDomMaterialNames(page: Page, lessonName: string): Promise<DomMaterialsProbe> {
  const pageUrl = page.url();
  const probe = await page.evaluate((currentLessonName) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const lessonPattern = /aula\s*\d+/i;
    const uiNoisePattern =
      /\b(in[ií]cio|favoritos|comunidade|conclu[ií]d[ao]|ir para|pr[oó]ximo m[oó]dulo|curtir|coment[áa]rios|d[uú]vidas)\b/i;
    const isVisible = (el: HTMLElement) => {
      if (!el.isConnected) return false;
      if (el.closest('script, style, noscript, template')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const materialHeadingCandidates = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, strong'))
      .filter((el) => isVisible(el))
      .filter((el) => /material complementar/i.test(normalize(el.innerText || el.textContent || '')))
      .sort((a, b) => {
        const lenA = normalize(a.innerText || a.textContent || '').length;
        const lenB = normalize(b.innerText || b.textContent || '').length;
        return lenA - lenB;
      });
    const heading = materialHeadingCandidates[0] ?? null;
    if (!heading) {
      return {
        names: [],
        headingText: null,
        containerTag: null,
        containerClass: null,
        candidateCount: 0,
        rawCandidates: []
      };
    }

    const hasMaterialLikeChildren = (el: HTMLElement) =>
      el.querySelectorAll(
        'button, a, [role="button"], li, [data-testid*="material"], [class*="material"], [class*="download"], [aria-label*="download"]'
      ).length > 0;

    let container: HTMLElement | null = null;
    for (let sibling = heading.nextElementSibling as HTMLElement | null; sibling; sibling = sibling.nextElementSibling as HTMLElement | null) {
      if (!isVisible(sibling)) continue;
      const text = normalize(sibling.innerText || sibling.textContent || '');
      if (!text) continue;
      if (/coment[áa]rios|d[uú]vidas/i.test(text)) continue;
      if (hasMaterialLikeChildren(sibling)) {
        container = sibling;
        break;
      }
    }
    if (!container && heading.parentElement && hasMaterialLikeChildren(heading.parentElement)) {
      container = heading.parentElement;
    }
    if (!container) {
      container = heading.parentElement ?? heading.closest('section, article, aside, div') ?? document.body;
    }

    const candidates = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button, a, [role="button"], li, [data-testid*="material"], [class*="material"], [class*="download"], [aria-label*="download"]'
      )
    );
    const names: string[] = [];
    const seen = new Set<string>();
    const rawCandidates: Array<{ tag: string; className: string; text: string }> = [];

    for (const element of candidates) {
      const line = normalize(element.innerText || element.textContent || '')
        .replace(/^material complementar\s*/i, '');
      rawCandidates.push({
        tag: element.tagName,
        className: (element.getAttribute('class') ?? '').slice(0, 200),
        text: line.slice(0, 300)
      });
      if (!line || uiNoisePattern.test(line)) continue;
      if (/^material complementar$/i.test(line)) continue;
      if (line.length < 4 || line.length > 220) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      if (lessonPattern.test(line) && !/\.(pdf|zip|xlsx|xls|doc|docx|ppt|pptx|mp3|mp4)\b/i.test(line)) continue;
      seen.add(key);
      names.push(line);
    }

    // Fallback estrutural no container local, sem varrer página inteira.
    if (names.length === 0) {
      const rows = Array.from(container.querySelectorAll<HTMLElement>('div, span, p, strong'))
        .map((el) => normalize(el.innerText || el.textContent || ''))
        .filter(Boolean)
        .filter((line) => !uiNoisePattern.test(line))
        .filter((line) => !/^material complementar$/i.test(line))
        .filter((line) => line.length >= 4 && line.length <= 220)
        .filter((line) => !lessonPattern.test(line) || /\.(pdf|zip|xlsx|xls|doc|docx|ppt|pptx|mp3|mp4)\b/i.test(line));
      for (const row of rows) {
        const key = row.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(row);
      }
    }

    return {
      names,
      headingText: normalize(heading.innerText || heading.textContent || ''),
      containerTag: container.tagName,
      containerClass: (container.getAttribute('class') ?? '').slice(0, 200),
      candidateCount: candidates.length,
      rawCandidates
    };
  }, lessonName);

  return {
    names: probe.names,
    debug: {
      lessonName,
      pageUrl,
      headingText: probe.headingText,
      containerTag: probe.containerTag,
      containerClass: probe.containerClass,
      candidateCount: probe.candidateCount,
      rawCandidates: probe.rawCandidates
    }
  };
}

async function ensureOnExpectedLessonPage(
  page: Page,
  lessonUrl: string,
  logger: Logger,
  courseUrl?: string
): Promise<void> {
  const expected = new URL(lessonUrl);
  let current = new URL(page.url());
  let samePath = current.pathname === expected.pathname;
  if (samePath) return;

  await logger.log('RETRY', 'lesson page mismatch, forcing direct lesson navigation', {
    expected: expected.href,
    current: current.href
  });
  await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForHydration(page);

  current = new URL(page.url());
  samePath = current.pathname === expected.pathname;
  if (samePath) return;

  if (courseUrl) {
    await logger.log('RETRY', 'lesson page still mismatched after direct goto, retrying via course flow', {
      expected: expected.href,
      current: current.href
    });
    await gotoLessonFromCourseFlow(page, lessonUrl, courseUrl);
    await waitForHydration(page);
    current = new URL(page.url());
    samePath = current.pathname === expected.pathname;
    if (samePath) return;
  }

  throw new Error(`Unable to lock lesson context. Expected ${expected.pathname}, got ${current.pathname}`);
}

async function saveDomMaterialsDebug(debug: DomMaterialsProbe['debug']): Promise<void> {
  if (process.env.MATERIALS_DOM_DEBUG !== '1') return;
  const dir = path.join('storage', 'logs', 'dom-materials-debug');
  await fs.ensureDir(dir);
  const safeLesson = slugify(debug.lessonName).slice(0, 80) || 'lesson';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${safeLesson}.json`);
  await fs.writeJson(file, debug, { spaces: 2 });
}

function buildCanonicalAssetsFromDomNames(domMaterialNames: string[]): Asset[] {
  return domMaterialNames.map((name) => ({
    type: classifyAsset(name),
    name: assetNameFromUrl(name, name),
    url: `unresolved://${encodeURIComponent(name)}`,
    sha256: null,
    status: 'failed',
    uploadStatus: 'pending',
    lastError: 'Material appears in lesson DOM, but no downloadable URL was captured yet.'
  }));
}

function enrichCanonicalAssetsWithApi(
  assets: Asset[],
  links: string[],
  apiAssets: Asset[]
): { matchedCount: number; discardedApiNames: string[] } {
  let matchedCount = 0;
  const discardedApiNames: string[] = [];
  for (const apiAsset of apiAssets) {
    const existing = assets.find(
      (asset) =>
        comparableMaterialName(asset.name) === comparableMaterialName(apiAsset.name) ||
        comparableMaterialName(asset.name) === comparableMaterialName(assetNameFromUrl(apiAsset.url, apiAsset.name))
    );

    if (!existing) {
      discardedApiNames.push(apiAsset.name);
      continue;
    }

    existing.type = apiAsset.type;
    existing.name = apiAsset.name;
    existing.url = apiAsset.url;
    existing.status = apiAsset.status;
    existing.lastError = undefined;
    matchedCount += 1;

    if (apiAsset.type === 'external-link' && /drive\.google\.com|docs\.google\.com/i.test(apiAsset.url)) {
      links.push(apiAsset.url);
    }
  }
  return { matchedCount, discardedApiNames };
}

function buildCanonicalAssetsFromApi(apiAssets: Asset[]): Asset[] {
  const seen = new Set<string>();
  const canonical: Asset[] = [];
  for (const asset of apiAssets) {
    const key = `${comparableMaterialName(asset.name)}|${asset.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push({
      ...asset,
      status: asset.type === 'external-link' ? 'skipped' : 'pending',
      uploadStatus: 'pending'
    });
  }
  return canonical;
}

function chooseMaterialsSource(params: {
  domCount: number;
  apiCount: number;
  matchedCountIfDom: number;
}): { source: 'dom' | 'api-fallback'; reason?: string } {
  const { domCount } = params;
  if (domCount === 0) return { source: 'api-fallback', reason: 'dom-empty -> api-fallback' };
  return { source: 'dom' };
}

async function extractLessonInIsolatedPage(
  browserContext: BrowserContext,
  lessonUrl: string,
  lessonName: string,
  logger: Logger
): Promise<Awaited<ReturnType<typeof extractLessonContentFromPage>>> {
  const lessonPage = await browserContext.newPage();
  lessonPage.setDefaultTimeout(15_000);
  lessonPage.setDefaultNavigationTimeout(20_000);
  let timeout: Timer | undefined;

  try {
    const work = (async () => {
      await lessonPage.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await waitForHydration(lessonPage);
      await ensureOnExpectedLessonPage(lessonPage, lessonUrl, logger);

      const materialWatcher = watchMaterialResponses(lessonPage);
      try {
        await expandAccordions(lessonPage);
        await scrollToBottom(lessonPage);
        await stabilizeMaterialsPanel(lessonPage);
        await lessonPage.waitForTimeout(800);
        await ensureOnExpectedLessonPage(lessonPage, lessonUrl, logger);

        const content = await extractLessonContentFromPage(lessonPage, lessonName);
        const apiAssets = materialWatcher.assets();
        const domProbe = await extractDomMaterialNames(lessonPage, lessonName);
        await saveDomMaterialsDebug(domProbe.debug);
        const domMaterialNames = domProbe.names;
        const domCanonicalAssets = buildCanonicalAssetsFromDomNames(domMaterialNames);
        const domEnrichmentProbe =
          domMaterialNames.length > 0
            ? enrichCanonicalAssetsWithApi(
                domCanonicalAssets.map((asset) => ({ ...asset })),
                [...content.links],
                apiAssets
              )
            : { matchedCount: 0, discardedApiNames: [] as string[] };
        const sourceDecision = chooseMaterialsSource({
          domCount: domMaterialNames.length,
          apiCount: apiAssets.length,
          matchedCountIfDom: domEnrichmentProbe.matchedCount
        });
        const materialsSource = sourceDecision.source;
        const canonicalAssets =
          materialsSource === 'dom'
            ? buildCanonicalAssetsFromDomNames(domMaterialNames)
            : buildCanonicalAssetsFromApi(apiAssets);
        const { matchedCount, discardedApiNames } =
          materialsSource === 'dom'
            ? enrichCanonicalAssetsWithApi(canonicalAssets, content.links, apiAssets)
            : { matchedCount: apiAssets.length, discardedApiNames: [] as string[] };
        if (process.env.DOWNLOAD_DEBUG === '1') {
          await logger.log('DISCOVER', 'dom-first materials audit', {
            lesson: lessonName,
            materialsSource,
            domMaterialsCount: domMaterialNames.length,
            apiMaterialsCapturedCount: apiAssets.length,
            apiMatchedToDomCount: matchedCount,
            apiDiscardedNotInDomCount: discardedApiNames.length,
            discardedApiNames,
            fallbackReason: sourceDecision.reason
          });
        } else {
          await logger.log('DISCOVER', 'dom-first materials audit', {
            lesson: lessonName,
            materialsSource,
            domMaterialsCount: domMaterialNames.length,
            apiMaterialsCapturedCount: apiAssets.length,
            apiMatchedToDomCount: matchedCount,
            apiDiscardedNotInDomCount: discardedApiNames.length,
            fallbackReason: sourceDecision.reason
          });
        }

        const beforeClickResolved = canonicalAssets.filter((asset) => !asset.url.startsWith('unresolved://')).length;
        await resolveClickableMaterials(lessonPage, canonicalAssets, logger);
        const resolvedCount = canonicalAssets.filter((asset) => !asset.url.startsWith('unresolved://')).length;
        const unresolvedCount = canonicalAssets.filter((asset) => asset.url.startsWith('unresolved://')).length;
        const clickResolvedCount = Math.max(0, resolvedCount - beforeClickResolved);
        await logger.log('DISCOVER', 'dom-first materials final', {
          lesson: lessonName,
          materialsSource,
          finalMaterialsCount: canonicalAssets.length,
          resolvedCount,
          unresolvedCount,
          clickResolvedCount
        });
        content.assets = canonicalAssets;
        return content;
      } finally {
        materialWatcher.stop();
      }
    })();

    return await Promise.race([
      work,
      new Promise<Awaited<ReturnType<typeof extractLessonContentFromPage>>>((_, reject) => {
        timeout = setTimeout(async () => {
          await lessonPage.close().catch(() => undefined);
          reject(new Error('lesson extraction timed out after 30000ms'));
        }, 30_000);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await lessonPage.close().catch(() => undefined);
  }
}

async function resolveClickableMaterials(page: Page, assets: Asset[], logger: Logger): Promise<void> {
  for (const asset of assets.filter(isResolvableMaterial)) {
    const material = page
      .locator('button, a, [role="button"], li, div, span', { hasText: asset.name })
      .first();
    if ((await material.count()) === 0) {
      asset.lastError = `Material appears in extracted text, but clickable element was not found: ${asset.name}`;
      await logger.log('FAILED', `material click target not found ${asset.name}`, { lessonUrl: page.url() });
      continue;
    }

    const capturedUrls: string[] = [];
    const capture = (url: string) => {
      if (isSignedMaterialUrl(url) && !capturedUrls.includes(url)) capturedUrls.push(url);
    };
    const onRequest = (request: { url(): string }) => capture(request.url());
    const onResponse = (response: { url(): string }) => capture(response.url());
    page.on('request', onRequest);
    page.on('response', onResponse);

    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 4_000 }).catch(() => null);
      await material.scrollIntoViewIfNeeded().catch(() => undefined);
      await material.click({ timeout: 5_000 });
      const download = await downloadPromise;
      await page.waitForTimeout(500);

      const signedUrl = capturedUrls.at(-1);
      if (!signedUrl) {
        asset.status = 'failed';
        asset.lastError = download
          ? `Material click triggered a browser download for ${download.suggestedFilename()}, but no signed Cloudflare URL was captured.`
          : 'Material click did not expose a signed Cloudflare URL.';
        await logger.log('FAILED', `material signed URL not captured ${asset.name}`, { lessonUrl: page.url() });
        continue;
      }

      asset.url = signedUrl;
      asset.status = 'pending';
      asset.lastError = undefined;
      await logger.log('DISCOVER', `resolved material URL ${asset.name}`, { lessonUrl: page.url() });
    } catch (error) {
      asset.status = 'failed';
      asset.lastError = error instanceof Error ? error.message : String(error);
      await logger.log('FAILED', `material click failed ${asset.name}`, { lessonUrl: page.url(), error: asset.lastError });
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
    }
  }
}

async function extractContentFromCurrentLessonPage(
  page: Page,
  materialWatcher: ReturnType<typeof watchMaterialResponses>,
  lessonUrl: string,
  lessonName: string,
  logger: Logger
): Promise<Awaited<ReturnType<typeof extractLessonContentFromPage>>> {
  await ensureOnExpectedLessonPage(page, lessonUrl, logger, process.env.EXTRACT_COURSE_URL);
  await waitForHydration(page);
  await expandAccordions(page);
  await scrollToBottom(page);
  await stabilizeMaterialsPanel(page);
  await ensureOnExpectedLessonPage(page, lessonUrl, logger, process.env.EXTRACT_COURSE_URL);
  const content = await extractLessonContentFromPage(page, lessonName);

  const apiAssets = materialWatcher.assets();
  const domProbe = await extractDomMaterialNames(page, lessonName);
  await saveDomMaterialsDebug(domProbe.debug);
  const domMaterialNames = domProbe.names;
  const domCanonicalAssets = buildCanonicalAssetsFromDomNames(domMaterialNames);
  const domEnrichmentProbe =
    domMaterialNames.length > 0
      ? enrichCanonicalAssetsWithApi(
          domCanonicalAssets.map((asset) => ({ ...asset })),
          [...content.links],
          apiAssets
        )
      : { matchedCount: 0, discardedApiNames: [] as string[] };
  const sourceDecision = chooseMaterialsSource({
    domCount: domMaterialNames.length,
    apiCount: apiAssets.length,
    matchedCountIfDom: domEnrichmentProbe.matchedCount
  });
  const materialsSource = sourceDecision.source;
  const canonicalAssets =
    materialsSource === 'dom'
      ? buildCanonicalAssetsFromDomNames(domMaterialNames)
      : buildCanonicalAssetsFromApi(apiAssets);
  const { matchedCount, discardedApiNames } =
    materialsSource === 'dom'
      ? enrichCanonicalAssetsWithApi(canonicalAssets, content.links, apiAssets)
      : { matchedCount: apiAssets.length, discardedApiNames: [] as string[] };
  if (process.env.DOWNLOAD_DEBUG === '1') {
    await logger.log('DISCOVER', 'dom-first materials audit', {
      lesson: lessonName,
      materialsSource,
      domMaterialsCount: domMaterialNames.length,
      apiMaterialsCapturedCount: apiAssets.length,
      apiMatchedToDomCount: matchedCount,
      apiDiscardedNotInDomCount: discardedApiNames.length,
      discardedApiNames,
      fallbackReason: sourceDecision.reason
    });
  } else {
    await logger.log('DISCOVER', 'dom-first materials audit', {
      lesson: lessonName,
      materialsSource,
      domMaterialsCount: domMaterialNames.length,
      apiMaterialsCapturedCount: apiAssets.length,
      apiMatchedToDomCount: matchedCount,
      apiDiscardedNotInDomCount: discardedApiNames.length,
      fallbackReason: sourceDecision.reason
    });
  }

  const beforeClickResolved = canonicalAssets.filter((asset) => !asset.url.startsWith('unresolved://')).length;
  await resolveClickableMaterials(page, canonicalAssets, logger);
  const resolvedCount = canonicalAssets.filter((asset) => !asset.url.startsWith('unresolved://')).length;
  const unresolvedCount = canonicalAssets.filter((asset) => asset.url.startsWith('unresolved://')).length;
  const clickResolvedCount = Math.max(0, resolvedCount - beforeClickResolved);
  await logger.log('DISCOVER', 'dom-first materials final', {
    lesson: lessonName,
    materialsSource,
    finalMaterialsCount: canonicalAssets.length,
    resolvedCount,
    unresolvedCount,
    clickResolvedCount
  });
  content.assets = canonicalAssets;
  return content;
}

async function gotoLessonFromCourseFlow(page: Page, lessonUrl: string, courseUrl: string): Promise<void> {
  const env = loadEnv();
  const homepageUrl = new URL('/homepage', env.THEMEMBERS_BASE_URL).toString();

  await page.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForHydration(page);
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForHydration(page);

  const moduleUrl = await firstLinkUrl(page, 'a[href*="/modulos/"]');
  if (moduleUrl) {
    await page.goto(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForHydration(page);
  }

  const matchedLessonHref = await page.evaluate((targetUrl) => {
    const target = new URL(targetUrl);
    const targetPath = `${target.pathname}${target.search}`;
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const match = anchors.find((anchor) => {
      const href = new URL(anchor.href);
      return href.href === target.href || `${href.pathname}${href.search}` === targetPath;
    });
    return match?.href ?? null;
  }, lessonUrl);

  if (matchedLessonHref) {
    await page.goto(matchedLessonHref, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return;
  }

  await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
}

async function extractModulesFromCoursePage(page: Page, courseUrl: string): Promise<Array<{ name: string; url: string }>> {
  const baseUrl = page.url();

  const moduleLinks = await page.evaluate(() => {
    const result: Array<{ name: string; href: string }> = [];
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const href = anchor.href;
      if (!/\/modulos\//i.test(href)) continue;
      const name = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim() || 'Módulo';
      result.push({ name, href });
    }
    return result;
  });

  const seen = new Set<string>();
  return moduleLinks
    .map((link) => ({
      name: link.name,
      url: absoluteUrl(link.href, baseUrl)
    }))
    .filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
}

export function createTheMembersAdapter(): PlatformAdapter {
  return {
    platform: 'themembers',

    async login(context: RuntimeContext): Promise<void> {
      const env = loadEnv();
      const logger = new Logger(context.logsDir);
      const { browser, context: browserContext, page } = await createBrowserContext({
        headless: false,
        storageStatePath: context.authStatePath
      });

      try {
        await page.goto(env.THEMEMBERS_BASE_URL, { waitUntil: 'domcontentloaded' });
        await waitForHydration(page);

        if (env.THEMEMBERS_EMAIL && env.THEMEMBERS_PASSWORD) {
          const filled = await fillLoginForm(page, env.THEMEMBERS_EMAIL, env.THEMEMBERS_PASSWORD);
          await logger.log('LOGIN', filled ? 'login form submitted' : 'login form not found, waiting manual login');
        } else {
          await logger.log('LOGIN', 'credentials not configured, waiting manual login');
        }

        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(3_000);
        await persistStorageState(browserContext, context.authStatePath);
        await logger.log('LOGIN', `storage state saved at ${context.authStatePath}`);
      } finally {
        await browser.close();
      }
    },

    async discoverCourses(context: RuntimeContext): Promise<CourseRef[]> {
      const env = loadEnv();
      const logger = new Logger(context.logsDir);
      if (env.THEMEMBERS_COURSE_URL) {
        return [
          {
            id: slugify(env.THEMEMBERS_COURSE_URL),
            name: nameFromCourseUrl(env.THEMEMBERS_COURSE_URL),
            url: env.THEMEMBERS_COURSE_URL
          }
        ];
      }

      const { browser, context: browserContext, page } = await createBrowserContext({
        headless: context.headless,
        storageStatePath: context.authStatePath,
        acceptDownloads: true
      });

      try {
        const homepageUrl = new URL('/homepage', env.THEMEMBERS_BASE_URL).toString();
        await page.goto(homepageUrl, { waitUntil: 'domcontentloaded' });
        await waitForHydration(page);
        await scrollToBottom(page, 30);
        const courses = new Map<string, CourseRef>();
        for (const course of await coursesFromSelect(page)) {
          courses.set(course.url, course);
        }
        for (const course of await linkCandidates(page, [/\/curso\//i, /\/courses\//i, /curso/i, /course/i])) {
          if (courses.has(course.url)) continue;
          courses.set(course.url, course);
        }
        const courseList = Array.from(courses.values());
        await logger.log('DISCOVER', `found ${courseList.length} course candidates`);
        return courseList;
      } finally {
        await browser.close();
      }
    },

    async discoverCourse(context: RuntimeContext, course: CourseRef): Promise<CourseManifest> {
      const logger = new Logger(context.logsDir);
      const { browser, context: browserContext, page } = await createBrowserContext({
        headless: context.headless,
        storageStatePath: context.authStatePath
      });

      try {
        await logger.log('DISCOVER', `course phase goto`, { course: course.name });
        await gotoDomContentLoaded(page, course.url);
        await logger.log('DISCOVER', `course phase hydration`, { course: course.name });
        await waitForHydration(page);

        // FIX: Extract ALL module links, not just the first one
        await logger.log('DISCOVER', `extracting all module links from course page`, { course: course.name });
        const moduleLinks = await extractModulesFromCoursePage(page, course.url);

        await logger.log('DISCOVER', `found ${moduleLinks.length} module links`, { course: course.name });

        const modules: CourseManifest['modules'] = [];
        const extractLessonDetails = process.env.DISCOVER_CONTENT === '1';

        // FIX: Iterate through EACH module, not just the first
        for (const [moduleIndex, moduleInfo] of moduleLinks.entries()) {
          await logger.log('DISCOVER', `processing module ${moduleIndex + 1}/${moduleLinks.length}`, {
            module: moduleInfo.name,
            url: moduleInfo.url
          });

          // Navigate to this specific module page
          await gotoDomContentLoaded(page, moduleInfo.url);
          await waitForHydration(page);

          // Extract module name from the module page
          const moduleName = await moduleNameFromPage(page, moduleInfo.name);

          // Extract lesson links from THIS module only
          const lessonLinks = await lessonLinksFromModulePageWithTimeout(page, 8_000).catch(async (error) => {
            await logger.log('FAILED', `module lesson link extraction failed`, {
              course: course.name,
              module: moduleName,
              error: error instanceof Error ? error.message : String(error)
            });
            return [];
          });

          await logger.log('DISCOVER', `module "${moduleName}" has ${lessonLinks.length} lessons`, {
            course: course.name
          });

          const lessons: LessonManifest[] = [];
          let consecutiveLessonFailures = 0;

          for (const [lessonIndex, lesson] of lessonLinks.entries()) {
            await logger.log('DISCOVER', `extracting lesson`, { lesson: lesson.name, url: lesson.url });
            try {
              if (!extractLessonDetails) {
                lessons.push({
                  name: lesson.name,
                  index: lessonIndex + 1,
                  url: lesson.url,
                  slug: slugify(lesson.name),
                  description: '',
                  links: [],
                  assets: [],
                  status: 'discovered'
                });
                continue;
              }

              const content = await extractLessonInIsolatedPage(browserContext, lesson.url, lesson.name, logger);
              lessons.push({
                name: lesson.name,
                index: lessonIndex + 1,
                url: lesson.url,
                slug: slugify(lesson.name),
                status: 'discovered',
                ...content
              });
              consecutiveLessonFailures = 0;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await logger.log('FAILED', `lesson extraction failed ${lesson.name}`, { url: lesson.url, error: message });
              consecutiveLessonFailures += 1;
              lessons.push({
                name: lesson.name,
                index: lessonIndex + 1,
                url: lesson.url,
                slug: slugify(lesson.name),
                description: '',
                links: [],
                assets: [],
                status: 'failed',
                lastError: message
              });

              if (consecutiveLessonFailures >= 10) {
                await logger.log('FAILED', `stopping module after ${consecutiveLessonFailures} consecutive lesson failures`, {
                  course: course.name,
                  module: moduleName
                });
                for (const [remainingOffset, remainingLesson] of lessonLinks.slice(lessonIndex + 1).entries()) {
                  lessons.push({
                    name: remainingLesson.name,
                    index: lessonIndex + remainingOffset + 2,
                    url: remainingLesson.url,
                    slug: slugify(remainingLesson.name),
                    description: '',
                    links: [],
                    assets: [],
                    status: 'failed',
                    lastError: `Skipped after ${consecutiveLessonFailures} consecutive lesson extraction failures.`
                  });
                }
                break;
              }
            }
          }

          if (lessons.length > 0) {
            modules.push({
              name: moduleName,
              index: modules.length + 1,
              slug: slugify(`${modules.length + 1}-${moduleName}`),
              lessons
            });
          }
        }

        // If no modules were found, create a fallback module
        if (modules.length === 0) {
          await logger.log('DISCOVER', `no modules found, creating fallback module`, { course: course.name });
          modules.push({
            name: 'Course Content',
            index: 1,
            slug: 'course-content',
            lessons: [
              {
                name: 'Discovery failed',
                index: 1,
                url: course.url,
                slug: 'discovery-failed',
                description: '',
                links: [],
                assets: [],
                status: 'failed',
                lastError: 'No module links found on course page'
              }
            ]
          });
        }

        await logger.log('DISCOVER', `course discovery complete`, {
          course: course.name,
          modules: modules.length,
          totalLessons: modules.reduce((sum, m) => sum + m.lessons.length, 0)
        });

        return {
          platform: this.platform,
          course: course.name.trim(),
          courseId: course.id,
          url: course.url,
          slug: slugify(course.name),
          discoveredAt: new Date().toISOString(),
          modules
        };
      } catch (error) {
        await logger.log('FAILED', `course lightweight discovery failed ${course.name}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          platform: this.platform,
          course: course.name.trim(),
          courseId: course.id,
          url: course.url,
          slug: slugify(course.name),
          discoveredAt: new Date().toISOString(),
          modules: [
            {
              name: 'Discovery failed',
              index: 1,
              slug: 'discovery-failed',
              lessons: [
                {
                  name: 'Discovery failed',
                  index: 1,
                  url: course.url,
                  slug: 'discovery-failed',
                  description: '',
                  links: [],
                  assets: [],
                  status: 'failed',
                  lastError: error instanceof Error ? error.message : String(error)
                }
              ]
            }
          ]
        };
      } finally {
        await browser.close();
      }
    },

    async extractLessonContent(context: RuntimeContext, lessonUrl: string, lessonName?: string) {
      const { browser, page } = await createBrowserContext({
        headless: context.headless,
        storageStatePath: context.authStatePath,
        acceptDownloads: true
      });

      try {
        const logger = new Logger(context.logsDir);
        const materialWatcher = watchMaterialResponses(page);
        try {
          const courseUrl = process.env.EXTRACT_COURSE_URL;
          if (process.env.EXTRACT_HOMEPAGE_FIRST === '1' && courseUrl) {
            await gotoLessonFromCourseFlow(page, lessonUrl, courseUrl);
          } else {
            await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          }
          await ensureOnExpectedLessonPage(page, lessonUrl, logger, courseUrl ?? undefined);
          return await extractContentFromCurrentLessonPage(page, materialWatcher, lessonUrl, lessonName ?? 'Unknown lesson', logger);
        } catch (error) {
          const courseUrl = process.env.EXTRACT_COURSE_URL;
          if (process.env.EXTRACT_HOMEPAGE_FIRST === '1' || !courseUrl) throw error;

          await logger.log('RETRY', 'retrying lesson extraction through homepage course flow', {
            lessonUrl,
            error: error instanceof Error ? error.message : String(error)
          });
          await gotoLessonFromCourseFlow(page, lessonUrl, courseUrl);
          await ensureOnExpectedLessonPage(page, lessonUrl, logger, courseUrl ?? undefined);
          return await extractContentFromCurrentLessonPage(page, materialWatcher, lessonUrl, lessonName ?? 'Unknown lesson', logger);
        } finally {
          materialWatcher.stop();
        }
      } finally {
        await browser.close();
      }
    }
  };
}

export const themembersAuthStatePath = path.join('storage', 'auth', 'themembers.json');
