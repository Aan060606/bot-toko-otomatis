const { Telegraf } = require("telegraf");
const bot = new Telegraf("8937182422:AAHviEDu8hyjBGuee854I4yZoO2DGE7XmNQ");
bot.telegram.sendAnimation("7518626779", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif", { caption: "Test" })
  .then(() => console.log("SUCCESS"))
  .catch(e => console.error(e.message));
