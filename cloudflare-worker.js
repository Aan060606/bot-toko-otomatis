// Cloudflare Worker — Saweria API Proxy
// Deploy ini ke Cloudflare Workers (gratis, tanpa kartu kredit)
// Lalu set SAWERIA_API di Railway ke URL worker ini

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Forward ke backend Saweria
    const targetUrl = 'https://backend.saweria.co' + url.pathname + url.search;
    
    // Salin headers dari request asli, tambahkan headers browser
    const newHeaders = new Headers();
    newHeaders.set('Accept', '*/*');
    newHeaders.set('Accept-Language', 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7');
    newHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
    newHeaders.set('Origin', 'https://saweria.co');
    newHeaders.set('Referer', 'https://saweria.co/');
    newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36');
    newHeaders.set('sec-ch-ua', '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"');
    newHeaders.set('sec-ch-ua-mobile', '?0');
    newHeaders.set('sec-ch-ua-platform', '"Windows"');
    newHeaders.set('Sec-Fetch-Dest', 'empty');
    newHeaders.set('Sec-Fetch-Mode', 'cors');
    newHeaders.set('Sec-Fetch-Site', 'same-site');
    newHeaders.set('DNT', '1');
    
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.method !== 'GET' ? request.body : null,
    });
    
    const response = await fetch(proxyRequest);
    
    // Return response dengan CORS headers agar bisa diakses
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
    
    return newResponse;
  }
};
