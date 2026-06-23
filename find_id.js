const { execFile } = require("child_process");

const CURL_HEADERS = [
  "-H", "Accept: */*",
  "-H", "Accept-Encoding: gzip, deflate, br, zstd",
  "-H", "Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "-H", "DNT: 1",
  "-H", "Origin: https://saweria.co",
  "-H", "Priority: u=1, i",
  "-H", "Referer: https://saweria.co/",
  "-H", "Sec-Fetch-Dest: empty",
  "-H", "Sec-Fetch-Mode: cors",
  "-H", "Sec-Fetch-Site: same-site",
  "-H", 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "-H", "sec-ch-ua-mobile: ?0",
  "-H", "sec-ch-ua-platform: \"Windows\"",
  "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
];

const username = "AdminJsub";
const url = `https://saweria.co/${username}`;

console.log(`Fetching ${url}...`);

const args = ["-s", "--compressed", "-m", "30", url, ...CURL_HEADERS];
execFile("curl", args, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
  if (err) {
    console.error("Error fetching:", err);
    return;
  }
  
  // Search for UUIDs in the HTML
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
  const matches = stdout.match(uuidRegex);
  
  if (matches) {
    // Unique matches
    const unique = [...new Set(matches)];
    console.log("Found UUIDs in HTML:", unique);
  } else {
    console.log("No UUIDs found. Maybe Cloudflare blocked it, or it's not in HTML.");
    console.log("First 500 chars of response:", stdout.slice(0, 500));
  }
});
