#!/bin/bash
#
# Server Initialization Script for CoC AI Agent
#
# This script installs all required dependencies on a fresh Ubuntu 22.04 EC2 instance
#
# Usage:
#   Run this script on the EC2 server after SSH connection
#   curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/main/deployment/setup-server.sh | bash
#   OR copy and paste the entire script into the terminal

set -e  # Exit on error

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

echo "========================================="
echo "  CoC AI Agent - Server Setup"
echo "========================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    error "Please run as regular user (ubuntu), not as root"
    exit 1
fi

log "Step 1/8: Updating system packages..."
sudo apt update && sudo apt upgrade -y
log "System updated ✓"
echo ""

log "Step 2/8: Installing Node.js 20..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    info "Node.js already installed: $NODE_VERSION"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
    log "Node.js installed: $(node --version) ✓"
fi
echo ""

log "Step 3/8: Installing pnpm..."
if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm --version)
    info "pnpm already installed: v$PNPM_VERSION"
else
    sudo npm install -g pnpm
    log "pnpm installed: $(pnpm --version) ✓"
fi
echo ""

log "Step 4/8: Installing build tools..."
sudo apt install -y build-essential python3 sqlite3
log "Build tools installed ✓"
echo ""

log "Step 5/8: Installing Nginx..."
if command -v nginx &> /dev/null; then
    info "Nginx already installed: $(nginx -v 2>&1)"
else
    sudo apt install -y nginx
    log "Nginx installed ✓"
fi
echo ""

log "Step 6/8: Installing Certbot (Let's Encrypt)..."
if command -v certbot &> /dev/null; then
    info "Certbot already installed: $(certbot --version 2>&1 | head -n1)"
else
    sudo apt install -y certbot python3-certbot-nginx
    log "Certbot installed ✓"
fi
echo ""

log "Step 7/8: Installing PM2..."
if command -v pm2 &> /dev/null; then
    info "PM2 already installed: $(pm2 --version)"
else
    sudo npm install -g pm2
    log "PM2 installed ✓"
fi

# Setup PM2 startup
log "Configuring PM2 startup..."
pm2 startup systemd -u ubuntu --hp /home/ubuntu > /tmp/pm2-startup.sh 2>&1 || true
if grep -q "sudo" /tmp/pm2-startup.sh; then
    STARTUP_CMD=$(grep "sudo env" /tmp/pm2-startup.sh || true)
    if [ -n "$STARTUP_CMD" ]; then
        eval "$STARTUP_CMD"
        log "PM2 startup configured ✓"
    fi
fi
rm -f /tmp/pm2-startup.sh
echo ""

log "Step 8/8: Configuring firewall (UFW)..."
sudo ufw --force enable
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
log "Firewall configured ✓"
echo ""

log "Creating application directory..."
mkdir -p /home/ubuntu/app
mkdir -p /home/ubuntu/app/logs
mkdir -p /home/ubuntu/app/backups
cd /home/ubuntu/app
log "Application directory created ✓"
echo ""

echo "========================================="
echo "  Server Setup Complete!"
echo "========================================="
echo ""
info "Installed versions:"
echo "  - Node.js: $(node --version)"
echo "  - npm: $(npm --version)"
echo "  - pnpm: $(pnpm --version)"
echo "  - Nginx: $(nginx -v 2>&1)"
echo "  - PM2: $(pm2 --version)"
echo "  - Certbot: $(certbot --version 2>&1 | head -n1)"
echo ""
info "Next steps:"
echo "  1. Exit this SSH session (type 'exit')"
echo "  2. Run the deployment script from your local machine"
echo "  3. Configure environment variables on the server"
echo ""

exit 0
