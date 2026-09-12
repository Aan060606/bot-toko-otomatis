#!/bin/bash

VPS_IP="43.153.222.32"
SSH_KEY="~/.ssh/id_ed25519"

echo "=== CONNECTING TO VPS ==="
ssh -i ~/.ssh/id_ed25519 root@43.153.222.32 << 'ENDSSH'
set -e

echo "=== SYSTEM INFO ==="
uname -a
echo ""

echo "=== DISK USAGE ==="
df -h
echo ""

echo "=== MEMORY USAGE ==="
free -h
echo ""

echo "=== NODEJS VERSION ==="
node --version
npm --version
echo ""

echo "=== PM2 STATUS ==="
pm2 list
echo ""

echo "=== BOT DIRECTORY ==="
cd /root/bot-saweria 2>/dev/null || cd /root/saweria-bot 2>/dev/null || cd /opt/bot 2>/dev/null || echo "Bot directory not found in standard locations"
pwd
ls -la
echo ""

echo "=== GIT STATUS ==="
git status 2>/dev/null || echo "Not a git repository"
echo ""

echo "=== RECENT LOGS ==="
pm2 logs --lines 20 --nostream 2>/dev/null || echo "No PM2 logs"
echo ""

echo "=== MONGODB STATUS ==="
systemctl status mongod --no-pager 2>/dev/null || echo "MongoDB not running as systemd service"
echo ""

echo "=== ENVIRONMENT CHECK ==="
ls -la .env 2>/dev/null && echo ".env file exists" || echo ".env file not found"
echo ""

echo "=== PACKAGE.JSON ==="
cat package.json 2>/dev/null | head -20 || echo "package.json not found"

ENDSSH

echo ""
echo "=== AUDIT COMPLETE ==="
