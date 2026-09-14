# WhatsApp Auto Quote

Send-only delivery layer: n8n → this service → Evolution API → WhatsApp. See
[CLAUDE.md](CLAUDE.md) for the full spec and [TASKS.md](TASKS.md) for build history.

## Environment variables

Set in `/root/auto-quote/.env` on the VPS (never committed — see `.gitignore`).
`.env.example` documents the same list with no values filled in.

| Variable | Description |
|---|---|
| `EVOLUTION_API_URL` | Internal URL of Evolution API, e.g. `http://evolution-api:8080` (reachable because this container shares `root_default` with `evolution-api`). |
| `EVOLUTION_API_KEY` | Auth for Evolution API calls. Use the **`auto-quote` instance's own scoped token** (the `hash` returned by `POST /instance/create`), not the global Evolution key. |
| `EVOLUTION_INSTANCE` | Evolution instance name this service sends through: `auto-quote`. |
| `AUTO_QUOTE_TOKEN` | Shared secret n8n must send as `Authorization: Bearer <token>` on `POST /send`. |
| `DASHBOARD_PASSWORD` | Password gate for the dashboard; also used to sign the session cookie. |
| `PORT` | Port the server listens on inside the container (default `3000`; not published to the host — Traefik reaches it over `root_default`). |

**Where the real values live:** on the VPS only, in `/root/auto-quote/.env`. If you
need to look them up or rotate one, SSH to `finno-vps` and read/edit that file
directly — don't let them round-trip through a local file, a chat log, or a repo
doc (they briefly ended up recorded in [TASKS.md](TASKS.md)'s Phase 4 notes; treat
those as needing rotation, since a value that's been written down in plaintext
outside the vault should be considered exposed).

## Deploy / redeploy

There's no git remote wired up yet — deploys are pushed by `rsync`, not pulled
via `git pull`.

From your local machine, in this directory:

```bash
rsync -av --exclude node_modules --exclude .env --exclude .git \
  ./ finno-vps:/root/auto-quote/
```

Then on the VPS:

```bash
ssh finno-vps
cd /root/auto-quote
docker compose build
docker compose up -d
docker compose ps          # expect auto-quote ... Up ... (healthy)
```

The container has no published port — `docker compose logs -f auto-quote` is
the way to watch it, not curling a host port directly. Traefik picks up the
`waa.finnomalaysia.com` route from the labels in `docker-compose.yml`
automatically; no separate Traefik config needed.

**First-time-only setup** (already done in Phase 1, documented here in case the
instance is ever recreated):

```bash
curl -X POST http://127.0.0.1:8080/instance/create \
  -H "apikey: <EVOLUTION_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"instanceName": "auto-quote", "integration": "WHATSAPP-BAILEYS"}'
```

## Runbook: dashboard shows "Inactive" or "Error"

1. Open `https://waa.finnomalaysia.com`, log in with `DASHBOARD_PASSWORD`.
2. Check the status badge:
   - **Inactive** — session logged out or QR not yet scanned. Click
     **Reconnect**, scan the QR shown with the `601154047463` WhatsApp app
     (Linked Devices → Link a Device), wait for the badge to turn **Active**.
   - **Error** — Evolution API itself is unreachable (container down, network
     issue), not just the WhatsApp session. Reconnect won't help here; SSH in
     and check `docker ps` / `docker logs evolution-api` on the VPS first.
3. Once **Active**, send a test message via `POST /send` (or just wait for the
   next real n8n trigger) to confirm delivery actually works end to end, not
   just that the badge is green.

If the QR keeps expiring before you can scan it, hit **Reconnect** again right
before scanning — Evolution rotates QR codes in well under a minute.

## Local development

```bash
npm install
npm test          # 44 tests, no network calls — fakes the Evolution client
npm run dev        # requires a local .env; point EVOLUTION_API_URL at a
                   # tunnel (e.g. ssh -L 18080:127.0.0.1:8080 finno-vps) if
                   # you need to exercise a real send locally
```
