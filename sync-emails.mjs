import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert error ${res.status}: ${text}`);
  }
}

async function sbExists(messageId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/emails?message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

const accounts = JSON.parse(process.env.EMAIL_ACCOUNTS ?? '[]');
const results = [];

for (const acc of accounts) {
  try {
    const client = new ImapFlow({
      host: 'imap.one.com',
      port: 993,
      secure: true,
      auth: { user: acc.email, pass: acc.pass },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let synced = 0;
    let errors = 0;
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const uids = await client.search({ since });
      for await (const msg of client.fetch(uids.slice(-50), { envelope: true, source: true })) {
        const mid = msg.envelope.messageId ?? `${acc.email}-${msg.uid}`;
        if (await sbExists(mid)) continue;
        const from = msg.envelope.from?.[0];
        const parsed = await simpleParser(msg.source);
        const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '').substring(0, 3000);
        try {
          await sbInsert('emails', {
            account: acc.email,
            from_address: from?.address ?? '',
            from_name: from?.name ?? from?.address ?? '',
            subject: msg.envelope.subject ?? '(no subject)',
            body,
            received_at: msg.envelope.date?.toISOString(),
            message_id: mid,
            thread_id: msg.envelope.inReplyTo ?? mid,
          });
          synced++;
        } catch (insertErr) {
          console.error(`Insert failed for ${acc.email}:`, insertErr.message);
          errors++;
        }
      }
      results.push({ account: acc.email, synced, errors });
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) {
    results.push({ account: acc.email, error: String(e) });
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
