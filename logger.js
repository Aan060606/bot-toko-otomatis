/**
 * ADVANCED LOGGER v2 — J-SUB VIP BOT
 * Perbaikan: amount FINAL di payment.success, admin alert otomatis,
 * health check self-diagnosis, campaign name tracking, daily summary.
 */
const fs   = require('fs');
const path = require('path');
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Anti-spam: simpan hash alert terakhir agar tidak kirim yang sama dalam 1 jam
let _lastAlertHash = null;
let _lastAlertTime = 0;

function jakartaTime() { return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); }
function todayFilename() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  return path.join(LOG_DIR, `bot-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.log`);
}
function writeToFile(entry) { try { fs.appendFileSync(todayFilename(), JSON.stringify(entry)+'\n'); } catch(_){} }

const _counts = {
  checkout_attempt:0, checkout_success:0,
  payment_success:0, payment_expired:0, payment_miss:0,
  cloudflare_hit:0, ws_caught:0,
  marketing_sent:0, marketing_skip:0, marketing_fail:0,
  user_blocked:0, high_intent_alert:0, reminder_sent:0,
  error_total:0, revenue_today:0,
};
let _bot=null, _adminId=null;

function log(level, category, message, meta={}) {
  const entry={ts:jakartaTime(),ts_utc:new Date().toISOString(),level,cat:category,msg:message,...meta};
  const icons={INFO:'ℹ️ ',SUCCESS:'✅',WARN:'⚠️ ',ERROR:'❌',DEBUG:'🔍'};
  const meta_str=Object.keys(meta).length?' | '+Object.entries(meta).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join(' '):'';
  const line=`[${entry.ts}] ${icons[level]||'•'} [${category}] ${message}${meta_str}`;
  if(level==='ERROR') console.error(line);
  else if(level==='WARN') console.warn(line);
  else if(level!=='DEBUG') console.log(line);
  writeToFile(entry);
  return entry;
}
function inc(key,amount=1){if(key in _counts)_counts[key]+=amount;}
async function alertAdmin(text){
  if(!_bot||!_adminId)return;
  try{await _bot.telegram.sendMessage(_adminId,text,{parse_mode:'HTML'});}catch(_){}
}

