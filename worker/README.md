# palisade-updates

Serves updates, the model, and tester feedback for the `palisade-code` app.
The app holds no credentials; this Worker does.

## One-time setup

```bash
npx wrangler login
npx wrangler secret put GITHUB_TOKEN   # fine-grained PAT: Contents read, Issues write
npx wrangler secret put HF_TOKEN       # Hugging Face read token
```

Then fill in `HF_REPO`, `MODEL_SHA256`, and `MODEL_SIZE` in `wrangler.toml`.

## Deploy

```bash
npx wrangler deploy
```

## Check it

```bash
curl https://palisade-updates.<subdomain>.workers.dev/health
```

`/latest.json` needs a published release with both `.app.tar.gz` and
`.app.tar.gz.sig` attached, so it 404s until Phase 4 tags one.

## Tests

```bash
node worker/test.mjs
```

## Notes

- Prereleases count. `/latest.json` reads `/releases`, not `/releases/latest`,
  because every beta build is a prerelease and that endpoint skips them.
- Large files are redirected, not proxied. GitHub and Hugging Face both answer
  an authenticated request with a signed URL, which is passed straight to the
  client so the bytes never transit Cloudflare. Streaming is the fallback.
- Feedback labels are applied server-side. A tester's app does not get to
  choose which bucket its report lands in.
