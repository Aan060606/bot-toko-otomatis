# 🔍 QA TOTAL & DEPLOYMENT CHECKLIST
Bot Telegram Saweria - Production Deployment Guide

Server: ssh -i ~/.ssh/id_ed25519 root@43.153.222.32

## 🚨 CRITICAL ISSUES (FIX FIRST!)

1. SECURITY: BOT_TOKEN exposed in .env
   ACTION: Revoke via @BotFather, generate new token

2. Race Condition: Marketing duplicate (atomic update needed)

3. Missing DB Indexes: Slow queries >10k users

4. Puppeteer Memory Leak: Browser never closed

## ✅ DEPLOYMENT STEPS

1. Backup current: tar -czf backup.tar.gz bot-saweria/
2. Pull code: git pull origin main
3. Install deps: npm ci --production
4. Run migrations: node scripts/create-indexes.js
5. Restart: pm2 restart saweria-bot
6. Verify: pm2 logs saweria-bot

Full checklist saved to file.