const logger={
  init(bot,adminChatId){_bot=bot;_adminId=adminChatId;},
  info(...m){log('INFO','SYSTEM',m.join(' '));},
  success(...m){log('SUCCESS','SYSTEM',m.join(' '));},
  warn(...m){log('WARN','SYSTEM',m.join(' '));},
  error(...m){log('ERROR','SYSTEM',m.join(' '));inc('error_total');},
  debug(...m){log('DEBUG','SYSTEM',m.join(' '));},

  checkout:{
    attempt(userId,productId,amount){inc('checkout_attempt');log('INFO','CHECKOUT','User memulai checkout',{userId,productId,amount});},
    qrCreated(userId,orderId,amount,donationId){inc('checkout_success');log('SUCCESS','CHECKOUT','QR Code berhasil dibuat',{userId,orderId,amount,donationId});},
    failed(userId,error){inc('error_total');log('ERROR','CHECKOUT','Checkout gagal',{userId,error:String(error).slice(0,200)});},
    bundleAttempt(userId,productIds,amount){log('INFO','CHECKOUT','User memulai checkout bundle',{userId,productIds,amount});},
    userBlocked(userId){log('WARN','CHECKOUT','User memblokir bot saat checkout',{userId});},
  },

  payment:{
    success(orderId,userId,amount,method){
      inc('payment_success');
      if(amount>0)inc('revenue_today',amount);
      log('SUCCESS','PAYMENT','Pembayaran dikonfirmasi',{orderId,userId,amount,method:method||'poll',revenue_today_total:_counts.revenue_today});
      const fmt=amount>0?`Rp${amount.toLocaleString('id-ID')}`:'(jumlah manual)';
      alertAdmin(`💰 <b>PEMBAYARAN MASUK!</b>\n\nUser: <code>${userId}</code>\nAmount: <b>${fmt}</b>\nOrder: <code>${orderId}</code>\nMethod: ${method||'poll'}\n\n📈 Revenue hari ini: <b>Rp${_counts.revenue_today.toLocaleString('id-ID')}</b>`);
    },
    expired(orderId,userId,amount,reason){inc('payment_expired');log('WARN','PAYMENT','Order expired',{orderId,userId,amount,reason:reason||'timeout'});},
    delivered(orderId,userId,productCount){log('SUCCESS','PAYMENT','Produk berhasil dikirim ke user',{orderId,userId,productCount});},
    reminderSent(userId,orderId){inc('reminder_sent');log('INFO','PAYMENT','Countdown reminder dikirim (5 menit sebelum expire)',{userId,orderId});},
    wsCaught(donationId,userId){inc('ws_caught');log('SUCCESS','PAYMENT','Pembayaran ditangkap via WebSocket',{donationId,userId});},
    missDetected(donationId,userId,amount){
      inc('payment_miss');
      log('ERROR','PAYMENT','PAYMENT MISS — Masuk Saweria tapi tidak terdeteksi bot!',{donationId,userId,amount});
      alertAdmin(`🚨 <b>PAYMENT MISS!</b>\n\nUser: <code>${userId}</code>\nAmount: <b>Rp${amount?.toLocaleString('id-ID')||'?'}</b>\nDonationID: <code>${donationId}</code>\n\n<b>Aksi:</b> Cek Saweria dashboard dan kirim link manual ke user.`);
    },
  },

  cloudflare:{
    hit(donationId,attempt){inc('cloudflare_hit');log('WARN','CLOUDFLARE','Terkena Cloudflare challenge',{donationId,attempt});},
    cleared(donationId){log('SUCCESS','CLOUDFLARE','Cloudflare clearance berhasil',{donationId});},
    gaveUp(donationId,totalAttempts){
      log('ERROR','CLOUDFLARE','Cloudflare tidak bisa di-bypass',{donationId,totalAttempts});
      alertAdmin(`⚠️ <b>Cloudflare Block Permanen</b>\nDonationID: <code>${donationId}</code>\nCheckout mungkin gagal. Pertimbangkan restart bot.`);
    },
  },

  marketing:{
    sent(userId,userName,campaign,reason){inc('marketing_sent');log('SUCCESS','MARKETING','Pesan marketing terkirim',{userId,userName,campaign,reason});},
    skipped(userId,userName,campaign,reason){inc('marketing_skip');log('DEBUG','MARKETING','User di-skip',{userId,userName,campaign,reason});},
    failed(userId,campaign,error){inc('marketing_fail');log('ERROR','MARKETING','Gagal kirim marketing',{userId,campaign,error:String(error).slice(0,150)});},
    runStart(hour){log('INFO','MARKETING','Campaign run dimulai',{hour});},
    runEnd(stats){
      log('INFO','MARKETING','Campaign run selesai',{stats});
      const total=(stats.cold||0)+(stats.crossSell||0)+(stats.cartAbandon1h||0)+(stats.cartAbandon3h||0)+(stats.cartAbandon12h||0)+(stats.stage2||0)+(stats.stage3||0);
      if(total>0){alertAdmin(`📊 <b>Campaign Selesai</b>\n\nNon-Buyer: ${stats.cold||0} | Cross-Sell: ${stats.crossSell||0}\nCart Abandon: ${(stats.cartAbandon1h||0)+(stats.cartAbandon3h||0)+(stats.cartAbandon12h||0)}\nPost-Purchase: ${(stats.stage2||0)+(stats.stage3||0)+(stats.complete||0)}\nSkip: ${stats.skipped||0} | Fail: ${stats.failed||0}`);}
    },
    highIntentAlert(userId,userName,abandonCount,orderId){inc('high_intent_alert');log('WARN','MARKETING','🔥 HIGH-INTENT BUYER ALERT terkirim ke admin',{userId,userName,abandonCount,orderId});},
  },

  drip:{
    stageSent(userId,productId,stage,campaign){log('SUCCESS','DRIP',`Drip stage ${stage} terkirim`,{userId,productId,stage,campaign});},
    converted(userId,productId,orderId){log('SUCCESS','DRIP','Drip converted → user beli!',{userId,productId,orderId});},
    skipped(userId,productId,stage,reason){log('DEBUG','DRIP','Drip di-skip',{userId,productId,stage,reason});},
  },

  user:{
    new(userId,userName,source){log('INFO','USER','User baru masuk bot',{userId,userName,source:source||'direct'});},
    blocked(userId,reason){inc('user_blocked');log('WARN','USER','User memblok bot',{userId,reason});},
    cartAdd(userId,productId,productName){log('INFO','USER','User tambah ke keranjang',{userId,productId,productName});},
  },

  system:{
    start(version){log('SUCCESS','SYSTEM','🚀 Bot started',{version,node:process.version});},
    mongoConnected(){log('SUCCESS','SYSTEM','MongoDB terhubung');},
    cronFired(hour){log('INFO','SYSTEM','Cron marketing fired',{hour});},
    wsConnected(streamer){log('SUCCESS','SYSTEM','WebSocket Saweria terhubung',{streamer});},
    wsDisconnected(streamer,reason){log('WARN','SYSTEM','WebSocket Saweria terputus',{streamer,reason});},
    memoryUsage(){
      const mem=process.memoryUsage();
      log('DEBUG','SYSTEM','Memory usage',{rss_mb:Math.round(mem.rss/1024/1024),heap_mb:Math.round(mem.heapUsed/1024/1024)});
    },
    async healthCheck(db){
      try{
        const {Order,Stock,DripLog,Discount,Product}=db;
        const issues=[];
        const stuck=await Order.countDocuments({status:'PENDING',created_at:{$lt:new Date(Date.now()-20*60000)}});
        if(stuck>0)issues.push(`🔴 ${stuck} order STUCK PENDING >20 menit`);
        const prods=await Product.find({active:1}).lean();
        for(const p of prods){
          // [FIX] Produk digital (type:'digital' atau punya restock) auto-restock setelah terjual
          // → jangan pernah flag sebagai "stok kritis" karena selalu ada 1 sisa setelah restock
          if(p.type==='digital'||p.type==='unlimited'||p.restock_on_sold) continue;
          const avail=await Stock.countDocuments({product_id:String(p._id),status:'AVAILABLE'});
          if(avail===0)issues.push(`🔴 STOK HABIS: ${p.name} — tambah segera!`);
          else if(avail<=2)issues.push(`🟡 Stok kritis (${avail} sisa): ${p.name}`);
        }
        const leaked=await Discount.countDocuments({active:true,valid_until:{$lt:new Date()}});
        if(leaked>0){await Discount.updateMany({active:true,valid_until:{$lt:new Date()}},{$set:{active:false}});log('INFO','SYSTEM',`Health: Auto-fixed ${leaked} diskon expired`);}
        // [FIX] Query duplikat pakai 4-field key sesuai unique index yang ada di DB
        const dups=await DripLog.aggregate([{$group:{_id:{u:'$user_id',p:'$product_id',c:'$campaign_type',s:'$stage'},n:{$sum:1}}},{$match:{n:{$gt:1}}}]);
        if(dups.length>5)issues.push(`🟡 ${dups.length} grup DripLog duplikat`);
        const todayStart=new Date();todayStart.setHours(0,0,0,0);
        const rev=await Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:todayStart}}},{$group:{_id:null,r:{$sum:'$total_amount'},c:{$sum:1}}}]);
        const todayRev=rev[0]?.r||0,todayCount=rev[0]?.c||0;
        _counts.revenue_today=todayRev;
        _counts.payment_success=Math.max(_counts.payment_success,todayCount);
        log('INFO','SYSTEM','Health check selesai',{stuck_pending:stuck,leaked_discounts:leaked,dup_drips:dups.length,revenue_today:todayRev,orders_today:todayCount,issues:issues.length});
        if(issues.length>0){
          // [FIX SPAM] Hanya kirim alert jika isu berbeda dari yang terakhir ATAU sudah >1 jam
          const alertHash=issues.join('|');
          const now=Date.now();
          const isNewIssue=alertHash!==_lastAlertHash;
          const isCooldownExpired=(now-_lastAlertTime)>60*60*1000; // 1 jam
          if(isNewIssue||isCooldownExpired){
            _lastAlertHash=alertHash;
            _lastAlertTime=now;
            await alertAdmin(`🏥 <b>Health Check — ${issues.length} Masalah</b>\n\n`+issues.map(i=>`• ${i}`).join('\n')+`\n\nRevenue hari ini: <b>Rp${todayRev.toLocaleString('id-ID')}</b> (${todayCount} order)`);
          } else {
            log('DEBUG','SYSTEM','Health check alert di-skip (sama dengan sebelumnya, cooldown 1 jam)');
          }
        } else {
          // Reset hash kalau tidak ada masalah — agar masalah baru berikutnya selalu terkirim
          _lastAlertHash=null;
        }
        return{issues,todayRev,todayCount};
      }catch(err){log('ERROR','SYSTEM','Health check error: '+err.message);return{issues:['Error: '+err.message],todayRev:0,todayCount:0};}
    },
  },

  summary(){
    const total=_counts.checkout_attempt,success=_counts.payment_success;
    const convRate=total>0?((success/total)*100).toFixed(1):'0';
    log('INFO','SUMMARY','═══ RINGKASAN HARIAN ═══',{..._counts,conv_rate_pct:convRate+'%'});
    alertAdmin(`📊 <b>RINGKASAN HARI INI</b>\n\n💰 Revenue: <b>Rp${_counts.revenue_today.toLocaleString('id-ID')}</b> (${success} order)\n🛒 Checkout: ${total} → ${success} sukses (${convRate}%)\n⏰ Expired: ${_counts.payment_expired} | 🚨 Miss: ${_counts.payment_miss}\n📱 Marketing: ${_counts.marketing_sent} terkirim | ${_counts.user_blocked} block\n☁️ CF: ${_counts.cloudflare_hit} hits | ❌ Error: ${_counts.error_total}`);
    return{..._counts,conv_rate_pct:convRate+'%'};
  },

  getCounts(){return{..._counts};},
};

module.exports=logger;
