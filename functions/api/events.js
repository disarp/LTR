/**
 * Cloudflare Pages Function — GET /api/events
 *
 * Returns live running events from indiarunning.com and bhaagoindia.com.
 * Uses Cloudflare Cache API to avoid re-scraping for 6 hours.
 */

import { fetchAllEvents, applyFilters } from './_scrapers.js';

const CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  try {
    // ─── Check Cloudflare edge cache ──────────────────────────────────────
    const cache = caches.default;
    const cacheKey = new Request(new URL('/api/_events_cache', url.origin).href);

    let allEvents, fetchedAt, cached;

    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      const data = await cachedResponse.json();
      allEvents = data.events;
      fetchedAt = data.fetchedAt;
      cached    = true;
    } else {
      // Cache miss — scrape fresh data
      allEvents = await fetchAllEvents();
      fetchedAt = new Date().toISOString();
      cached    = false;

      // Store full event list in edge cache
      const toCache = new Response(JSON.stringify({ events: allEvents, fetchedAt }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `s-maxage=${CACHE_TTL}`,
        },
      });
      context.waitUntil(cache.put(cacheKey, toCache));
    }

    // ─── Apply query-param filters ────────────────────────────────────────
    const params   = Object.fromEntries(url.searchParams);
    const filtered = applyFilters(allEvents, params);

    return new Response(JSON.stringify({
      events:    filtered,
      total:     allEvents.length,
      fetchedAt,
      cached,
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache', // always revalidate; edge cache handles TTL
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch events. Please try again.',
      detail: err.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
