/**
 * ASICS India Running Shoes Scraper
 *
 * Scrapes all men's running shoes from asics.co.in using Firecrawl
 * and saves structured data to ../data/shoes.json
 *
 * Run: node backend/scrape-asics.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');

const OUT_DIR  = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(OUT_DIR, 'shoes.json');

(async () => {
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js');
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  const allShoes = [];
  const BASE_URL = 'https://www.asics.co.in/men/shoes/running.html';
  const MAX_PAGES = 20;

  console.log(`\n👟 ASICS India Scraper — ${new Date().toISOString()}\n`);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    console.log(`Scraping page ${page}... (${url})`);

    const result = await app.scrape(url, { formats: ['markdown'] });
    const md = result.markdown || '';

    // Extract shoe entries: [NAME](url) → category → price
    const shoePattern = /\[([A-Z][A-Z0-9\s\-™.&']+)\]\(https:\/\/www\.asics\.co\.in\/[^\)]+\.html\)\s*\n\s*\n\s*((?:Men|Women|Unisex)[^\n]*)\s*\n\s*\n\s*(₹[\d,]+(?:\s*₹[\d,]+)?)/g;

    let match;
    let pageCount = 0;
    while ((match = shoePattern.exec(md)) !== null) {
      const name     = match[1].trim();
      const category = match[2].trim();
      const rawPrice = match[3].trim();

      // Extract URL
      const linkRx = new RegExp(
        `\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\((https://www\\.asics\\.co\\.in/[^)]+)\\)`
      );
      const linkMatch = md.match(linkRx);
      const shoeUrl   = linkMatch ? linkMatch[1] : '';

      // Parse price — may be "₹16,999" or "₹16,999\n\n₹13,599" (original + sale)
      const prices = rawPrice.match(/₹[\d,]+/g) || [];
      const price     = prices[0] || rawPrice;
      const salePrice = prices.length > 1 ? prices[1] : null;

      allShoes.push({ name, category, price, salePrice, url: shoeUrl });
      pageCount++;
    }

    console.log(`  → ${pageCount} shoes`);

    if (pageCount === 0) {
      console.log('  → No shoes found, stopping.');
      break;
    }

    if (page < MAX_PAGES) await new Promise(r => setTimeout(r, 1000));
  }

  // Deduplicate by model name — keep first URL, count colorways
  const modelMap = new Map();
  for (const shoe of allShoes) {
    if (!modelMap.has(shoe.name)) {
      modelMap.set(shoe.name, { ...shoe, colorways: 1 });
    } else {
      modelMap.get(shoe.name).colorways++;
    }
  }

  const shoes = [...modelMap.values()].sort((a, b) => {
    const pa = parseInt(a.price.replace(/[₹,]/g, ''));
    const pb = parseInt(b.price.replace(/[₹,]/g, ''));
    return pb - pa;
  });

  const payload = {
    shoes,
    total:        allShoes.length,
    uniqueModels: shoes.length,
    fetchedAt:    new Date().toISOString(),
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  console.log(`\n✅ ${shoes.length} unique models (${allShoes.length} total listings) → ${OUT_FILE}\n`);
})();
