import fs from 'fs-extra';
import { chromium } from 'playwright';
import { Logger } from '../core/logger/logger';

const AUTH_PATH = 'storage/auth/themembers-retry-excel-essencial.json';
const LOGS_RETRY_DIR = 'storage/logs/retry-excel-essencial';

const LOGIN_URL = 'https://alunos.tetraeducacao.com.br/login';
const EMAIL = 'lucas@tetraeducacao.com.br';
const PASSWORD = '28778422';

async function main() {
  await fs.ensureDir(LOGS_RETRY_DIR);
  const logger = new Logger(LOGS_RETRY_DIR);

  const browser = await chromium.launch({ headless: false });
  const hasAuth = await fs.pathExists(AUTH_PATH);
  const context = await browser.newContext({
    ...(hasAuth ? { storageState: AUTH_PATH } : {}),
    acceptDownloads: true
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  // Login
  await page.goto('https://alunos.tetraeducacao.com.br/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  if (page.url().includes('login')) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="senha" i]').first();
    await emailInput.fill(EMAIL);
    await passwordInput.fill(PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await context.storageState({ path: AUTH_PATH });
    logger.log('AUTH', 'logged in');
  }

  // Set up R2 URL capture
  const r2Urls = new Set<string>();
  const captureR2 = (url: string) => {
    if (/cloudflarestorage\.com/i.test(url) && /X-Amz-Signature=/i.test(url)) {
      r2Urls.add(url);
      logger.log('CAPTURED_R2', url.substring(0, 120));
    }
  };
  page.on('request', r => captureR2(r.url()));
  page.on('response', r => captureR2(r.url()));

  // Step 1: Go to course URL and select Excel Essencial
  logger.log('NAVIGATE', 'going to course page');
  await page.goto('https://alunos.tetraeducacao.com.br/courses/4393/excel-essencial/799952de-137e-4d4f-829c-83abc1a5840d', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);

  // Select Excel Essencial
  await page.locator('select').first().selectOption('799952de-137e-4d4f-829c-83abc1a5840d');
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);

  // Step 2: Navigate to lesson URL with index param
  logger.log('NAVIGATE', 'going to lesson page');
  await page.goto('https://alunos.tetraeducacao.com.br/curso/4393/aula-01-licencas-do-excel1277822425/ade8c3b6-0d61-48af-87e9-6f107b605fa6?index=1', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(5_000);
  logger.log('PAGE_DEBUG', `lesson page url=${page.url()}`);

  // Try to find and click "Material complementar" or expand material section
  logger.log('ANALYZE', 'Looking for material section...');
  
  // Look for any text containing "Material"
  const matText = page.locator('text=Material');
  const matCount = await matText.count();
  logger.log('FOUND', `found ${matCount} "Material" elements`);
  
  for (let i = 0; i < matCount; i++) {
    const el = matText.nth(i);
    const tagName = await el.evaluate(e => e.tagName);
    const text = (await el.innerText().catch(() => '')).trim();
    const parent = await el.locator('..').evaluate(e => `${e.tagName} .${e.className}`.substring(0, 100));
    logger.log('MAT_EL', `[${i}] tag=${tagName} text="${text}" parent=${parent}`);
    
    // Try clicking this element
    try {
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: 2000 });
      logger.log('CLICKED', `clicked element ${i}`);
      await page.waitForTimeout(2_000);
    } catch (e: any) {
      logger.log('CLICK_ERR', `could not click element ${i}: ${e.message}`);
    }
  }

  // Look for any collapsed content that might contain materials
  const collapsibles = page.locator('[aria-expanded="false"], [class*="collapsed"], [class*="collapse"]');
  const collCount = await collapsibles.count();
  logger.log('ANALYZE', `found ${collCount} collapsed elements`);
  for (let i = 0; i < Math.min(collCount, 10); i++) {
    const el = collapsibles.nth(i);
    const tagName = await el.evaluate(e => e.tagName);
    const text = (await el.innerText().catch(() => '')).trim().substring(0, 50);
    try {
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: 1000 });
      logger.log('EXPANDED', `expanded element ${i}: ${text}`);
      await page.waitForTimeout(1_000);
    } catch {}
  }

  // Check for any clickable that has data-url, data-href, data-material, data-src
  const dataAttrs = page.locator('[data-url], [data-href], [data-material], [data-src*="cloudflare"], [data-src*="material"]');
  const dataCount = await dataAttrs.count();
  logger.log('ANALYZE', `found ${dataCount} elements with data attributes`);
  for (let i = 0; i < Math.min(dataCount, 10); i++) {
    const el = dataAttrs.nth(i);
    const tagName = await el.evaluate(e => e.tagName);
    const text = (await el.innerText().catch(() => '')).trim().substring(0, 50);
    const dataUrl = await el.getAttribute('data-url').catch(() => 'N/A');
    const dataHref = await el.getAttribute('data-href').catch(() => 'N/A');
    const dataSrc = await el.getAttribute('data-src').catch(() => 'N/A');
    logger.log('DATA_EL', `[${i}] tag=${tagName} text="${text}" data-url="${dataUrl}" data-href="${dataHref}" data-src="${dataSrc}"`);
    
    // Try clicking
    try {
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: 1000 });
      logger.log('DATA_CLICKED', `clicked data element ${i}`);
      await page.waitForTimeout(2_000);
    } catch {}
  }

  // After all interactions, check the full body
  const bodyAfter = await page.evaluate(() => document.body.innerText);
  logger.log('BODY_AFTER', '=== Page body after all interactions (first 3000) ===');
  for (const line of bodyAfter.substring(0, 3000).split('\n')) {
    if (line.trim()) logger.log('BODY', line.trim());
  }

  // Check for any download links or material links that appeared
  const links = page.locator('a[href]');
  const linkCount = await links.count();
  logger.log('LINKS', `found ${linkCount} links total`);
  for (let i = 0; i < Math.min(linkCount, 30); i++) {
    const link = links.nth(i);
    const href = await link.getAttribute('href').catch(() => '');
    const text = (await link.innerText().catch(() => '')).trim().substring(0, 50);
    if (href && (href.includes('cloudflare') || href.includes('material') || href.includes('download') || /formatacao|formatação/i.test(text))) {
      logger.log('MAT_LINK', `[${i}] href="${href}" text="${text}"`);
    }
  }

  // Check if there are any API calls to /materials endpoint
  const apiUrls = new Set<string>();
  page.on('request', r => {
    const url = r.url();
    if (url.includes('/api/') || url.includes('/materials')) {
      apiUrls.add(url);
      logger.log('API_REQ', url.substring(0, 120));
    }
  });

  // Trigger any remaining clicks to try to load materials
  const allButtons = page.locator('button');
  const btnCount = await allButtons.count();
  logger.log('ANALYZE', `found ${btnCount} buttons total`);
  for (let i = 0; i < Math.min(btnCount, 20); i++) {
    const btn = allButtons.nth(i);
    const text = (await btn.innerText().catch(() => '')).trim();
    const classes = await btn.getAttribute('class').catch(() => '');
    if (text.includes('Material') || text.includes('Anexo') || text.includes('Baixar') || classes.includes('material')) {
      logger.log('MAT_BTN', `[${i}] text="${text}" class="${classes}"`);
      try {
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ timeout: 1000 });
        logger.log('CLICKED_BTN', `clicked material button ${i}`);
        await page.waitForTimeout(2_000);
      } catch (e: any) {
        logger.log('BTN_ERR', `could not click btn ${i}: ${e.message}`);
      }
    }
  }

  // Final R2 URL capture
  logger.log('ANALYSIS', `=== Total R2 URLs captured: ${r2Urls.size} ===`);
  for (const url of r2Urls) {
    logger.log('R2_URL', url.substring(0, 150));
  }

  await page.waitForTimeout(2_000);
  await browser.close();
  logger.log('DONE', 'Debug complete');
}

main().catch(console.error);