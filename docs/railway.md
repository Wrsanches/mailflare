# Railway with Resend

Deploy the Dockerfile and attach a Railway volume at `/data`. The SQLite
database, messages, attachments and local backups live on that volume.
Use one replica and keep application sleeping disabled.

Set these service variables before deploying:

```dotenv
NODE_ENV=production
MAILFLARE_RUNTIME=node
DATA_DIR=/data
HOST=0.0.0.0
PORT=3000
SMTP_INBOUND_PORT=0
RAILWAY_RUN_UID=0
NEXT_TELEMETRY_DISABLED=1
APP_URL=https://your-generated-host.up.railway.app
```

Railway mounts volumes as root. `RAILWAY_RUN_UID=0` lets the container write
to `/data`. Railway manages the volume; the Dockerfile must not contain a
`VOLUME` instruction. The included `railway.toml` sets the readiness check.

## First account

1. Open `/setup` and create the first administrator and mailbox on your domain.
2. Leave **Enable sending** off during registration. Configure Resend after
   signing in; no SMTP or Cloudflare credentials are required for registration.
3. Open **Admin → Domains** and select Resend for receiving and sending.
4. Save your Resend full-access API key in the provider card. Alternatively,
   set `RESEND_API_KEY` directly in Railway Variables and redeploy. Never
   commit the key or paste it into a public chat.
5. Run the sending and receiving setup actions. With no Cloudflare token,
   create the DNS records returned by Resend at your DNS provider and wait
   for Resend to verify them. Receiving needs its own MX record in addition
   to the sending records. Review existing MX records before replacing them.
6. Receiving setup creates the signed `email.received` webhook pointing to
   `${APP_URL}/api/inbound/resend`; the app stores its signing secret.
7. Test both outbound delivery and receiving from an external mailbox.

Resend uses HTTPS, so SMTP access and a public port 25 are unnecessary.
Do not use the generic SMTP DNS records as Resend records; use those returned
by Resend. Adding `CF_TOKEN` is optional and enables automated DNS management.

## Updates and backups

Review updates in your own fork before deployment. Preserve this fork's
Railway and self-hosted onboarding adjustments when importing upstream updates.
Download application backups or configure Railway volume backups separately;
the application's local backups reside on the same volume as its messages.
