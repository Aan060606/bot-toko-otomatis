const { Telegraf } = require("telegraf");
const bot = new Telegraf("8937182422:AAHviEDu8hyjBGuee854I4yZoO2DGE7XmNQ");
bot.telegram.sendMessage("7518626779", "👉 [KLIK DI SINI](https://mega.nz/folder/abc_def_ghi) 👈", { parse_mode: "Markdown" })
  .then(() => console.log("SUCCESS"))
  .catch(e => console.error(e.message));
