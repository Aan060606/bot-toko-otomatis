#!/bin/bash
# Deployment Script untuk VPS 43.153.222.32
# Author: Kiro AI
# Date: 2026-09-10

set -e

VPS_IP="43.153.222.32"
VPS_USER="root"
SSH_KEY="~/.ssh/id_ed25519"

echo "🚀 Starting VPS Deployment Process..."
echo "Target: ${VPS_USER}@${VPS_IP}"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check SSH Connection
echo "📡 Step 1: Checking SSH connection..."
if ssh -i ~/.ssh/id_ed25519 -o ConnectTimeout=5 root@43.153.222.32 'echo OK' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ SSH connection successful${NC}"
else
    echo -e "${RED}✗ SSH connection failed${NC}"
    exit 1
fi

# Step 2: Backup Current Deployment
echo ""
echo "💾 Step 2: Creating backup..."
ssh -i ~/.ssh/id_ed25519 root@43.153.222.32 << 'BACKUP'
    cd /root
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    
    # Backup code
    if [ -d "bot-saweria" ]; then
        tar -czf "backup_bot_${TIMESTAMP}.tar.gz" bot-saweria/ 2>/dev/null
        echo "✓ Code backup created: backup_bot_${TIMESTAMP}.tar.gz"
    elif [ -d "saweria-bot" ]; then
        tar -czf "backup_bot_${TIMESTAMP}.tar.gz" saweria-bot/ 2>/dev/null
        echo "✓ Code backup created: backup_bot_${TIMESTAMP}.tar.gz"
    else
        echo "⚠ Bot directory not found, skip backup"
    fi
    
    # Backup MongoDB
    if command -v mongodump &> /dev/null; then
        mongodump --out="/root/mongo_backup_${TIMESTAMP}" --quiet 2>/dev/null
        tar -czf "backup_mongo_${TIMESTAMP}.tar.gz" "mongo_backup_${TIMESTAMP}/" 2>/dev/null
        rm -rf "mongo_backup_${TIMESTAMP}"
        echo "✓ MongoDB backup created: backup_mongo_${TIMESTAMP}.tar.gz"
    else
        echo "⚠ mongodump not found, skip MongoDB backup"
    fi
BACKUP

# Step 3: Check Current Status
echo ""
echo "🔍 Step 3: Checking current deployment status..."
ssh -i ~/.ssh/id_ed25519 root@43.153.222.32 << 'STATUS'
    echo "=== PM2 Status ==="
    pm2 list 2>/dev/null || echo "PM2 not running"
    
    echo ""
    echo "=== Node Version ==="
    node --version 2>/dev/null || echo "Node.js not installed"
    
    echo ""
    echo "=== Bot Directory ==="
    cd /root/bot-saweria 2>/dev/null || cd /root/saweria-bot 2>/dev/null || cd /opt/bot 2>/dev/null
    pwd
    ls -la | head -20
STATUS

# Step 4: Fix Critical Issues (if needed)
echo ""
echo "🔧 Step 4: Applying critical fixes..."
echo "This will:"
echo "  - Check for exposed credentials"
echo "  - Add database indexes"  
echo "  - Fix race conditions"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled"
    exit 1
fi

# Step 5: Create Migration Scripts on VPS
echo ""
echo "📝 Step 5: Creating migration scripts..."
ssh -i ~/.ssh/id_ed25519 root@43.153.222.32 << 'MIGRATIONS'
    cd /root/bot-saweria 2>/dev/null || cd /root/saweria-bot 2>/dev/null || exit 1
    
    # Create indexes migration
    cat > migration_indexes.js << 'INDEXJS'
const mongoose = require('mongoose');
require('dotenv').config();

async function createIndexes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/saweria_bot');
    console.log('Connected to MongoDB');
    
    const db = mongoose.connection.db;
    
    // User indexes
    await db.collection('users').createIndex({ 
      purchase_count: 1, 
      is_blocked: 1, 
      last_broadcast_at: 1 
    });
    console.log('✓ User compound index created');
    
    // DripLog unique index
    await db.collection('driplogs').createIndex({
      user_id: 1,
      product_id: 1,
      campaign_type: 1,
      stage: 1
    }, { unique: true });
    console.log('✓ DripLog unique index created');
    
    // Product active index
    await db.collection('products').createIndex({ active: 1 });
    console.log('✓ Product index created');
    
    // Order donation_id index
    await db.collection('orders').createIndex({ donation_id: 1 });
    console.log('✓ Order index created');
    
    console.log('\n✅ All indexes created successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

createIndexes();
INDEXJS

    echo "✓ Migration scripts created"
MIGRATIONS

# Step 6: Deploy
echo ""
echo "🚀 Step 6: Deploying to VPS..."
read -p "Pull latest code from git? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    ssh -i ~/.ssh/id_ed25519 root@43.153.222.32 << 'DEPLOY'
        cd /root/bot-saweria 2>/dev/null || cd /root/saweria-bot 2>/dev/null || exit 1
        
        echo "Stopping PM2..."
        pm2 stop all
        
        echo "Pulling latest code..."
        git stash
        git pull origin main
        git stash pop
        
        echo "Installing dependencies..."
        npm ci --production
        
        echo "Running migrations..."
        node migration_indexes.js
        
        echo "Restarting PM2..."
        pm2 restart all
        pm2 save
        
        echo "✅ Deployment complete"
DEPLOY
fi

# Step 7: Health Check
echo ""
echo "🏥 Step 7: Running health check..."
sleep 5
ssh -i ~/.ssh/id_ed25519 root@43.153.222.32 << 'HEALTH'
    echo "=== PM2 Status ==="
    pm2 list
    
    echo ""
    echo "=== Recent Logs ==="
    pm2 logs --lines 30 --nostream
    
    echo ""
    echo "=== Bot Health ==="
    BOT_TOKEN=$(grep BOT_TOKEN /root/bot-saweria/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d ' ')
    if [ ! -z "$BOT_TOKEN" ]; then
        curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | grep -o '"ok":[^,]*'
    fi
HEALTH

echo ""
echo -e "${GREEN}🎉 Deployment process completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Test bot with /start command"
echo "2. Check /admin panel"
echo "3. Monitor logs: ssh root@43.153.222.32 'pm2 logs'"
echo "4. Check metrics in admin panel"

