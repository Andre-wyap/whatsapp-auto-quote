# WhatsApp Auto Quote

## Objective

When a contact submission is received via webhook, it passes through n8n into an auto-quote node that packages the message. **WhatsApp Auto Quote is responsible for one thing only: delivering that packaged message to the client over WhatsApp.**

It does not generate quotes, store conversation history, or handle inbound replies. It is a send-only delivery layer plus a thin dashboard for connecting and monitoring the WhatsApp session.

---

## Scope

### In scope
- Accept a packaged message from n8n via HTTP
- Send that message to the client through Evolution API
- Send the matching product brochure PDF as a follow-up WhatsApp document
- Dashboard to connect WhatsApp via QR code
- Dashboard to display live session status: **Active / Inactive / Error**

### Out of scope
- Quote generation logic (lives in n8n)
- Generating per-lead PDFs — the brochures are static files shipped in the image
- Inbound message handling / two-way chat
- Session or message history
- Contact management / CRM
- Bulk blast or campaign features

---

## Architecture

```
[ Contact form / lead source ]
              │
              ▼  webhook
         [   n8n   ]
              │
              │  auto-quote node packages message
              ▼
    [ HTTP Request node ]  ──►  WhatsApp Auto Quote service
              │                          │
              │                          ▼
              │              POST /message/sendText/{instance}
              │                          │
              ▼                          ▼
                              [ Evolution API (Hostinger VPS) ]
                                         │
                                         ▼
                                   [ WhatsApp ]
                                         │
                                         ▼
                                   [ Client ]
```

Dashboard sits alongside the send path:

```
[ waa.finnomalaysia.com ] ──► Traefik ──► Auto Quote dashboard
                                                  │
                                                  ├── GET  /instance/connect      (QR)
                                                  └── GET  /instance/connectionState (status)
                                                                │
                                                                ▼
                                                       [ Evolution API ]
```

---

## Flow

1. **Trigger** — n8n receives the contact webhook.
2. **Package** — n8n's auto-quote node builds the final message body (recipient number + message text).
3. **Handoff** — n8n HTTP Request node ("WhatsApp Auto Quote node") calls the Auto Quote service.
4. **Send** — the service forwards the payload to Evolution API on the VPS.
5. **Respond** — the service returns success/failure back to n8n so the workflow can log or retry.
6. **Monitor** — dashboard at `waa.finnomalaysia.com` shows whether the WhatsApp session is alive; if it's dropped, scan the QR to reconnect.

---

## Components

### 1. Auto Quote service (new)

A small HTTP service that sits between n8n and Evolution API.

**Responsibilities**
- Expose a single send endpoint for n8n
- Normalize phone numbers to WhatsApp format (Malaysia: `60XXXXXXXXX`, no `+`, no leading `0`)
- Call Evolution API's send endpoint
- Return a clean success/error response to n8n
- Serve the dashboard UI

**Proposed endpoint**

```
POST /send
Content-Type: application/json
Authorization: Bearer <AUTO_QUOTE_TOKEN>

{
  "number": "60123456789",
  "message": "Hi Ahmad, here's your quote..."
}
```

Response:
```json
{ "ok": true, "messageId": "...", "sentAt": "2026-09-14T10:22:00Z" }
```
or
```json
{ "ok": false, "error": "instance_disconnected" }
```

**Brochure endpoint**

The quote text and the PDF go out as two separate WhatsApp messages, so this is
a separate endpoint rather than optional fields on `/send` (WhatsApp caps
document captions at ~1024 characters and the quote text is already close).

```
POST /send-document
Content-Type: application/json
Authorization: Bearer <AUTO_QUOTE_TOKEN>

{
  "number": "60123456789",
  "document": "copayment"
}
```

`document` is a **logical name**, never a path or filename — so n8n cannot be
coaxed into reading arbitrary files off disk. The two brochures live in
`documents/` and are loaded into memory at startup:

| `document` | Age band | Plan | File sent to the client |
|---|---|---|---|
| `copayment` | 0–40 | 15% co-payment | `Allianz HealthAssured Brochure.pdf` |
| `deductible` | 41–60 and 61–70 | RM5,000 / RM10,000 deductible | `Allianz HealthInsured Brochure.pdf` |

One brochure covers both deductible bands. An unknown name returns
`400 {ok:false, error:'unknown_document', allowed:[...]}`.

### 2. Dashboard (new)

Single page, no auth-heavy setup needed beyond a simple login or token.

**Must show**
- **QR code** — to link/relink the WhatsApp number
- **Session status** — one of:
  - `Active` — connected and able to send
  - `Inactive` — not connected / logged out / QR pending
  - `Error` — Evolution API unreachable or returning a failure
- A **Reconnect / Refresh QR** button
- Last-checked timestamp

