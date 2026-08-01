# Sync server

A Cloudflare Worker that stores one encrypted blob per user. It exists only so
your phone and your laptop can share one SRS schedule.

It never sees anything readable: `js/sync.js` derives an encryption key and a
storage id from your passphrase with PBKDF2, encrypts the payload with AES-GCM,
and sends only the ciphertext and the id. The passphrase never leaves your
browser. Losing it means losing the synced copy — there is no reset.

## Deploying

You need a free Cloudflare account. From this directory:

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create STATE
```

That prints an `id`. Put it in `wrangler.toml` in place of
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`, then:

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL, something like
`https://jlpt-n3-sync.<your-subdomain>.workers.dev`. Check it responds:

```bash
curl https://jlpt-n3-sync.<your-subdomain>.workers.dev/health
```

Then open the app, go to **Settings → Sync across devices**, paste that URL,
choose a passphrase, and press Connect. Do the same on your other device with
the identical passphrase.

## Free tier

100,000 reads and 1,000 writes per day, 1 GB of storage. The app writes once at
the end of a study session, so a heavy day is a handful of writes.

## API

| | |
| --- | --- |
| `GET /state/:id` | returns the stored ciphertext, or 404 if there is none |
| `PUT /state/:id` | stores the ciphertext (max 20 MB) |
| `GET /health` | liveness check |

`:id` must be 32 hex characters. Records expire after a year without a sync.

## Optionally lock it to your own site

Set `ALLOWED_ORIGINS` in `wrangler.toml` to your Pages origin, e.g.
`https://patzoul.github.io`, and redeploy. Requests from other origins are then
refused. This is defence in depth rather than the main protection — the real
protection is that the data is encrypted and the id is derived from a
passphrase.
