/**
 * Let's Talk Running — Standalone Race Scraper
 *
 * Fetches events from all sources and saves the result to
 * ../data/races.json so Cloudflare Pages can serve it as a static file.
 *
 * Run manually:  node backend/scrape-to-file.js
 * Scheduled via: GitHub Actions (.github/workflows/scrape-races.yml)
 */

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');

// ─── Output path ──────────────────────────────────────────────────────────────
const OUT_DIR  = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(OUT_DIR, 'races.json');

// ─── Shared HTTP headers ──────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🏃 LTR Race Scraper — ${new Date().toISOString()}\n`);

  const events = await fetchAllEvents();

  const payload = {
    events,
    total:     events.length,
    fetchedAt: new Date().toISOString(),
    cached:    false,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  console.log(`\n✅ Saved ${events.length} events to ${OUT_FILE}\n`);
}

// ─── Fetch & merge all sources ────────────────────────────────────────────────
async function fetchAllEvents() {
  const [r1, r2, r3, r4, r5] = await Promise.allSettled([
    fetchIndiaRunning(),
    fetchBhaagoIndia(),
    fetchTownscript(),
    fetchMySamay(),
    fetchCityWoofer(),
  ]);

  let events = [];
  if (r1.status === 'fulfilled') { console.log(`✓ indiarunning.com — ${r1.value.length} events`); events.push(...r1.value); }
  else                           { console.warn(`✗ indiarunning.com — ${r1.reason?.message}`); }

  if (r2.status === 'fulfilled') { console.log(`✓ bhaagoindia.com  — ${r2.value.length} events`); events.push(...r2.value); }
  else                           { console.warn(`✗ bhaagoindia.com  — ${r2.reason?.message}`); }

  if (r3.status === 'fulfilled') { console.log(`✓ townscript.com   — ${r3.value.length} events`); events.push(...r3.value); }
  else                           { console.warn(`✗ townscript.com   — ${r3.reason?.message}`); }

  if (r4.status === 'fulfilled') { console.log(`✓ mysamay.in       — ${r4.value.length} events`); events.push(...r4.value); }
  else                           { console.warn(`✗ mysamay.in       — ${r4.reason?.message}`); }

  if (r5.status === 'fulfilled') { console.log(`✓ citywoofer.com   — ${r5.value.length} events`); events.push(...r5.value); }
  else                           { console.warn(`✗ citywoofer.com   — ${r5.reason?.message}`); }

  // Manual events (BookMyShow, etc.)
  const manual = loadManualEvents();
  if (manual.length) { console.log(`✓ manual-events    — ${manual.length} events`); events.push(...manual); }

  // BMS auto-scraped events (from weekly Firecrawl run)
  const bms = loadBmsEvents();
  if (bms.length) { console.log(`✓ bookmyshow.com   — ${bms.length} events`); events.push(...bms); }

  // Deduplicate by normalised title + date
  const seen = new Set();
  events = events.filter(e => {
    const key = `${(e.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 28)}-${e.startDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Remove past events
  const todayMs = new Date().setHours(0, 0, 0, 0);
  events = events.filter(e => e.startDate && new Date(e.startDate).getTime() >= todayMs);

  // Sort ascending by start date
  events.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  console.log(`→ Total unique upcoming events: ${events.length}`);
  return events;
}

// ─── Scraper: indiarunning.com ────────────────────────────────────────────────
async function fetchIndiaRunning() {
  const URLS = [
    'https://www.indiarunning.com/',
    'https://www.indiarunning.com/distance/5k',
    'https://www.indiarunning.com/distance/10k',
    'https://www.indiarunning.com/distance/half-marathon',
    'https://www.indiarunning.com/distance/marathon',
    'https://www.indiarunning.com/distance/ultra-marathon',
  ];

  const seen = new Map();

  for (const url of URLS) {
    try {
      const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15000 });

      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) { console.warn(`  indiarunning.com: no __NEXT_DATA__ at ${url}`); continue; }

      const nextData = JSON.parse(m[1]);

      const candidates = [
        nextData?.props?.pageProps?.eventsData?.events,
        nextData?.props?.pageProps?.events,
        nextData?.props?.pageProps?.data?.events,
      ];
      const events = candidates.find(Array.isArray) || [];

      events.forEach(e => {
        const key = e.id || e.slug;
        if (!seen.has(key)) seen.set(key, normaliseIR(e));
      });

    } catch (err) {
      console.warn(`  indiarunning.com [${url}]: ${err.message}`);
    }
  }

  return [...seen.values()];
}

function normaliseIR(e) {
  return {
    id:                   `ir-${e.id || e.slug}`,
    title:                e.title || e.name || 'Unnamed Event',
    city:                 e.locationInfo?.city  || e.city  || '',
    state:                e.locationInfo?.state || e.state || '',
    startDate:            normDate(e.eventDate?.start || e.startDate),
    endDate:              normDate(e.eventDate?.end   || e.endDate),
    distances:            (e.categories || []).map(c => c.category).filter(Boolean),
    registrationDeadline: normDate(e.regDate?.date),
    price:                e.price ? `₹${e.price}` : null,
    rating:               e.avgRating || null,
    organizer:            e.orgName || '',
    url:                  `https://www.indiarunning.com/events/${e.slug}`,
    source:               'indiarunning.com',
    region:               'India',
  };
}

// ─── Scraper: bhaagoindia.com ─────────────────────────────────────────────────
async function fetchBhaagoIndia() {
  const BASE = 'https://bhaagoindia.com';

  try {
    const { data: listHtml } = await axios.get(`${BASE}/events/`, { headers: HEADERS, timeout: 15000 });

    const slugMatches = [...listHtml.matchAll(/\/events\/([a-z0-9-]+-\d+)\//g)];
    const slugs = [...new Set(slugMatches.map(m => m[1]))];

    if (!slugs.length) {
      console.warn('  bhaagoindia.com: no slugs found on listing page');
      return [];
    }

    console.log(`  bhaagoindia.com: found ${slugs.length} event slugs`);

    const events = [];

    for (const slug of slugs) {
      try {
        const { data: html } = await axios.get(`${BASE}/events/${slug}/`, { headers: HEADERS, timeout: 10000 });

        const ldBlocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];

        for (const [, block] of ldBlocks) {
          if (!block.includes('"Event"')) continue;

          const fields = extractEventFields(block);
          if (!fields?.name) continue;

          const startDate = parseIndianDate(fields.startDate);
          if (!startDate) continue;

          events.push(normaliseBhaago({
            slug,
            name:      fields.name,
            startDate,
            endDate:   fields.endDate ? (parseIndianDate(fields.endDate) || startDate) : startDate,
            city:      fields.city,
            url:       fields.url || `${BASE}/events/${slug}/`,
            organizer: fields.organizer,
          }));
          break;
        }
      } catch (err) {
        console.warn(`  bhaagoindia.com [${slug}]: ${err.message}`);
      }
    }

    return events;
  } catch (err) {
    console.warn(`  bhaagoindia.com listing: ${err.message}`);
    return [];
  }
}

function extractEventFields(ldJsonRaw) {
  if (!ldJsonRaw.includes('"Event"')) return null;

  function extractField(key) {
    const rx = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 's');
    const m = ldJsonRaw.match(rx);
    return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim() : null;
  }

  function extractNested(outerKey, innerKey) {
    const outerRx = new RegExp(`"${outerKey}"\\s*:\\s*\\{([^}]{0,500})\\}`, 's');
    const outerMatch = ldJsonRaw.match(outerRx);
    if (!outerMatch) return null;
    const innerRx = new RegExp(`"${innerKey}"\\s*:\\s*"([^"]+)"`);
    const innerMatch = outerMatch[1].match(innerRx);
    return innerMatch ? innerMatch[1] : null;
  }

  return {
    name:      extractField('name'),
    startDate: extractField('startDate'),
    endDate:   extractField('endDate'),
    url:       extractField('url'),
    city:      extractNested('address', 'addressLocality')
             || extractNested('location', 'name')
             || extractField('addressLocality'),
    organizer: extractNested('organizer', 'name'),
  };
}

function parseIndianDate(s) {
  if (!s) return null;
  const clean = s.replace(/,?\s*\d{1,2}:\d{2}\s*(a|p)\.?m\.?/i, '')
                  .replace(/,?\s*\d{1,2}\s*(a|p)\.?m\.?/i, '')
                  .trim();
  const d = new Date(clean + ' UTC');
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

function normaliseBhaago(e) {
  return {
    id:        `bi-${e.slug}`,
    title:     e.name || 'Unnamed Event',
    city:      e.city || '',
    state:     '',
    startDate: e.startDate,
    endDate:   e.endDate || e.startDate,
    distances: [],
    price:     null,
    rating:    null,
    organizer: e.organizer || '',
    url:       e.url,
    source:    'bhaagoindia.com',
    region:    'India',
  };
}

// ─── Scraper: townscript.com ──────────────────────────────────────────────────
async function fetchTownscript() {
  const TOWNSCRIPT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  // page=40 for comprehensive coverage — runs unattended at 3 AM via GitHub Actions
  const url = 'https://www.townscript.com/in/india/running?page=40';
  const MAX_RETRIES = 2;
  const TIMEOUT = 60000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data: html } = await axios.get(url, { headers: TOWNSCRIPT_HEADERS, timeout: TIMEOUT });

      const ldBlocks = [...html.matchAll(
        /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      )];

      const events = [];
      for (const [, block] of ldBlocks) {
        try {
          const parsed = JSON.parse(block);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            if (item['@type'] !== 'Event') continue;
            const norm = normaliseTownscript(item);
            if (norm && norm.startDate) events.push(norm);
          }
        } catch (_) {}
      }

      if (events.length > 0) console.log(`  townscript.com: fetched ${events.length} events (attempt ${attempt})`);
      return events;

    } catch (err) {
      console.warn(`  townscript.com: attempt ${attempt}/${MAX_RETRIES} failed — ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`  townscript.com: retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  console.warn(`  townscript.com: all retries failed`);
  return [];
}

// Returns null for virtual/courier events that aren't real races
function isVirtualEvent(name) {
  const n = name.toLowerCase();
  return n.includes('virtual') || n.includes('by courier') || n.includes('get medal') || n.includes('get trophy') || n.includes('get t-shirt');
}

function normaliseTownscript(e) {
  const name = e.name || '';
  if (isVirtualEvent(name)) return null;
  const startDate = e.startDate ? normDate(new Date(e.startDate).toISOString()) : null;
  const endDate   = e.endDate   ? normDate(new Date(e.endDate).toISOString())   : startDate;
  const distances = inferDistances(name);
  const city = e.location?.address?.addressLocality || e.location?.name || '';
  const price = e.offers?.lowPrice != null
    ? (e.offers.lowPrice > 0 ? `₹${e.offers.lowPrice}` : 'Free')
    : null;
  const eventUrl = (e.url || '').replace('townscript.com//e/', 'townscript.com/e/');
  const slug = eventUrl.match(/\/e\/([^/?#]+)/)?.[1] || name.replace(/[^a-z0-9]/gi, '-').slice(0, 40);

  return {
    id:        `ts-${slug}`,
    title:     name,
    city,
    state:     '',
    startDate,
    endDate,
    distances,
    price,
    rating:    null,
    organizer: e.performer?.name || '',
    url:       eventUrl,
    source:    'townscript.com',
    region:    'India',
  };
}

// ─── Scraper: mysamay.in ──────────────────────────────────────────────────────
async function fetchMySamay() {
  const url = 'https://mysamay.in/events-srv/events/all?type=upcoming';
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const arr = Array.isArray(data) ? data : (data.data || []);

    return arr
      .filter(e => (e.eventType || '').toUpperCase() === 'RUNNING')
      .map(e => {
        const categories = (e.categories || []).filter(c => c.active !== false);
        const distances = categories.map(c => c.name).filter(Boolean);
        const cheapest  = categories.reduce((min, c) => {
          const fee = c.feeAfterDiscount ?? c.regFee ?? Infinity;
          return fee < min ? fee : min;
        }, Infinity);

        return {
          id:        `ms-${e._id || e.name.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
          title:     e.name || 'Unnamed Event',
          city:      e.city || '',
          state:     '',
          startDate: normDate(e.eventStartDate || e.eventDate),
          endDate:   normDate(e.eventEndDate || e.eventStartDate || e.eventDate),
          distances,
          price:     cheapest < Infinity ? `₹${cheapest}` : null,
          rating:    null,
          organizer: e.organiserName || '',
          url:       e.eventWebsite || `https://mysamay.in/public/events`,
          source:    'mysamay.in',
          region:    'India',
        };
      });
  } catch (err) {
    console.warn(`  mysamay.in: ${err.message}`);
    return [];
  }
}

// ─── Scraper: citywoofer.com ──────────────────────────────────────────────────
async function fetchCityWoofer() {
  const AJAX_HEADERS = {
    ...HEADERS,
    'Accept': '*/*',
    'X-Requested-With': 'XMLHttpRequest',
  };
  const MAX_PAGES = 10;
  const events = [];

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await axios.get(
        `https://www.citywoofer.com/get-events-lists?all&page=${page}`,
        { headers: AJAX_HEADERS, timeout: 15000 }
      );
      const gridHtml = data?.data?.grid || '';
      if (!gridHtml || gridHtml.length < 100) break;

      const cards = gridHtml.split('<div class="col-sm-6 col-xl-3 p-2 event-listing">').slice(1);
      if (cards.length === 0) break;

      for (const block of cards) {
        const catMatch = block.match(/<div class="cat-name">\s*([^<]+)/i);
        const cat = (catMatch?.[1] || '').trim().toLowerCase();
        if (!cat.includes('marathon')) continue;

        const titleMatch = block.match(/<a[^>]+href="[^"]*\/e\/[^"]*"[^>]*title="([^"]+)"/i);
        const slug = block.match(/\/e\/([^"]+)"/)?.[1] || '';
        let title = titleMatch?.[1]?.trim() || '';
        if (!title && slug) title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (!title) continue;

        title = title.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');

        const dateMatch = block.match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})/i);
        let startDate = null;
        if (dateMatch) {
          const d = new Date(`${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]} UTC`);
          if (!isNaN(d)) startDate = d.toISOString().split('T')[0];
        }

        const priceMatch = block.match(/(₹[\d,]+(?:\s*-\s*₹[\d,]+)?)/);
        const price = priceMatch ? priceMatch[1].trim() : null;

        const locMatch = block.match(/location-icon[\s\S]*?<\/img>\s*([\s\S]*?)<\/p>/i);
        const location = locMatch ? locMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        const city = location.split(',')[0]?.trim() || '';

        const distances = inferDistances(title);

        if (startDate) {
          events.push({
            id:        `cw-${slug || title.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
            title,
            city,
            state:     '',
            startDate,
            endDate:   startDate,
            distances,
            price,
            rating:    null,
            organizer: '',
            url:       slug ? `https://www.citywoofer.com/e/${slug}` : '',
            source:    'citywoofer.com',
            region:    'India',
          });
        }
      }

      if (cards.length < 12) break;
    }

    return events;
  } catch (err) {
    console.warn(`  citywoofer.com: ${err.message}`);
    return events;
  }
}

