/**
 * Manual events (BookMyShow, etc.) for Cloudflare Pages Functions.
 *
 * IMPORTANT: When you update manual-events.json in the repo root,
 * also update this file to keep the Cloudflare deployment in sync.
 * Copy the events array from manual-events.json into the export below.
 */

export const manualEvents = [
  {
    title: "Kharghar Half Marathon - Run for Education",
    city: "Navi Mumbai",
    startDate: "2026-04-05",
    distances: ["Half Marathon", "10K", "5K"],
    price: "₹695",
    organizer: "BookMyShow",
    url: "https://in.bookmyshow.com/events/kharghar-half-marathon"
  },
  {
    title: "Farmley Snack Run 2026",
    city: "New Delhi",
    startDate: "2026-04-26",
    distances: ["Half Marathon", "10K", "5K"],
    price: "₹640",
    organizer: "BookMyShow",
    url: "https://in.bookmyshow.com/events/farmley-snack-run-2026"
  },
  {
    title: "Kalimpong Ultramarathon 2026",
    city: "Pedong",
    startDate: "2026-04-24",
    endDate: "2026-04-25",
    distances: ["Ultra"],
    price: "₹1000",
    organizer: "BookMyShow",
    url: "https://in.bookmyshow.com/events/kalimpong-ultramarathon-2026"
  }
];
