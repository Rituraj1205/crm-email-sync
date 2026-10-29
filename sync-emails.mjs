import { ImapFlow } from 'imapflow';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const uids = await client.search({ since });
      for await (const msg of client.fetch(uids.slice(-50), { envelope: true, source: true })) {
        const mid = msg.envelope.messageId ?? `${acc.email}-${msg.uid}`;
        const { data: ex } = await sb.from('emails').select('id').eq('message_id', mid).maybeSingle();
        if (ex) continue;
        const from = msg.envelope.from?.[0];
        const src = msg.source?.toString() ?? '';
        const body = src.replace(/^[\s\S]*?\r\n\r\n/, '').substring(0, 3000);
        await sb.from('emails').insert({
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
      }
      results.push({ account: acc.email, synced });
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) {
    results.push({ account: acc.email, error: String(e) });
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