// ─── Manual events (BookMyShow, etc.) ─────────────────────────────────────────
function loadManualEvents() {
  try {
    const filePath = path.join(__dirname, '..', 'manual-events.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return (data.events || []).map(e => ({
      id:        `manual-${(e.title || '').replace(/[^a-z0-9]/gi, '-').slice(0, 40).toLowerCase()}`,
      title:     e.title || 'Unnamed Event',
      city:      e.city || '',
      state:     e.state || '',
      startDate: e.startDate || null,
      endDate:   e.endDate || e.startDate || null,
      distances: e.distances || [],
      price:     e.price || null,
      rating:    null,
      organizer: e.organizer || '',
      url:       e.url || '',
      source:    e.source || 'manual',
      region:    'India',
    }));
  } catch (_) {
    return [];
  }
}

// ─── BMS events (from weekly Firecrawl scrape) ──────────────────────────────
function loadBmsEvents() {
  try {
    const filePath = path.join(__dirname, '..', 'data', 'bms-events.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return data.events || [];
  } catch (_) {
    return [];
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function normDate(str) {
  if (!str) return null;
  return String(str).split('T')[0];
}

function inferDistances(name) {
  const n = name.toLowerCase();
  const distances = [];
  if (/\b5\s*k/i.test(n)) distances.push('5K');
  if (/\b10\s*k/i.test(n)) distances.push('10K');
  if (/half\s*marathon|21\s*k/i.test(n)) distances.push('Half Marathon');
  if (/(?<!half\s)(?<!ultra\s)marathon|42\s*k/i.test(n) && !/half/i.test(n) && !/ultra/i.test(n)) distances.push('Marathon');
  if (/ultra/i.test(n)) distances.push('Ultra');
  return distances;
}

// ─── Run ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('❌ Scraper failed:', err.message);
  process.exit(1);
});
