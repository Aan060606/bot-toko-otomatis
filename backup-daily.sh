#!/bin/bash
# Script untuk membackup MongoDB secara lokal dengan retensi 7 hari
# Akan dijalankan via crontab setiap jam 02:00 WIB

BACKUP_DIR="/home/aan/Video/BOT AUTO PAY SAWERIA/Saweria-Payment-Module/backups"
DB_NAME="toko-otomatis"
DATE=$(date +%Y-%m-%d_%H-%M-%S)

mkdir -p "$BACKUP_DIR"

echo "Memulai backup database $DB_NAME pada $DATE..."
mongodump --db "$DB_NAME" --out "$BACKUP_DIR/$DATE"

echo "Backup selesai."

echo "Menghapus backup yang berumur lebih dari 7 hari..."
find "$BACKUP_DIR" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +

echo "Proses pembersihan selesai."