**Must NOT show** — message history, chat logs, contact lists.

**Polling** — hit Evolution API's connection-state endpoint every ~10–15s and update the status badge.

### 3. Evolution API (existing)

Already running on the Hostinger VPS:

| Item | Value |
|---|---|
| Container | `evolution-api` |
| Image | `evoapicloud/evolution-api:v2.3.7` |
| Binding | `127.0.0.1:8080` (localhost only) |
| Reverse proxy | `root-traefik-1` |

A **new dedicated instance** is created inside this existing container rather than deploying a second Evolution API. One deployment supports multiple isolated WhatsApp sessions.

Create the instance:
```bash
curl -X POST http://127.0.0.1:8080/instance/create \
  -H "apikey: <EVOLUTION_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceName": "auto-quote",
    "integration": "WHATSAPP-BAILEYS"
  }'
```

### 4. n8n (existing)

| Item | Value |
|---|---|
| Container | `root-n8n-1` |
| Binding | `127.0.0.1:5678` |

Add one HTTP Request node after the auto-quote packaging node, pointing at the Auto Quote service.

---

## Evolution API endpoints used

| Purpose | Method | Endpoint |
|---|---|---|
| Create instance | POST | `/instance/create` |
| Get QR / connect | GET | `/instance/connect/{instance}` |
| Check status | GET | `/instance/connectionState/{instance}` |
| Send text message | POST | `/message/sendText/{instance}` |
| Send PDF document | POST | `/message/sendMedia/{instance}` |
| Logout instance | DELETE | `/instance/logout/{instance}` |

All calls require the `apikey` header.

---

## Status mapping

Evolution API returns a connection state; map it to the three dashboard states:

| Evolution state | Dashboard status |
|---|---|
| `open` | **Active** |
| `connecting` | **Inactive** (QR pending) |
| `close` | **Inactive** |
| no response / 5xx / timeout | **Error** |

---

## Deployment

- Runs as a new Docker container on the same VPS
- Joined to the same Docker network as `evolution-api` so it can reach it internally (no need to expose 8080 publicly)
- Routed by the existing Traefik container
- Domain: **waa.finnomalaysia.com** → Auto Quote dashboard, TLS via Traefik

### Resource note
VPS currently has ~2.2Gi available memory and 40GB free disk. This service is lightweight; no resource concerns.

### DNS setup
`waa.finnomalaysia.com` is a fresh subdomain, separate from anything `root-wa-blast-1` may already serve — no routing conflict expected.

1. Add an **A record**: `wa` → `72.61.117.125`
2. Add the Traefik labels to the Auto Quote container so it picks up the host rule and issues the cert
3. Verify TLS resolves before pointing n8n at the production URL

---

## Environment variables

| Variable | Description |
|---|---|
| `EVOLUTION_API_URL` | Internal URL of Evolution API (e.g. `http://evolution-api:8080`) |
| `EVOLUTION_API_KEY` | Evolution API global key |
| `EVOLUTION_INSTANCE` | Instance name, e.g. `auto-quote` |
| `AUTO_QUOTE_TOKEN` | Shared secret n8n sends in the `Authorization` header |
| `DASHBOARD_PASSWORD` | Simple gate for the dashboard |
| `PORT` | Service port |

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Session not connected | Return `ok: false` with `instance_disconnected`; dashboard shows **Inactive** |
| Number has no WhatsApp account | Return `ok: false` with `number_not_on_whatsapp` — the most common real failure, since the number is whatever a lead typed into a web form |
| Invalid / unreachable number | Return `ok: false` with the Evolution error; n8n logs it |
| Evolution API down | Return `ok: false` with `upstream_unavailable`; dashboard shows **Error** |
| Bad/missing token | `401` |
| Malformed payload | `400` with the missing field named |

n8n owns retry policy — the service itself does not queue or retry.

---

## Build order

1. Create the `auto-quote` instance inside the existing Evolution API container
2. Scan QR manually once (via curl/Postman) to confirm the number connects and can send
3. Build the Auto Quote service with just `POST /send` — verify end-to-end from n8n
4. Add the dashboard: QR display + status badge + reconnect button
5. Point `waa.finnomalaysia.com` at the VPS and wire up the Traefik route + TLS
6. Point n8n's HTTP node at the production URL

---

## Open questions

- Which WhatsApp number will `auto-quote` use — a new one, or the same number already connected to another instance? (A number can only be bound to one instance at a time.)
- ~~Any media in the quote (PDF, image), or text only?~~ **Resolved:** text, then a
  static product brochure PDF as a second message via `/message/sendMedia` — see
  `POST /send-document` above. Two brochures, selected by the age band n8n already
  computes. No per-lead PDF generation.
- Should failed sends notify anywhere (email, Telegram, n8n error workflow), or is the dashboard status enough?