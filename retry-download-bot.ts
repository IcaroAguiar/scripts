import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { URL } from "url";

const LOGIN_URL = "https://alunos.tetraeducacao.com.br/login";
const EMAIL = "lucas@tetraeducacao.com.br";
const PASSWORD = "28778422";
const QUEUE_FILE = join(process.cwd(), "storage/audit/v3_wave_url_only_queue.json");
const MANIFESTS_DIR = join(process.cwd(), "storage/manifests/themembers-v3-repaired");
const OUTPUT_DIR = join(process.cwd(), "storage/downloads/themembers-v3-retry");
const RESULT_FILE = join(process.cwd(), "storage/audit/v3_wave_url_retry_batch1.json");

const TARGET_COURSES = [
  "canva",
  "cartoes-de-credito",
  "comece-aqui-mentoria-carreira-executiva-4.0",
  "comece-aqui-mentoria-carreira-executiva-40",
];

interface QueueItem {
  courseSlug: string;
  courseName: string;
  moduleName: string;
  lessonName: string;
  lessonUrl: string;
  assetName: string;
  url: string;
}

interface ResultItem extends QueueItem {
  status: "downloaded" | "failed" | "skipped";
  localPath?: string;
  freshUrl?: string;
  error?: string;
  retries?: number;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const raw = JSON.parse(readFileSync(QUEUE_FILE, "utf-8")) as QueueItem[];
  const queue = raw.filter((q) => TARGET_COURSES.includes(q.courseSlug));

  console.log(`[BOT] Starting with ${queue.length} items across ${TARGET_COURSES.length} courses`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Login
  console.log("[BOT] Logging in...");
  await page.goto(LOGIN_URL);
  await page.waitForLoadState("networkidle");

  // Fill login form
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  await emailInput.fill(EMAIL);
  await passInput.fill(PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login")').first().click();
  await page.waitForLoadState("networkidle");
  await sleep(2000);
  console.log("[BOT] Logged in, session active");

  const results: ResultItem[] = [];
  let processed = 0;

  // Group by course > lesson to minimize navigation
  const byLesson = new Map<string, QueueItem[]>();
  for (const item of queue) {
    const key = item.lessonUrl;
    if (!byLesson.has(key)) byLesson.set(key, []);
    byLesson.get(key)!.push(item);
  }

  for (const [lessonUrl, items] of byLesson) {
    console.log(`\n[BOT] Navigating to lesson: ${lessonUrl}`);
    let retries = 0;
    let success = false;

    while (retries < 3 && !success) {
      try {
        await page.goto(lessonUrl, { waitUntil: "networkidle", timeout: 30000 });
        await sleep(1500);

        // Scroll to find material section
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1000);

        for (const item of items) {
          if (item.url.startsWith("unresolved://") || item.url.startsWith("https://drive.google.com")) {
            results.push({ ...item, status: "skipped", error: "unresolved or Google Drive URL not downloadable via this method" });
            processed++;
            console.log(`  [SKIP] ${item.assetName} — ${item.error}`);
            continue;
          }

          // Try to find the download/material button matching the asset name
          const assetNameClean = item.assetName.replace(/\.pdf$|\.zip$|\.xlsx$/i, "").toLowerCase();
          let found = false;

          // Look for download buttons / material links
          const buttons = page.locator('button, a[href], [role="button"]');
          const count = await buttons.count();

          for (let i = 0; i < count && !found; i++) {
            const el = buttons.nth(i);
            const text = await el.textContent().catch(() => "");
            const href = await el.getAttribute("href").catch(() => "");
            const ariaLabel = await el.getAttribute("aria-label").catch(() => "");

            const searchText = (text + " " + ariaLabel).toLowerCase();
            if (
              (searchText.includes("material") || searchText.includes("download") || searchText.includes("baixar") || searchText.includes(item.assetName.toLowerCase().slice(0, 10))) &&
              (href || text)
            ) {
              // Click to generate fresh URL or trigger download
              await el.click();
              await sleep(2000);

              // After click, the page may have navigated or a popup/new-tab may have opened
              // Get the current URL or any new R2 URL from the page
              const currentUrl = page.url();
              let freshUrl: string | undefined;

              if (currentUrl.includes("cloudflarestorage") || currentUrl.includes("r2")) {
                freshUrl = currentUrl;
              } else {
                // Try to intercept the R2 URL from network requests
                const r2Urls: string[] = [];
                page.on("response", (resp) => {
                  const u = resp.url();
                  if (u.includes("cloudflarestorage") || u.includes("r2")) {
                    r2Urls.push(u);
                  }
                });
                await sleep(1000);
                if (r2Urls.length > 0) freshUrl = r2Urls[0];
              }

              if (freshUrl) {
                const destDir = join(OUTPUT_DIR, item.courseSlug, item.moduleName, item.lessonName, "materiais");
                mkdirSync(destDir, { recursive: true });
                const destPath = join(destDir, item.assetName);

                // Download the file
                try {
                  const response = await page.request.get(freshUrl, { headers: { Accept: "*/*" } });
                  if (response.ok()) {
                    writeFileSync(destPath, await response.body());
                    console.log(`  [OK] ${item.assetName} → ${destPath}`);

                    // Update manifest localPath
                    updateManifest(item, destPath);

                    results.push({ ...item, status: "downloaded", localPath: destPath, freshUrl });
                    processed++;
                    found = true;
                  } else {
                    throw new Error(`HTTP ${response.status()}`);
                  }
                } catch (dlErr: any) {
                  console.log(`  [DL ERR] ${item.assetName}: ${dlErr.message}`);
                  results.push({ ...item, status: "failed", error: dlErr.message, retries });
                }
              } else {
                // No fresh URL found — download via direct curl with existing URL
                const destDir = join(OUTPUT_DIR, item.courseSlug, item.moduleName, item.lessonName, "materiais");
                mkdirSync(destDir, { recursive: true });
                const destPath = join(destDir, item.assetName);

                try {
                  const { execSync } = await import("child_process");
                  execSync(`curl -sL -o "${destPath}" "${item.url}"`, { timeout: 30000 });
                  const fs = await import("fs");
                  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                    console.log(`  [OK] ${item.assetName} → ${destPath}`);
                    updateManifest(item, destPath);
                    results.push({ ...item, status: "downloaded", localPath: destPath });
                    processed++;
                    found = true;
                  } else {
                    throw new Error("File empty or missing");
                  }
                } catch (dlErr: any) {
                  console.log(`  [DL ERR] ${item.assetName}: ${dlErr.message}`);
                  results.push({ ...item, status: "failed", error: dlErr.message, retries });
                }
              }
            }
          }

          if (!found) {
            // Fallback: just use curl with existing URL
            const destDir = join(OUTPUT_DIR, item.courseSlug, item.moduleName, item.lessonName, "materiais");
            mkdirSync(destDir, { recursive: true });
            const destPath = join(destDir, item.assetName);

            try {
              const { execSync } = await import("child_process");
              execSync(`curl -sL -o "${destPath}" "${item.url}"`, { timeout: 30000 });
              const fs = await import("fs");
              if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                console.log(`  [FALLBACK OK] ${item.assetName} → ${destPath}`);
                updateManifest(item, destPath);
                results.push({ ...item, status: "downloaded", localPath: destPath });
                processed++;
              } else {
                throw new Error("File empty or missing");
              }
            } catch (dlErr: any) {
              console.log(`  [FAIL] ${item.assetName}: ${dlErr.message}`);
              results.push({ ...item, status: "failed", error: dlErr.message, retries });
              processed++;
            }
          }

          // Log every 5 assets
          if (processed % 5 === 0) {
            console.log(`\n[BOT] LOG PROGRESS: ${processed}/${queue.length} processed`);
            writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));
          }
        }

