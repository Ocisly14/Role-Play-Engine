#!/bin/bash
#
# Deployment Script for CoC AI Agent
#
# This script builds the application locally and deploys it to the EC2 server.
#
# Prerequisites:
#   - SSH key configured for EC2 access
#   - Server IP or domain configured
#   - Application built and tested locally
#
# Usage:
#   ./deployment/deploy.sh
#
# Environment Variables:
#   DEPLOY_HOST    - EC2 server IP or domain (default: ask user)
#   DEPLOY_KEY     - Path to SSH private key (default: ~/.ssh/id_rsa or ask user)
#   DEPLOY_USER    - SSH username (default: ubuntu)

set -e  # Exit on error

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Logging functions
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

# Configuration
DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_KEY="${DEPLOY_KEY:-}"
DEPLOY_DIR="/home/ubuntu/app"

# Banner
echo "========================================="
echo "  CoC AI Agent Deployment Script"
echo "========================================="
echo ""

# Check if we're in the project root
if [ ! -f "package.json" ]; then
    error "This script must be run from the project root directory"
    exit 1
fi

# Prompt for server details if not set
if [ -z "$DEPLOY_HOST" ]; then
    echo -n "Enter EC2 server IP or domain: "
    read DEPLOY_HOST
fi

if [ -z "$DEPLOY_KEY" ]; then
    # Check common key locations
    if [ -f ~/.ssh/id_rsa ]; then
        DEPLOY_KEY=~/.ssh/id_rsa
        info "Using SSH key: $DEPLOY_KEY"
    else
        echo -n "Enter path to SSH private key: "
        read DEPLOY_KEY
    fi
fi

# Validate SSH key
if [ ! -f "$DEPLOY_KEY" ]; then
    error "SSH key not found: $DEPLOY_KEY"
    exit 1
fi

log "Deployment configuration:"
info "  Server: ${DEPLOY_USER}@${DEPLOY_HOST}"
info "  SSH Key: ${DEPLOY_KEY}"
info "  Remote Directory: ${DEPLOY_DIR}"
echo ""

# Ask for confirmation
echo -n "Proceed with deployment? (y/N): "
read -r CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    warn "Deployment cancelled"
    exit 0
fi
echo ""

# Step 1: Build backend
log "Step 1: Building backend..."
if ! pnpm build; then
    error "Backend build failed"
    exit 1
fi
log "Backend build completed ✓"
echo ""

# Step 2: Build frontend
log "Step 2: Building frontend..."
cd client
if ! npm install; then
    error "Frontend dependency installation failed"
    exit 1
fi
if ! npm run build; then
    error "Frontend build failed"
    exit 1
fi
cd ..
log "Frontend build completed ✓"
echo ""

# Step 3: Create deployment package
log "Step 3: Creating deployment package..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
PACKAGE_NAME="coc-deploy-${TIMESTAMP}.tar.gz"

tar czf "$PACKAGE_NAME" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='data/*.db*' \
  dist/ \
  client/dist/ \
  data/Mods/ \
  package.json \
  pnpm-lock.yaml \
  deployment/ecosystem.config.cjs

PACKAGE_SIZE=$(du -h "$PACKAGE_NAME" | cut -f1)
log "Package created: ${PACKAGE_NAME} (${PACKAGE_SIZE}) ✓"
echo ""

# Step 4: Upload to server
log "Step 4: Uploading to server..."
if ! scp -i "$DEPLOY_KEY" "$PACKAGE_NAME" "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_DIR}/"; then
    error "Upload failed"
    rm "$PACKAGE_NAME"
    exit 1
fi
log "Upload completed ✓"
echo ""

# Step 5: Deploy on server
log "Step 5: Deploying on server..."
ssh -i "$DEPLOY_KEY" "${DEPLOY_USER}@${DEPLOY_HOST}" << EOF
    set -e
    cd ${DEPLOY_DIR}

    echo "Extracting package..."
    tar xzf ${PACKAGE_NAME}
    rm ${PACKAGE_NAME}

    echo "Installing production dependencies..."
    NODE_ENV=production pnpm install --prod

    echo "Generating Prisma client..."
    pnpm prisma:generate

    echo "Applying Prisma migrations..."
    pnpm prisma:migrate:deploy

    echo "Reloading application with PM2..."
    pm2 reload ecosystem.config.cjs --update-env || pm2 start ecosystem.config.cjs

    echo "Checking application status..."
    sleep 3
    pm2 status

    echo "Deployment completed successfully!"
EOF

log "Server deployment completed ✓"
echo ""

# Cleanup local package
rm "$PACKAGE_NAME"
log "Cleaned up local package"

# Final status check
echo ""
echo "========================================="
echo "  Deployment Successful!"
echo "========================================="
echo ""
info "Application URL: https://${DEPLOY_HOST}"
info "Check logs: ssh -i ${DEPLOY_KEY} ${DEPLOY_USER}@${DEPLOY_HOST} 'pm2 logs coc-agent'"
info "Check status: ssh -i ${DEPLOY_KEY} ${DEPLOY_USER}@${DEPLOY_HOST} 'pm2 status'"
echo ""

exit 0
