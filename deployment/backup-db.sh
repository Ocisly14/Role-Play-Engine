#!/bin/bash
#
# SQLite Database Backup Script for CoC AI Agent
#
# This script creates compressed backups of the SQLite database
# and automatically removes old backups (14+ days) to save disk space.
#
# Usage:
#   ./backup-db.sh
#
# Setup Automatic Backups (Daily at 3 AM):
#   crontab -e
#   Add line: 0 3 * * * /home/ubuntu/app/deployment/backup-db.sh >> /home/ubuntu/app/logs/backup.log 2>&1
#
# Restore from Backup:
#   pm2 stop coc-agent
#   gunzip -c /home/ubuntu/app/backups/coc_game_YYYYMMDD_HHMMSS.db.gz > /home/ubuntu/app/data/coc_game.db
#   pm2 start coc-agent

set -e  # Exit on error
set -u  # Exit on undefined variable

# Configuration
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/app/backups}"
DB_PATH="${DB_PATH:-/home/ubuntu/app/data/coc_game.db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/coc_game_${TIMESTAMP}.db"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1"
}

# Create backup directory if it doesn't exist
if [ ! -d "$BACKUP_DIR" ]; then
    log "Creating backup directory: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
fi

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
    error "Database not found at: $DB_PATH"
    exit 1
fi

# Check if sqlite3 is installed
if ! command -v sqlite3 &> /dev/null; then
    error "sqlite3 is not installed. Install it with: sudo apt install sqlite3"
    exit 1
fi

log "Starting database backup..."
log "Source: $DB_PATH"
log "Destination: $BACKUP_FILE.gz"

# Get database size
DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
log "Database size: $DB_SIZE"

# Create backup using SQLite's .backup command
# This is safer than file copy because it handles WAL files properly
log "Creating backup..."
if sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"; then
    log "Backup created successfully"
else
    error "Failed to create backup"
    exit 1
fi

# Compress backup
log "Compressing backup..."
if gzip "$BACKUP_FILE"; then
    COMPRESSED_SIZE=$(du -h "${BACKUP_FILE}.gz" | cut -f1)
    log "Backup compressed successfully (${COMPRESSED_SIZE})"
else
    error "Failed to compress backup"
    exit 1
fi

# Remove old backups
log "Cleaning up old backups (older than ${RETENTION_DAYS} days)..."
OLD_BACKUPS=$(find "$BACKUP_DIR" -name "coc_game_*.db.gz" -mtime +${RETENTION_DAYS} 2>/dev/null || true)

if [ -n "$OLD_BACKUPS" ]; then
    DELETED_COUNT=0
    while IFS= read -r backup; do
        if [ -n "$backup" ]; then
            log "Deleting old backup: $(basename "$backup")"
            rm -f "$backup"
            ((DELETED_COUNT++))
        fi
    done <<< "$OLD_BACKUPS"
    log "Deleted $DELETED_COUNT old backup(s)"
else
    log "No old backups to delete"
fi

# Show backup summary
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "coc_game_*.db.gz" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)

log "=== Backup Summary ==="
log "Backup completed: ${BACKUP_FILE}.gz"
log "Total backups: $BACKUP_COUNT"
log "Total backup size: $TOTAL_SIZE"
log "Retention policy: $RETENTION_DAYS days"
log "======================"

exit 0
