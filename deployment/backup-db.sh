#!/bin/bash
#
# PostgreSQL Backup Script for CoC AI Agent
#
# Creates compressed SQL backups and removes old backups.
#
# Usage:
#   ./backup-db.sh
#
# Setup Automatic Backups (Daily at 3 AM):
#   crontab -e
#   Add line: 0 3 * * * /home/ubuntu/app/deployment/backup-db.sh >> /home/ubuntu/app/logs/backup.log 2>&1

set -e
set -u

# Configuration
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/app/backups}"
DATABASE_URL="${DATABASE_URL:-}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is required"
  exit 1
fi

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/coc_game_${TIMESTAMP}.sql"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() {
  echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
  echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" >&2
}

# Create backup directory if needed
if [ ! -d "$BACKUP_DIR" ]; then
  log "Creating backup directory: $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
fi

# Ensure pg_dump is available
if ! command -v pg_dump >/dev/null 2>&1; then
  error "pg_dump not found. Install postgresql-client."
  exit 1
fi

log "Starting PostgreSQL backup..."
log "Destination: ${BACKUP_FILE}.gz"

log "Creating SQL dump..."
if pg_dump "$DATABASE_URL" --no-owner --no-privileges -f "$BACKUP_FILE"; then
  log "Dump created successfully"
else
  error "Failed to create dump"
  exit 1
fi

log "Compressing backup..."
if gzip "$BACKUP_FILE"; then
  COMPRESSED_SIZE=$(du -h "${BACKUP_FILE}.gz" | cut -f1)
  log "Backup compressed successfully (${COMPRESSED_SIZE})"
else
  error "Failed to compress backup"
  exit 1
fi

log "Cleaning old backups (>${RETENTION_DAYS} days)..."
OLD_BACKUPS=$(find "$BACKUP_DIR" -name "coc_game_*.sql.gz" -mtime +${RETENTION_DAYS} 2>/dev/null || true)

if [ -n "$OLD_BACKUPS" ]; then
  while IFS= read -r backup; do
    [ -z "$backup" ] && continue
    log "Deleting old backup: $(basename "$backup")"
    rm -f "$backup"
  done <<< "$OLD_BACKUPS"
fi

BACKUP_COUNT=$(find "$BACKUP_DIR" -name "coc_game_*.sql.gz" | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)

log "=== Backup Summary ==="
log "Backup completed: ${BACKUP_FILE}.gz"
log "Total backups: $BACKUP_COUNT"
log "Total backup size: $TOTAL_SIZE"
log "Retention policy: $RETENTION_DAYS days"
log "======================"

exit 0
