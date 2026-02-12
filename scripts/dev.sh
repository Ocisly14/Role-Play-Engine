#!/bin/bash

# Development script for CoC Multi-Agent System
# Runs the development server with proper environment setup

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting CoC Multi-Agent Development Environment${NC}"

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  No .env file found. Please create one with your API keys.${NC}"
    echo "Example .env content:"
    echo "OPENAI_API_KEY=your_openai_api_key_here"
    echo "ANTHROPIC_API_KEY=your_anthropic_api_key_here"
    echo ""
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    pnpm install
fi

# Ensure Prisma client is generated
echo -e "${BLUE}🔧 Generating Prisma client...${NC}"
pnpm prisma:generate

# Start development server
echo -e "${GREEN}🎯 Starting development server...${NC}"
echo -e "${GREEN}Press Ctrl+C to stop${NC}"
echo ""

pnpm dev
