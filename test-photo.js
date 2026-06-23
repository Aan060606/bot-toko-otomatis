const { Telegraf } = require("telegraf");
const fs = require("fs");
require("dotenv").config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const chatId = process.env.ADMIN_CHAT_ID;
const qrPath = "/tmp/qr_2192d42c-6b68-4bfd-b8c2-0b787af2f2bd.png";

async function test() {
  try {
    console.log("Sending photo using file path...");
    await bot.telegram.sendPhoto(chatId, { source: qrPath }, { caption: "Test File Path" });
    console.log("File path SUCCESS!");
  } catch (e) {
    console.log("File path ERROR:", e.message);
  }

  try {
    console.log("Sending photo using buffer...");
    const buf = fs.readFileSync(qrPath);
    await bot.telegram.sendPhoto(chatId, { source: buf }, { caption: "Test Buffer" });
    console.log("Buffer SUCCESS!");
  } catch (e) {
    console.log("Buffer ERROR:", e.message);
  }
}
test();
