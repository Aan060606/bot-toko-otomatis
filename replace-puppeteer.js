const fs = require('fs');

let content = fs.readFileSync('index.js', 'utf-8');

// Hapus import puppeteer
content = content.replace(/const puppeteer = require\("puppeteer-extra"\);\nconst StealthPlugin = require\("puppeteer-extra-plugin-stealth"\);\npuppeteer\.use\(StealthPlugin\(\)\);\n/g, '');

// Hapus variabel browserInstance, bgPage, getBgPage, dan executeFetch
const regex = /let browserInstance = null;[\s\S]*?async function executeFetch\(page, method, url, body\) \{[\s\S]*?return JSON\.parse\(res\.body\);\n\}/;
content = content.replace(regex, '');

// Tulis ulang sawPost dan sawGet
const replaceNetworkFunctions = `async function sawPost(url, body) {
  try {
    const res = await axios.post(url, body, {
      headers: {
        'Origin': 'https://saweria.co',
        'Referer': 'https://saweria.co/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    return res.data;
  } catch (err) {
    throw new Error(\`Saweria API Error: \${err.response?.data ? JSON.stringify(err.response.data) : err.message}\`);
  }
}

async function sawGet(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'Origin': 'https://saweria.co',
        'Referer': 'https://saweria.co/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    return res.data;
  } catch (err) {
    throw new Error(\`Saweria API Error: \${err.response?.data ? JSON.stringify(err.response.data) : err.message}\`);
  }
}`;

content = content.replace(/async function sawPost[\s\S]*?async function sawGet[^\}]+?\}/, replaceNetworkFunctions);

fs.writeFileSync('index.js', content);
console.log("Puppeteer replaced with Axios successfully.");
