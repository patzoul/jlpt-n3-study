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

That prints an `id`. It is specific to your Cloudflare account, so keep it out of
version control: copy `wrangler.toml` to `wrangler.local.toml` (already
gitignored) and put the real id there in place of
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

```bash
cp wrangler.toml wrangler.local.toml
```

Then deploy against that config:

```bash
npx wrangler deploy -c wrangler.local.toml
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

## Inspecting what is stored

Wrangler v4 defaults its `kv` commands to the *local* simulator, so they come
back empty even when the deployed Worker is happily reading and writing. Pass
`--remote` to talk to the real namespace:

```bash
npx wrangler kv key list --namespace-id <your-id> --remote
```

The values are ciphertext, so there is nothing readable to see — this is only
useful for confirming a record exists or clearing one out.

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