        success = true;
      } catch (err: any) {
        retries++;
        console.log(`  [RETRY ${retries}] Lesson load error: ${err.message}`);
        await sleep(2000);
      }
    }

    if (!success) {
      // Mark all items from failed lesson as failed
      for (const item of items) {
        if (!results.find((r) => r.lessonUrl === item.lessonUrl && r.assetName === item.assetName)) {
          results.push({ ...item, status: "failed", error: "Failed after 3 retries", retries: 3 });
        }
      }
    }
  }

  writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));

  const downloaded = results.filter((r) => r.status === "downloaded").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  console.log(`\n[BOT] DONE — downloaded: ${downloaded}, failed: ${failed}, skipped: ${skipped}`);
  console.log(`[BOT] Results: ${RESULT_FILE}`);

  await browser.close();
}

function updateManifest(item: QueueItem, localPath: string) {
  try {
    const manifestPath = join(MANIFESTS_DIR, `${item.courseSlug}.json`);
    if (!existsSync(manifestPath)) return;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    // Find the lesson in manifest and update localPath
    for (const lesson of manifest.lessons || []) {
      if (
        lesson.name === item.lessonName ||
        lesson.name.includes(item.lessonName) ||
        item.lessonName.includes(lesson.name)
      ) {
        for (const mat of lesson.materials || []) {
          if (mat.name === item.assetName || mat.name.includes(item.assetName.slice(0, 20))) {
            mat.localPath = localPath;
            console.log(`  [MANIFEST] Updated: ${item.assetName} → ${localPath}`);
          }
        }
      }
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e: any) {
    console.log(`  [MANIFEST WARN] Could not update manifest: ${e.message}`);
  }
}

run().catch((e) => {
  console.error("[BOT] Fatal:", e);
  process.exit(1);
});
