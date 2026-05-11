import json
import os
import re
import time
from playwright.sync_api import sync_playwright

MANIFEST_PATH = "/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/manifests/themembers-v3-repaired/design-de-dashboards-e-storytelling-com-dados.json"
OUTPUT_DIR = "/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/downloads/themembers-v3-retry"
AUDIT_PATH = "/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/audit/url_retry_design_dashboards.json"
LOGIN_URL = "https://alunos.tetraeducacao.com.br/login"
EMAIL = "lucas@tetraeducacao.com.br"
PASSWORD = "28778422"

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")

def load_manifest():
    with open(MANIFEST_PATH) as f:
        return json.load(f)

def save_manifest(data):
    with open(MANIFEST_PATH, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def save_audit(audit):
    os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
    with open(AUDIT_PATH, 'w') as f:
        json.dump(audit, f, indent=2)

def get_failed_assets(manifest):
    failed = []
    for module in manifest.get('modules', []):
        for lesson in module.get('lessons', []):
            for asset in lesson.get('assets', []):
                if asset.get('status') == 'failed' and asset.get('url', '').startswith('unresolved://'):
                    failed.append({
                        'module': module.get('name'),
                        'lesson': lesson.get('name'),
                        'lessonUrl': lesson.get('url'),
                        'assetName': asset.get('name'),
                        'assetIndex': lesson.get('assets', []).index(asset)
                    })
    return failed

def find_material_section(page, asset_name):
    """Find and click the material section for the given asset name"""
    name_only = re.sub(r'\.(pdf|zip|mp3|docx?|xlsx?)$', '', asset_name, flags=re.IGNORECASE)
    name_only = name_only.strip()

    # Look for text patterns
    selectors = [
        f'text="{name_only}"',
        f'text="{asset_name}"',
        f'text="Material"',
        f'text="Downloads"',
        '[class*="material"]',
        '[class*="attachment"]',
    ]

    for sel in selectors:
        try:
            el = page.locator(sel).first
            if el.is_visible(timeout=2000):
                log(f"  Found: {sel}")
                el.click(timeout=5000)
                time.sleep(2)
                return True
        except:
            pass
    return False

def click_pdf_link(page, asset_name):
    """Try to click the PDF link for this asset"""
    # Look for links containing the asset name
    links = page.locator('a[href]')
    count = links.count()

    for i in range(count):
        try:
            link = links.nth(i)
            href = link.get_attribute('href') or ''
            text = link.inner_text() or ''

            if '.pdf' in href.lower() or '.zip' in href.lower():
                log(f"  Link {i}: {text[:40]} -> {href[:80]}")
                link.click(timeout=3000)
                time.sleep(2)
                return True
        except:
            pass
    return False

def main():
    audit = {
        'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'course': 'design-de-dashboards-e-storytelling-com-dados',
        'assets': [],
        'summary': {'total': 0, 'success': 0, 'failed': 0, 'skipped': 0}
    }

    manifest = load_manifest()
    failed_assets = get_failed_assets(manifest)

    log(f"Found {len(failed_assets)} failed assets to retry")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Login
        log("Logging in...")
        page.goto(LOGIN_URL)
        time.sleep(2)

        page.evaluate(f"document.querySelector('input[name=\"email\"]').value = '{EMAIL}'")
        page.evaluate(f"document.querySelector('input[name=\"password\"]').value = '{PASSWORD}'")
        page.evaluate("document.querySelector('button[type=\"submit\"]').click()")
        time.sleep(4)

        if 'homepage' in page.url:
            log("Login successful")
        else:
            log(f"Login may have failed, URL: {page.url}")

        # Process each failed asset
        for item in failed_assets:
            log(f"\nProcessing: {item['assetName']} in {item['lesson'][:50]}")
            audit['summary']['total'] += 1

            result = {
                'assetName': item['assetName'],
                'lessonUrl': item['lessonUrl'],
                'status': 'pending',
                'attempts': []
            }

            try:
                # Navigate to lesson
                page.goto(item['lessonUrl'])
                time.sleep(3)

                # Try multiple click strategies
                success = False
                for attempt in range(3):
                    log(f"  Attempt {attempt + 1}...")

                    # Strategy 1: Scroll and find material section
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.3)")
                    time.sleep(1)

                    # Strategy 2: Look for specific patterns
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.5)")
                    time.sleep(1)

                    # Get current URL after any navigation
                    current_url = page.url

                    # Look for downloadable links
                    links = page.locator('a[href]')
                    for i in range(min(links.count(), 30)):
                        try:
                            link = links.nth(i)
                            href = link.get_attribute('href') or ''
                            if ('material' in href or '.pdf' in href.lower() or '.zip' in href.lower()) and 'cloudflarestorage' in href:
                                log(f"  Found R2 URL: {href[:100]}...")
                                result['attempts'].append({'type': 'found_url', 'url': href[:150]})

                                # Try to download
                                page.goto(href, wait_until='commit')
                                time.sleep(2)

                                # Check if download started
                                if page.url != href:
                                    success = True
                                    result['status'] = 'found'
                                    break
                        except:
                            pass

                    if success:
                        break

                    time.sleep(2)

                if not success:
                    result['status'] = 'failed'
                    result['error'] = 'Could not find fresh URL'

            except Exception as e:
                result['status'] = 'error'
                result['error'] = str(e)[:200]

            audit['assets'].append(result)

            if result['status'] == 'success':
                audit['summary']['success'] += 1
            elif result['status'] == 'failed':
                audit['summary']['failed'] += 1
            else:
                audit['summary']['skipped'] += 1

        browser.close()

    audit['completedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ')
    save_audit(audit)

    log(f"\nDone! Success: {audit['summary']['success']}, Failed: {audit['summary']['failed']}")
    log(f"Audit saved to: {AUDIT_PATH}")

if __name__ == '__main__':
    main()