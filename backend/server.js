/**
 * Let's Talk Running — Backend Server
 *
 * Serves the static website AND provides /api/events with live Indian running
 * event data scraped from indiarunning.com, bhaagoindia.com, and townscript.com.
 *
 * Data is cached in-memory for 6 hours to avoid hammering source sites.
 */

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Shared HTTP headers ──────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── Cache ───────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cache = { events: null, fetchedAt: 0 };

// ─── Middleware ───────────────────────────────────────────────────────────────
// Serve the website static files from the parent directory
app.use(express.static(path.join(__dirname, '..')));
app.use(express.json());

// ─── API: GET /api/events ─────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const now = Date.now();

    if (cache.events && (now - cache.fetchedAt) < CACHE_TTL_MS) {
      return res.json({
        events:    applyFilters(cache.events, req.query),
        total:     cache.events.length,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        cached:    true,
      });
    }

    const events = await fetchAllEvents();
    cache = { events, fetchedAt: now };

    res.json({
      events:    applyFilters(events, req.query),
      total:     events.length,
      fetchedAt: new Date(now).toISOString(),
      cached:    false,
    });

  } catch (err) {
    console.error('API error:', err.message);
    // Return stale cache rather than a blank page
    if (cache.events) {
      return res.json({
        events:    applyFilters(cache.events, req.query),
        total:     cache.events.length,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        cached:    true,
        stale:     true,
      });
    }
    res.status(500).json({ error: 'Failed to fetch events. Please try again.' });
  }
});

// ─── API: POST /api/refresh ───────────────────────────────────────────────────
app.post('/api/refresh', async (_req, res) => {
  try {
    const events = await fetchAllEvents();
    cache = { events, fetchedAt: Date.now() };
    res.json({ success: true, count: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fetch & merge all sources ────────────────────────────────────────────────
async function fetchAllEvents() {
  const [r1, r2, r3] = await Promise.allSettled([
    fetchIndiaRunning(),
    fetchBhaagoIndia(),
    fetchTownscript(),
  ]);

  let events = [];
  if (r1.status === 'fulfilled') { console.log(`✓ indiarunning.com — ${r1.value.length} events`); events.push(...r1.value); }
  else                           { console.warn(`✗ indiarunning.com — ${r1.reason?.message}`); }

  if (r2.status === 'fulfilled') { console.log(`✓ bhaagoindia.com  — ${r2.value.length} events`); events.push(...r2.value); }
  else                           { console.warn(`✗ bhaagoindia.com  — ${r2.reason?.message}`); }

  if (r3.status === 'fulfilled') { console.log(`✓ townscript.com   — ${r3.value.length} events`); events.push(...r3.value); }
  else                           { console.warn(`✗ townscript.com   — ${r3.reason?.message}`); }

  // Manual events (BookMyShow, etc.)
  const manual = loadManualEvents();
  if (manual.length) { console.log(`✓ manual-events    — ${manual.length} events`); events.push(...manual); }

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

  console.log(`→ Total unique upcoming events: ${events.length}\n`);
  return events;
}

// ─── Filter helper ────────────────────────────────────────────────────────────
function applyFilters(events, { region, distance, month } = {}) {
  return events.filter(e => {
    // Region
    if (region && region !== 'all') {
      if (region === 'india'  && e.region !== 'India') return false;
      if (region === 'global' && e.region === 'India') return false;
    }

    // Distance
    if (distance && distance !== 'all') {
      const hasIt = e.distances.some(d => distanceMatches(d, distance));
      if (!hasIt) return false;
    }

    // Month (1-based)
    if (month && month !== 'all') {
      const em = new Date(e.startDate).getMonth() + 1;
      if (em !== parseInt(month)) return false;
    }

    return true;
  });
}

function distanceMatches(distLabel, filter) {
  const d = (distLabel || '').toLowerCase();
  switch (filter) {
    case '5k':       return d.includes('5k') || d === '5' || d.includes('5 k');
    case '10k':      return d.includes('10k') || d === '10' || d.includes('10 k');
    case 'half':     return d.includes('half') || d.includes('21');
    case 'marathon': return (d.includes('marathon') && !d.includes('half') && !d.includes('ultra')) || d.includes('42');
    case 'ultra':    return d.includes('ultra') || /\b(50|60|100)\b/.test(d);
    default:         return d.includes(filter.toLowerCase());
  }
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

      // Events can live at different paths depending on the page
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

    // Extract unique event slugs from listing page href attributes
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

        // Use regex to find ld+json blocks — Cloudflare Rocket Loader scrambles
        // script type attributes so Cheerio CSS selectors are unreliable
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
          break; // Only first matching Event block per detail page
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

// Extract specific fields from raw ld+json text using targeted regex
// (avoids JSON.parse failures caused by emojis and HTML entities in descriptions)
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

// Parse Indian date format: "March 1, 2026, 6 a.m." → "2026-03-01"
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
    distances: [], // bhaagoindia.com doesn't expose distance in ld+json
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
  // Townscript only pre-renders JSON-LD for search engine crawlers
  const TOWNSCRIPT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  // Cumulative pagination — page=15 returns ~150 events in a single JSON-LD array
  const url = 'https://www.townscript.com/in/india/running?page=15';

  try {
    const { data: html } = await axios.get(url, { headers: TOWNSCRIPT_HEADERS, timeout: 20000 });

    // Extract JSON-LD blocks
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
          if (norm.startDate) events.push(norm);
        }
      } catch (_) { /* skip malformed JSON-LD */ }
    }

    return events;
  } catch (err) {
    console.warn(`  townscript.com: ${err.message}`);
    return [];
  }
}

function normaliseTownscript(e) {
  const name = e.name || '';
  const startDate = e.startDate ? normDate(new Date(e.startDate).toISOString()) : null;
  const endDate   = e.endDate   ? normDate(new Date(e.endDate).toISOString())   : startDate;

  // Infer distances from event name
  const distances = inferDistances(name);

  // Extract city
  const city = e.location?.address?.addressLocality
            || e.location?.name
            || '';

  // Extract price
  const price = e.offers?.lowPrice != null
    ? (e.offers.lowPrice > 0 ? `₹${e.offers.lowPrice}` : 'Free')
    : null;

  // Fix double-slash in Townscript URLs
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

// ─── Utility ──────────────────────────────────────────────────────────────────
function normDate(str) {
  if (!str) return null;
  // Keep only YYYY-MM-DD
  return String(str).split('T')[0];
}

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏃 Let's Talk Running server  →  http://localhost:${PORT}`);
  console.log(`📅 Events API               →  http://localhost:${PORT}/api/events\n`);

  // Pre-warm cache on startup
  fetchAllEvents()
    .then(events => { cache = { events, fetchedAt: Date.now() }; })
    .catch(err   => console.error('Pre-warm failed:', err.message));
});
