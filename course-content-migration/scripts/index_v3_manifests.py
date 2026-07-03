#!/usr/bin/env python3
import json
import os
from pathlib import Path
from datetime import datetime, timezone

MANIFESTS_DIR = Path("/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/manifests/themembers-v3")
OUTPUT_FILE = Path("/Users/icaroaguiar/dev/pessoal/scripts/ead-migration-bot/storage/audit/v3_wave_target_index.json")

def classify_course(manifest_file, modules):
    """Classify course status based on modules structure."""
    if not modules:
        return "ZERO_ASSETS"

    first_module = modules[0]
    if first_module.get("moduleName") == "Discovery failed":
        return "DISCOVERY_FAILED"

    has_assets_count = 0
    no_assets_count = 0

    for mod in modules:
        for lesson in mod.get("lessons", []):
            assets = lesson.get("assets", [])
            if assets and len(assets) > 0:
                has_assets_count += 1
            else:
                no_assets_count += 1

    total_lessons = has_assets_count + no_assets_count

    if total_lessons == 0:
        return "ZERO_ASSETS"

    if has_assets_count == total_lessons:
        return "ASSETS_OK"
    elif has_assets_count == 0:
        return "ZERO_ASSETS"
    else:
        return "PARTIAL"

def extract_asset_info(asset):
    """Extract clean asset info from raw asset data."""
    name = asset.get("name", "")

    # Determine type from mimeType or name
    mime_type = asset.get("mimeType", "")
    if mime_type:
        if mime_type.startswith("video/"):
            asset_type = "video"
        elif mime_type.startswith("image/"):
            asset_type = "image"
        elif mime_type == "application/pdf":
            asset_type = "pdf"
        elif "spreadsheet" in mime_type or "excel" in mime_type:
            asset_type = "spreadsheet"
        elif "presentation" in mime_type or "powerpoint" in mime_type:
            asset_type = "presentation"
        elif "document" in mime_type or "word" in mime_type:
            asset_type = "document"
        else:
            asset_type = "file"
    else:
        # Infer from name
        ext = name.lower().split(".")[-1] if "." in name else ""
        type_map = {
            "mp4": "video", "mov": "video", "avi": "video", "webm": "video",
            "jpg": "image", "jpeg": "image", "png": "image", "gif": "image", "webp": "image",
            "pdf": "pdf",
            "xlsx": "spreadsheet", "xls": "spreadsheet", "csv": "spreadsheet",
            "pptx": "presentation", "ppt": "presentation",
            "docx": "document", "doc": "document"
        }
        asset_type = type_map.get(ext, "file")

    source = asset.get("url", "") or asset.get("localPath", "")

    provenance_raw = asset.get("provenance", {})
    if isinstance(provenance_raw, dict):
        provenance = {
            "reason": provenance_raw.get("reason", "unknown"),
            "confidence": provenance_raw.get("confidence", "unknown")
        }
    else:
        provenance = {"reason": "unknown", "confidence": "unknown"}

    return {
        "name": name,
        "type": asset_type,
        "source": source,
        "provenance": provenance
    }

def process_manifest(filepath):
    """Process a single manifest file and extract course info."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    if not content.strip():
        return None

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return None

    filename = filepath.name
    course_slug = filename.replace(".json", "")

    # Extract course info
    course_name = data.get("courseName", course_slug)
    course_id = data.get("courseId", course_slug)
    course_url = data.get("courseUrl", "")
    platform = data.get("platform", "themembers")
    discovered_at = data.get("discoveredAt", "")

    # Process modules
    modules_data = data.get("modules", [])

    processed_modules = []
    total_assets = 0

    for mod_idx, mod in enumerate(modules_data):
        mod_index = mod_idx + 1
        mod_name = mod.get("moduleName", f"Module {mod_index}")
        mod_slug = mod.get("moduleSlug", "")

        lessons = mod.get("lessons", [])
        processed_lessons = []

        for lesson_idx, lesson in enumerate(lessons):
            lesson_index = lesson_idx + 1
            lesson_name = lesson.get("lessonName", f"Lesson {lesson_index}")
            lesson_slug = lesson.get("lessonSlug", "")
            lesson_url = lesson.get("lessonUrl", "")
            status = lesson.get("status", "")
            last_error = lesson.get("lastError", "")

            assets = lesson.get("assets", [])
            processed_assets = [extract_asset_info(a) for a in assets]
            total_assets += len(processed_assets)

            processed_lessons.append({
                "lessonIndex": lesson_index,
                "lessonName": lesson_name,
                "lessonSlug": lesson_slug,
                "lessonUrl": lesson_url,
                "status": status,
                "lastError": last_error,
                "assets": processed_assets
            })

        processed_modules.append({
            "moduleIndex": mod_index,
            "moduleName": mod_name,
            "moduleSlug": mod_slug,
            "lessons": processed_lessons
        })

    status = classify_course(filepath, modules_data)

    return {
        "manifestFile": filename,
        "courseName": course_name,
        "courseSlug": course_slug,
        "courseUrl": course_url,
        "courseId": course_id,
        "platform": platform,
        "discoveredAt": discovered_at,
        "status": status,
        "modules": processed_modules,
        "_totalAssets": total_assets
    }

def main():
    manifest_files = sorted(MANIFESTS_DIR.glob("*.json"))
    print(f"Found {len(manifest_files)} manifest files")

    results = []
    total_assets = 0
    by_status = {
        "DISCOVERY_FAILED": 0,
        "ASSETS_OK": 0,
        "ZERO_ASSETS": 0,
        "PARTIAL": 0
    }
    discovery_failed_courses = []
    zero_asset_courses = []

    for filepath in manifest_files:
        result = process_manifest(filepath)
        if result:
            results.append(result)
            total_assets += result["_totalAssets"]
            status = result["status"]
            by_status[status] += 1

            if status == "DISCOVERY_FAILED":
                discovery_failed_courses.append(result["manifestFile"])
            elif status == "ZERO_ASSETS":
                zero_asset_courses.append(result["manifestFile"])

    # Clean up internal _totalAssets field
    for r in results:
        del r["_totalAssets"]

    output = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "totalManifests": len(manifest_files),
        "totalAssetsInV3": total_assets,
        "byStatus": by_status,
        "discoveryFailedCourses": sorted(discovery_failed_courses),
        "zeroAssetCourses": sorted(zero_asset_courses),
        "courses": results
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Index written to {OUTPUT_FILE}")
    print(f"Total manifests: {len(manifest_files)}")
    print(f"Total assets: {total_assets}")
    print(f"By status: {by_status}")
    print(f"Discovery failed: {len(discovery_failed_courses)}")
    print(f"Zero assets: {len(zero_asset_courses)}")

if __name__ == "__main__":
    main()