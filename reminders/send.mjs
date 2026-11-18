/* Runs hourly on GitHub. At 9 AM, 2 PM and 8 PM (family time) it sends a notification if that check is not logged yet. */
import webpush from 'web-push';

const PUBLIC_KEY = 'BMEp__H2u_F9FlT_c7n1XmysY2W_l2hwz4jXtY_Vs3CYtiepELoocmHGr9JUEb7wwgTG5ZTmj5EXbeqNLzQF2ak';
const TZ = process.env.TZ_NAME || 'America/Chicago';
const TEST = process.env.TEST === 'true';
const SLOTS = {
  9: ['morning', 'The morning check isn’t logged yet. Take her BP and weight before the morning medicine.'],
  14: ['afternoon', 'The afternoon check isn’t logged yet. Take her BP and weight. No medicine with this one.'],
  20: ['night', 'The night check isn’t logged yet. Take her BP and weight before the night medicine.']
};

const [code, privateKey] = (process.env.REMINDER_SECRET || '').trim().split(':');
if (!code || !privateKey) { console.log('REMINDER_SECRET is missing or incomplete. Nothing sent.'); process.exit(1); }
/* This repository is public, so its run logs are too. Keep both halves of the secret out of them. */
console.log('::add-mask::' + code);
console.log('::add-mask::' + privateKey);

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function local(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) };
}

const now = local(new Date());
const slot = SLOTS[now.hour];
if (!TEST && !slot) { console.log('Hour ' + now.hour + ' in ' + TZ + ': no reminder is scheduled now.'); process.exit(0); }

const base = 'https://firestore.googleapis.com/v1/projects/moms-vitals/databases/(default)/documents/logs/' + code;
async function api(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error('Firestore answered ' + res.status);
  return res.json();
}

try {
  if (!TEST) {
    const rows = await api(base + ':runQuery', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'readings' }], orderBy: [{ field: { fieldPath: 'ts' }, direction: 'DESCENDING' }], limit: 30 } })
    });
    const done = rows.some((r) => {
      const f = r.document && r.document.fields; if (!f || !f.ts || !f.slot) return false;
      const ts = Number(f.ts.integerValue ?? f.ts.doubleValue);
      return f.slot.stringValue === slot[0] && local(new Date(ts)).day === now.day;
    });
    if (done) { console.log('The ' + slot[0] + ' check is already logged. Nothing sent.'); process.exit(0); }
  }

  const list = await api(base + '/push?pageSize=100');
  const docs = list.documents || [];
  if (!docs.length) { console.log('No phone has reminders turned on. Nothing sent.'); process.exit(0); }

  webpush.setVapidDetails('https://alisampf-cell.github.io/moms-vitals/', PUBLIC_KEY, privateKey);
  const payload = JSON.stringify({
    title: 'Mom’s Vitals Log',
    body: TEST ? 'Test reminder. Notifications are working on this phone.' : slot[1]
  });
  let sent = 0, removed = 0, failed = 0;
  for (const doc of docs) {
    let sub = null;
    try { sub = JSON.parse(doc.fields.sub.stringValue); } catch (e) {}
    if (!sub) continue;
    try { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }); sent++; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        /* That phone turned notifications off or was reset, so forget it. */
        await fetch('https://firestore.googleapis.com/v1/' + doc.name, { method: 'DELETE' }).catch(() => {});
        removed++;
      } else { failed++; console.log('A phone refused the notification, status ' + (e && e.statusCode)); }
    }
  }
  console.log('Sent to ' + sent + ' phone(s), removed ' + removed + ' old one(s), ' + failed + ' failed.');
  if (failed && !sent) process.exit(1);
} catch (e) {
  console.log('Reminder run failed: ' + (e && e.message ? e.message.replace(code, '***') : 'unknown error'));
  process.exit(1);
}
