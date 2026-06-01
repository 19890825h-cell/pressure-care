# Background push worker

This Cloudflare Worker stores browser Push subscriptions in KV and checks the forecast every 15 minutes.

## Deploy

1. Run `npm install`.
2. Run `npm run vapid` and keep the private key secret.
3. Update `VAPID_SUBJECT` in `wrangler.jsonc`.
4. Run `npx wrangler secret put VAPID_PUBLIC_KEY`.
5. Run `npx wrangler secret put VAPID_PRIVATE_KEY`.
6. Run `npm run deploy`.
7. Copy the Worker URL and VAPID public key into `../push-config.js`.
8. Commit and push the updated `push-config.js`.

The deployed Worker URL is configured in `../push-config.js`. Keep the VAPID private key only in Cloudflare Secrets.

The GitHub Pages site remains static. The Worker is responsible for background checks and Push delivery.
