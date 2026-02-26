/**
 * Shared scraper logic for Cloudflare Pages Functions.
 * Uses native fetch() — zero npm dependencies required.
 *
 * Sources: indiarunning.com (__NEXT_DATA__ SSR JSON)
 *          bhaagoindia.com  (regex JSON-LD extraction)
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── Fetch & merge all sources ──────────────────────────────────────────────────

export async function fetchAllEvents() {
  const [r1, r2] = await Promise.allSettled([
    fetchIndiaRunning(),
    fetchBhaagoIndia(),
  ]);

  let events = [];
  if (r1.status === 'fulfilled') events.push(...r1.value);
  if (r2.status === 'fulfilled') events.push(...r2.value);

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

  return events;
}

// ─── Filter helper ──────────────────────────────────────────────────────────────

export function applyFilters(events, { region, distance, month } = {}) {
  return events.filter(e => {
    if (region && region !== 'all') {
      if (region === 'india'  && e.region !== 'India') return false;
      if (region === 'global' && e.region === 'India') return false;
    }
    if (distance && distance !== 'all') {
      const hasIt = e.distances.some(d => distanceMatches(d, distance));
      if (!hasIt) return false;
    }
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

// ─── Scraper: indiarunning.com ──────────────────────────────────────────────────

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

  // Fetch all pages in parallel for speed
  const results = await Promise.allSettled(
    URLS.map(url => fetch(url, { headers: HEADERS }).then(r => r.text()))
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const html = result.value;

    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) continue;

    try {
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
    } catch (_) { /* malformed JSON — skip */ }
  }

  return [...seen.values()];
}

function normaliseIR(e) {
  return {
    id:        `ir-${e.id || e.slug}`,
    title:     e.title || e.name || 'Unnamed Event',
    city:      e.locationInfo?.city  || e.city  || '',
    state:     e.locationInfo?.state || e.state || '',
    startDate: normDate(e.eventDate?.start || e.startDate),
    endDate:   normDate(e.eventDate?.end   || e.endDate),
    distances: (e.categories || []).map(c => c.category).filter(Boolean),
    price:     e.price ? `₹${e.price}` : null,
    rating:    e.avgRating || null,
    organizer: e.orgName || '',
    url:       `https://www.indiarunning.com/events/${e.slug}`,
    source:    'indiarunning.com',
    region:    'India',
  };
}

// ─── Scraper: bhaagoindia.com ───────────────────────────────────────────────────

async function fetchBhaagoIndia() {
  const BASE = 'https://bhaagoindia.com';
  const listRes = await fetch(`${BASE}/events/`, { headers: HEADERS });
  const listHtml = await listRes.text();

  // Extract unique event slugs from listing page
  const slugMatches = [...listHtml.matchAll(/\/events\/([a-z0-9-]+-\d+)\//g)];
  const slugs = [...new Set(slugMatches.map(m => m[1]))];
  if (!slugs.length) return [];

  // Fetch all detail pages in parallel
  const results = await Promise.allSettled(
    slugs.map(slug =>
      fetch(`${BASE}/events/${slug}/`, { headers: HEADERS })
        .then(r => r.text())
        .then(html => ({ slug, html }))
    )
  );

  const events = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { slug, html } = result.value;

    // Regex to find ld+json — Cloudflare Rocket Loader scrambles script types
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
      break; // Only first Event block per page
    }
  }

  return events;
}

// Extract fields via targeted regex (avoids JSON.parse failures from emojis/HTML entities)
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

// Parse Indian date format: "March 1, 2026, 6 a.m." -> "2026-03-01"
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

function normDate(str) {
  if (!str) return null;
  return String(str).split('T')[0];
}
