/**
 * Let's Talk Running — BookMyShow Scraper (Firecrawl)
 *
 * Scrapes running events from BookMyShow across 6 cities using Firecrawl API.
 * Saves results to ../data/bms-events.json for merging into the main races.json.
 *
 * Run manually:  node backend/scrape-bms.js
 * Scheduled via: GitHub Actions (.github/workflows/scrape-bms.yml) — weekly
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs   = require('fs');

const OUT_DIR      = path.join(__dirname, '..', 'data');
const OUT_FILE     = path.join(OUT_DIR, 'bms-events.json');
const CF_FILE      = path.join(__dirname, '..', 'functions', 'api', '_bms-events.js');

const BMS_URLS = [
  { url: 'https://in.bookmyshow.com/explore/sports-bengaluru?categories=running',                city: 'Bengaluru' },
  { url: 'https://in.bookmyshow.com/explore/sports-mumbai?categories=running',                   city: 'Mumbai' },
  { url: 'https://in.bookmyshow.com/explore/sports-national-capital-region-ncr?categories=running', city: 'Delhi NCR' },
  { url: 'https://in.bookmyshow.com/explore/sports-hyderabad?categories=running',                city: 'Hyderabad' },
  { url: 'https://in.bookmyshow.com/explore/sports-pune?categories=running',                     city: 'Pune' },
  { url: 'https://in.bookmyshow.com/explore/sports-chennai?categories=running',                  city: 'Chennai' },
];

async function main() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.error('❌ FIRECRAWL_API_KEY not set');
    process.exit(1);
  }

  // Dynamic import for ESM-only package
  const { FirecrawlClient } = await import('@mendable/firecrawl-js');
  const firecrawl = new FirecrawlClient({ apiKey });

  console.log(`\n🎟️  BMS Scraper — ${new Date().toISOString()}\n`);

  const allEvents = [];

  for (const { url, city } of BMS_URLS) {
    try {
      console.log(`  Scraping ${city}...`);
      const result = await firecrawl.scrape(url, { formats: ['markdown'] });

      if (!result?.markdown) {
        console.warn(`  ✗ ${city} — no markdown returned`);
        continue;
      }

      const events = parseBookMyShowMarkdown(result.markdown, city);
      console.log(`  ✓ ${city} — ${events.length} events`);
      allEvents.push(...events);
    } catch (err) {
      console.warn(`  ✗ ${city} — ${err.message}`);
    }
  }

  // Deduplicate by BMS event ID
  const seen = new Set();
  const unique = allEvents.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  const payload = {
    events: unique,
    total: unique.length,
    fetchedAt: new Date().toISOString(),
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  // Also generate the Cloudflare Functions module
  const cfContent = `/**
 * Auto-generated BMS events for Cloudflare Pages Functions.
 *
 * This file is updated weekly by the BMS scraper GitHub Action.
 * Do NOT edit manually — changes will be overwritten.
 * Last updated: ${new Date().toISOString()}
 */

