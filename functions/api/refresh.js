/**
 * Cloudflare Pages Function — POST /api/refresh
 *
 * Purges the cached event data and forces a fresh scrape.
 */

import { fetchAllEvents } from './_scrapers.js';

const CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

export async function onRequestPost(context) {
  const url = new URL(context.request.url);

  try {
    const cache    = caches.default;
    const cacheKey = new Request(new URL('/api/_events_cache', url.origin).href);

    // Purge existing cache
    await cache.delete(cacheKey);

    // Fetch fresh data
    const allEvents = await fetchAllEvents();
    const fetchedAt = new Date().toISOString();

    // Re-cache at edge
    const toCache = new Response(JSON.stringify({ events: allEvents, fetchedAt }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `s-maxage=${CACHE_TTL}`,
      },
    });
    context.waitUntil(cache.put(cacheKey, toCache));

    return new Response(JSON.stringify({
      success: true,
      count:   allEvents.length,
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
