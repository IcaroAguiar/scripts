#!/bin/bash
# Worker script for parallel extraction
# Usage: ./extract-worker.sh <batch-file>
BATCH_FILE="$1"
MANIFEST_DIR="storage/manifests/themembers"

if [ ! -f "$BATCH_FILE" ]; then
  echo "Batch file not found: $BATCH_FILE"
  exit 1
fi

echo "Worker starting with batch: $BATCH_FILE"
echo "Courses to process:"
cat "$BATCH_FILE"
echo ""

for slug in $(cat "$BATCH_FILE"); do
  echo "=== Processing: $slug ==="
  THEMEMBERS_COURSE_URL="" EXTRACT_FORCE=1 bun run src/scripts/extract.ts --course-slug "$slug" 2>&1 | tail -5
  echo ""
done

echo "Worker done: $BATCH_FILE"