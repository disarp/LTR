/**
 * Google Apps Script — Coaching Sign-Up Webhook
 *
 * SETUP INSTRUCTIONS:
 * ─────────────────────────────────────────────────────────────
 * 1. Go to https://sheets.google.com and create a new spreadsheet
 *    (or use an existing one) — name it "LTR Coaching Sign-Ups"
 *
 * 2. Create three sheets (tabs) named exactly:
 *      • beginner
 *      • intermediate
 *      • personalized
 *
 * 3. In EACH sheet, add these headers in row 1:
 *      A: Timestamp | B: Name | C: Email | D: Phone | E: Gender
 *      F: Age | G: Location | H: Plan Distance | I: Fitness Level
 *      J: Goal Distance | K: Timeline | L: Experience
 *      M: Fitness Tracker | N: Tracker Profile | O: Notes
 *
 * 4. Open Apps Script: Extensions → Apps Script
 *
 * 5. Paste this entire script into the editor (replace any existing code)
 *
 * 6. Click "Deploy" → "New deployment"
 *    - Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - Click "Deploy"
 *
 * 7. Copy the Web App URL (looks like:
 *    https://script.google.com/macros/s/AKfy.../exec)
 *
 * 8. Set this URL as the GOOGLE_SCRIPT_URL environment variable
 *    in Cloudflare Pages dashboard:
 *    Settings → Environment Variables → Add:
 *      GOOGLE_SCRIPT_URL = <your web app URL>
 *
 * 9. For local development, create a .env file in /backend/:
 *      GOOGLE_SHEETS_WEBHOOK_URL=<your web app URL>
 *
 * That's it! Every coaching sign-up will now auto-populate your Google Sheet.
 * ─────────────────────────────────────────────────────────────
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Pick the right sheet tab based on plan_tier
    var tier = (data.plan_tier || 'beginner').toLowerCase();
    var sheet = ss.getSheetByName(tier);

    if (!sheet) {
      // Auto-create the sheet if it doesn't exist
      sheet = ss.insertSheet(tier);
      sheet.appendRow([
        'Timestamp', 'Name', 'Email', 'Phone', 'Gender',
        'Age', 'Location', 'Plan Distance', 'Fitness Level',
        'Goal Distance', 'Timeline', 'Experience',
        'Fitness Tracker', 'Tracker Profile', 'Notes'
      ]);
      // Bold the header row
      sheet.getRange(1, 1, 1, 15).setFontWeight('bold');
    }

    // Append the data row
    sheet.appendRow([
      data.submitted_at || new Date().toISOString(),
      data.name || '',
      data.email || '',
      data.phone || '',
      data.gender || '',
      data.age || '',
      data.location || '',
      data.plan_distance || '',
      data.fitness_level || '',
      data.goal_distance || '',
      data.timeline || '',
      data.experience || '',
      data.fitness_tracker || '',
      data.tracker_profile || '',
      data.notes || ''
    ]);

    // Send email notification to coach
    var subject = 'New ' + tier.toUpperCase() + ' coaching signup: ' + (data.name || 'Unknown');
    var body = 'New sign-up details:\n\n';
    for (var key in data) {
      body += key + ': ' + data[key] + '\n';
    }
    body += '\nView all sign-ups: ' + ss.getUrl();

    MailApp.sendEmail({
      to: 'letustalkrunning@gmail.com',
      subject: subject,
      body: body
    });

    return ContentService.createTextOutput(
      JSON.stringify({ success: true })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: err.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Handle GET requests (for testing the endpoint)
function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', message: 'LTR Coaching webhook is active' })
  ).setMimeType(ContentService.MimeType.JSON);
}