export const bmsEvents = ${JSON.stringify(unique, null, 2)};
`;
  fs.writeFileSync(CF_FILE, cfContent);

  console.log(`\n✅ Saved ${unique.length} BMS events to ${OUT_FILE}`);
  console.log(`✅ Updated ${CF_FILE}\n`);
}

/**
 * Parse Firecrawl markdown output from a BMS sports/running page.
 *
 * Each event card in the markdown looks like:
 *   [![Title](image-url)\\\n\\\nTitle\\\n\\\nVenue\\\n\\\nCategory\\\n\\\n₹ price\\\n\\\n**Title**](event-url)
 */
function parseBookMyShowMarkdown(markdown, defaultCity) {
  const events = [];

  // Match each event block: [![...](image)]...](bms-event-url)
  // Using dotAll (s) flag since blocks span multiple lines
  const eventBlocks = markdown.match(/\[!\[.+?\]\(https:\/\/in\.bookmyshow\.com\/sports\/[^)]+\)/gs) || [];

  for (const block of eventBlocks) {
    try {
      // Extract the BMS event URL
      const urlMatch = block.match(/\]\((https:\/\/in\.bookmyshow\.com\/sports\/[^)]+)\)$/);
      if (!urlMatch) continue;
      const eventUrl = urlMatch[1];

      // Extract event ID from URL (e.g., ET00484807)
      const idMatch = eventUrl.match(/\/(ET\d+)$/);
      if (!idMatch) continue;
      const bmsId = idMatch[1];

      // Split by double-backslash + newline + double-backslash + newline
      // Raw markdown uses \\\n\\\n as field separators
      const parts = block.split(/\\\\\n\\\\\n/).map(s => s.trim()).filter(Boolean);

      // parts layout:
      //   [0]: [![Title](image-url)
      //   [1]: Title
      //   [2]: Venue
      //   [3]: Category (e.g., "Marathon", "5k")
      //   [4]: Price (e.g., "₹ 100", "₹ 199 onwards")
      //   [5]: **Title**](event-url)
      let title = '';
      let venue = '';
      let category = '';
      let price = null;

      if (parts.length >= 2) title = parts[1];
      if (parts.length >= 3) venue = parts[2];
      if (parts.length >= 4) category = parts[3];
      if (parts.length >= 5) {
        const priceField = parts.find(f => f.includes('₹') && !f.startsWith('[!['));
        if (priceField) price = priceField.replace(/\s+/g, ' ').trim();
      }

      if (!title) continue;

      // Parse date from the image URL (base64 encoded date label)
      // e.g., "ie-U3VuLCA4IE1hcg%3D%3D" -> decode URL then base64 -> "Sun, 8 Mar"
      let startDate = null;
      const dateB64Match = block.match(/ie-([A-Za-z0-9+/%=]+),/);
      if (dateB64Match) {
        try {
          const b64 = decodeURIComponent(dateB64Match[1]);
          const decoded = Buffer.from(b64, 'base64').toString('utf-8');
          startDate = parseBmsDate(decoded);
        } catch (_) {}
      }

      // Infer distances from title and category
      const distances = inferDistances(title + ' ' + category);

      events.push({
        id:        `bms-${bmsId}`,
        title:     title.trim(),
        city:      defaultCity,
        state:     '',
        startDate,
        endDate:   startDate,
        distances,
        price,
        rating:    null,
        organizer: '',
        url:       eventUrl,
        source:    'bookmyshow.com',
        region:    'India',
      });
    } catch (_) {
      // Skip malformed blocks
    }
  }

  return events;
}

/**
 * Parse BMS date label like "Sun, 8 Mar" or "Sun, 19 Apr" into YYYY-MM-DD.
 * Assumes current year or next year if the date has already passed.
 */
function parseBmsDate(dateStr) {
  if (!dateStr) return null;

  // Handle "onwards" suffix
  const clean = dateStr.replace(/\s*onwards$/i, '').trim();

  const now = new Date();
  const currentYear = now.getFullYear();

  // Try parsing with current year
  const withYear = `${clean} ${currentYear}`;
  let d = new Date(withYear + ' UTC');

  if (isNaN(d)) return null;

  // If date already passed, assume next year
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    d = new Date(`${clean} ${currentYear + 1} UTC`);
  }

  return d.toISOString().split('T')[0];
}

function inferDistances(name) {
  const n = name.toLowerCase();
  const distances = [];
  if (/\b3\s*k/i.test(n)) distances.push('3K');
  if (/\b5\s*k/i.test(n)) distances.push('5K');
  if (/\b10\s*k/i.test(n)) distances.push('10K');
  if (/half\s*marathon|21\s*k/i.test(n)) distances.push('Half Marathon');
  if (/(?<!half\s)(?<!ultra\s)marathon|42\s*k/i.test(n) && !/half/i.test(n) && !/ultra/i.test(n)) distances.push('Marathon');
  if (/ultra/i.test(n)) distances.push('Ultra');
  return distances;
}

main().catch(err => {
  console.error('❌ BMS Scraper failed:', err.message);
  process.exit(1);
});
