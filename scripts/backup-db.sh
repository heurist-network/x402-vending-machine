#!/bin/bash

# PostgreSQL database backup script
# Creates a SQL dump of the entire database
#
# Usage: bash scripts/backup-db.sh

set -e

# Create backups directory
BACKUP_DIR="backups"
mkdir -p "$BACKUP_DIR"

# Get timestamp
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL environment variable is not set"
    echo "Please set it with: export DATABASE_URL='your-database-url'"
    exit 1
fi

echo "=========================================="
echo "Starting PostgreSQL backup..."
echo "Timestamp: $TIMESTAMP"
echo "=========================================="

# Create full database dump
DUMP_FILE="$BACKUP_DIR/db_backup_$TIMESTAMP.sql"

echo "Creating backup: $DUMP_FILE"
pg_dump "$DATABASE_URL" > "$DUMP_FILE"

echo "✓ Database dump created successfully"

# Create compressed version
echo "Compressing backup..."
gzip -k "$DUMP_FILE"
echo "✓ Compressed backup created"

# Get file sizes
DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
GZ_SIZE=$(du -h "${DUMP_FILE}.gz" | cut -f1)

# Show summary
echo ""
echo "=========================================="
echo "Backup Complete!"
echo "=========================================="
echo "Files created:"
echo "  - $DUMP_FILE ($DUMP_SIZE)"
echo "  - ${DUMP_FILE}.gz ($GZ_SIZE)"
echo ""
echo "To restore from backup:"
echo "  psql \$DATABASE_URL < $DUMP_FILE"
echo ""
echo "Or from compressed:"
echo "  gunzip -c ${DUMP_FILE}.gz | psql \$DATABASE_URL"
echo "=========================================="
