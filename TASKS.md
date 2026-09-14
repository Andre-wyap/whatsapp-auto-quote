# WhatsApp Auto Quote — Task List

Derived from [CLAUDE.md](CLAUDE.md). Ordered to follow the spec's build order: prove the
WhatsApp session works first, then the send path, then the dashboard, then production routing.

**Status:** Phases 0–4 and 7 done. `https://waa.finnomalaysia.com` is live with a valid cert, and a real
message has been sent end-to-end through the production URL. Next: wire up n8n (Phase 5).

---

## Phase 0 — Decisions & prerequisites ✅

- [x] **Open question 1 — WhatsApp number:** a **brand-new number**, dedicated to `auto-quote`. No
      existing session gets disconnected.
- [x] **Open question 2 — media:** **text-only.** `/send` stays `{number, message}` → `/message/sendText`,
      as originally proposed. No `/message/sendMedia` support needed.
      ⚠️ **Superseded by Phase 7** — brochure PDFs were added later via a separate
      `POST /send-document`. `/send` itself is unchanged, so this decision still holds for it.
- [x] **Open question 3 — failure notifications:** **dashboard status is enough.** No email/Telegram/n8n
      error-workflow hook; `/send` just returns `ok:false` and n8n owns what happens next.
- [x] Stack: **Node 20 + Fastify** (no objection raised; proceeding with this).
- [x] SSH access confirmed: `finno-vps` (`72.61.117.125`, root, key-based) already configured in
      `~/.ssh/config` and works.
- [x] Docker network confirmed: `evolution-api`, `root-traefik-1`, and `root-n8n-1` are all on
      **`root_default`** — the new container joins this same network.
- [x] VPS resources confirmed: 2.2Gi available memory, 40GB free disk — matches the spec.
- [x] Traefik label pattern captured from the live `n8n` router (entrypoints `web,websecure`, TLS,
      `certresolver: mytlschallenge`) — template ready for Phase 4.
- [x] `EVOLUTION_API_KEY` retrieval — initially refused by the permission classifier as a
      production-secrets read; resolved in Phase 1 once you granted the Bash permission.

### ⚠️ Discovered during Phase 0 — domain conflict, then resolved by switching subdomains

CLAUDE.md originally stated `wa.finnomalaysia.com` was "a fresh subdomain... no routing conflict
expected." **That was wrong as of this check (2026-09-14):** `wa.finnomalaysia.com` already resolved to
this VPS and Traefik already routed it *directly* to the raw `evolution-api` container — confirmed live,
returning Evolution's own welcome JSON and advertising its `/manager` admin UI publicly, with a valid
cert already issued (`certresolver: mytlschallenge`).

**Resolved:** the project now uses **`waa.finnomalaysia.com`** instead (note the double-a) — confirmed
this does **not** currently resolve, so it's an actually-fresh subdomain. `CLAUDE.md` has been updated
throughout to match. This sidesteps the conflict entirely: no need to touch the existing
`wa.finnomalaysia.com` → `evolution-api` router, and Evolution's accidental public exposure there is
**unchanged** — still live, just no longer this project's problem to fix. Worth flagging to whoever owns
that router, but out of scope here.

---

## Phase 1 — Evolution API instance ✅ (one VPS cleanup item still open)

- [x] `EVOLUTION_API_KEY` retrieved from the container env (permission granted):
      `<redacted \u2014 global Evolution API key, rotate before reuse>`.
- [x] Checked `/instance/fetchInstances` first — only one existing instance
      (`finno_784be459-...`, `root-wa-blast-1`'s, number `601154047463`, status `open`). No name
      collision with the new `auto-quote` instance.
- [x] Created the `auto-quote` instance: `POST /instance/create` →
      `instanceId: 2f07cb2c-52f7-400a-a600-ce923fe8c69f`, status `close` (expected, not connected yet).
- [x] Instance issues its own per-instance token (Evolution v2 `hash`):
      `<redacted \u2014 auto-quote instance token, rotate before reuse>`. **Decision needed later (Phase 2):** use this scoped
      token for the service's Evolution calls instead of the global key — narrower blast radius if
      the service's env ever leaks. Recommend the instance token; revisit when scaffolding.
- [x] `GET /instance/connect/auto-quote` → got a QR (base64 PNG + pairing string), sent as a file.
- [x] **Number decision revised:** reusing **`601154047463`** instead of a brand-new number (overrides
      the Phase 0 decision). Investigated who else uses it first:
      - `root-wa-blast-1` — unrelated, runs its own independent Baileys session, no Evolution API
        involvement at all. Not a conflict.
      - The actual owner is the **FINNO CRM**'s own WhatsApp lead-messaging feature — Evolution
        instance `finno_784be459-c480-4b80-8476-0caf1957c688` (`instanceNameFor(profileId)` in
        `crm/app/api/wa/instance/route.ts`), live with 6,291 messages / 970 chats of real history.
- [x] CRM's WhatsApp session disconnected via its own UI (confirmed gone from `fetchInstances`).
- [x] **Second conflict found and resolved:** `root-wa-blast-1` was *also* actively holding
      `601154047463` as its own independent session (unrelated software, same number — its logs
      showed `"username":"601154047463"` mid reconnect-loop). Stopping the container alone didn't
      release the number — WhatsApp still listed it under Linked Devices until logged out there
      directly, same as the CRM's ghost session.
- [x] Per your instruction ("not a real service, delete it"): container, image, and its stale
      `root_wa_blast_auth` auth volume all removed from the VPS.
- [ ] **Not fully done:** its `wa-blast:` service block is still in `/root/docker-compose.yml`
      (backed up to `docker-compose.yml.bak-20260914` first). Editing that file directly was blocked
      by the auto-mode permission classifier as a production-config write. Left as-is means a future
      `docker compose up` on that stack would recreate the container from
      `/root/wablast/backend`. Also left untouched: that source directory and its `.env` — didn't
      delete source code without being asked to. Needs either a permission grant to finish the edit,
      or you removing the block yourself (lines defining the `wa-blast:` service and the
      `wa_blast_auth:` volume entry).
- [x] Scanned successfully. `GET /instance/connectionState/auto-quote` → `state: "open"`.
      `ownerJid: 601154047463@s.whatsapp.net`, profile "Andrew Yap Allianz" — confirmed via
      `fetchInstances`.
- [x] Test message sent (self-send to `601154047463`, no reply from you specifying otherwise) —
      superseded by Phase 2's real end-to-end send below, which exercised the same thing through the
      actual service code rather than raw curl.

---

## Phase 2 — Auto Quote service (`POST /send`) ✅

- [x] Scaffolded: `package.json` (Node 20, Fastify 5, ESM), `.env.example`, `.gitignore`, `git init`.
      Layout: `src/config.js`, `src/phone.js`, `src/evolution.js`, `src/app.js` (Fastify factory,
      dependency-injectable for tests), `src/server.js` (entrypoint).
- [x] `src/config.js` — fails fast at boot listing every missing required env var by name.
- [x] Bearer-token check on `/send`: missing/wrong token → `401 {ok:false, error:'unauthorized'}`.
- [x] Payload validation: missing `number`/`message` → `400 {ok:false, error:'missing_field', field}`.
- [x] **Phone normalizer** (`src/phone.js`): handles `+`/spaces/dashes/parentheses, leading-0 → `60`
      conversion, already-`60` passthrough, and explicitly **rejects landlines** (03/04/05...) since
      they can't have WhatsApp — a wrong "success" would be worse than a clear 400. 14 table-driven
      tests, all passing.
- [x] Evolution client (`src/evolution.js`) — modeled on the **FINNO CRM's own working Evolution
      client** (`crm/lib/wa/evolution.ts`) rather than guessed from docs, since it's a proven
      integration against this exact Evolution version: `{number, text}` body for sendText, `apikey`
      header, 15s timeout via `AbortSignal.timeout`.
- [x] Pre-send connection check: if `connectionState` isn't `open`, short-circuits to
      `{ok:false, error:'instance_disconnected'}` before attempting the send.
- [x] Error mapping implemented: disconnected → `instance_disconnected`; Evolution unreachable/5xx/
      timeout → `upstream_unavailable`; Evolution-rejected send → its own message passed through.
      **HTTP status convention documented in `src/app.js`:** only `401`/`400` per CLAUDE.md's explicit
      table; every other business outcome is `200` with `ok:false`, so n8n only branches on the body's
      `ok` field rather than juggling status codes too. Flagged here since CLAUDE.md doesn't pin this
      down explicitly — revisit if you'd rather have e.g. `502` for `upstream_unavailable`.
- [x] Success response: `{ok:true, messageId, sentAt}` — `messageId` from `result.key.id`, `sentAt`
      as `new Date().toISOString()`.
- [x] `GET /health` → `{ok:true}`.
- [x] Structured logging via Fastify's pino logger — number and outcome only, **message content is
      never logged**, matching the "no message history" constraint.
- [x] Tests: `test/phone.test.js` (14 cases) + `test/send.test.js` (11 cases, fake Evolution client
      injected via `buildApp(config, {evolutionClient})` — no real network calls). **25/25 passing**
      (`npm test`).
- [x] **Real end-to-end send, verified against production:** opened an SSH tunnel
      (`ssh -L 18080:127.0.0.1:8080 finno-vps`), ran the service locally against it using the
      **instance-scoped token** (redacted, see Phase 1 note above; confirming that Phase 1 recommendation actually
      works for auth, not just the global key), and sent a real message to `601154047463` through
      `POST /send` (not raw curl to Evolution — the actual service code path). Response:
      `{"ok":true,"messageId":"3EB010BCA27940D6E969EB","sentAt":"2026-09-14T05:20:20.019Z"}`.
      **Please confirm the WhatsApp message actually arrived** — the API accepting it isn't quite
      the same as delivery.
- [x] Tunnel and local test server torn down afterward; throwaway `.env` (pointed at the tunnel's
      temporary port) removed. `.env.example` is the real template for actual deployment config.

---

## Phase 3 — Dashboard ✅

- [x] Password gate (`src/routes/dashboard.js`): `POST /api/login` → signed, httpOnly, SameSite=Lax
      session cookie (`aq_session`), 24h max-age, plus `POST /api/logout`. Password compared in
      constant time (`timingSafeEqual` over SHA-256 digests). The cookie is signed with
      `DASHBOARD_PASSWORD` itself rather than a new env var — keeps CLAUDE.md's documented env list
      intact, and it's a "simple login" gate per the spec, not multi-user auth.
- [x] **The two auth surfaces are deliberately separate** — a dashboard session grants no access to
      `POST /send`, and the n8n bearer token grants no access to the dashboard APIs. Both directions
      are covered by tests.
- [x] `GET /api/status` — maps `open` → Active, `connecting`/`close` → Inactive, unreachable/unknown
      → Error. Returns `{status, evolutionState, checkedAt}`.
- [x] `GET /api/qr` — returns `{ok, qrBase64, pairingCode}`; reports `upstream_unavailable` rather
      than throwing when Evolution is down.
- [x] `POST /api/reconnect` — logout (best-effort, failure doesn't block) then connect for a fresh QR.
- [x] Single-page UI (`src/public/dashboard.html`, served at `GET /`): login view + dashboard view,
      status badge (green/amber/red), QR panel shown only when not Active, reconnect button,
      last-checked timestamp. Self-contained — no external fonts/CDN, so it works even if the VPS
      has no outbound internet.
- [x] Polls `/api/status` every 12s; refreshes the QR every 25s while not Active (Evolution rotates
      QRs in well under a minute); both intervals stop on `visibilitychange` when the tab is hidden
      and resume on return.
- [x] No message history, chat logs, or contact lists anywhere in the UI — asserted by a test that
      greps the served page, so a future edit can't quietly reintroduce them.
- [x] **All three states verified by hand against the real VPS** (via SSH tunnel):
      - **Active** — live `auto-quote` instance → `{"status":"Active","evolutionState":"open"}`
      - **Inactive** — verified on a *throwaway* `aq-statetest` instance rather than logging out the
        live session: `close` → Inactive, and after requesting a QR, `connecting` → Inactive too.
        `/api/qr` returned a real 13KB scannable QR; `/api/reconnect` returned a fresh one. Throwaway
        instance deleted afterward; live session confirmed still `open` and untouched.
      - **Error** — second server pointed at a dead port (rather than stopping the real
        `evolution-api` container, which would have broken the CRM) →
        `{"status":"Error","evolutionState":null}` and `/api/qr` → `upstream_unavailable`.
- [x] Tests: `test/dashboard.test.js` (19 cases). **Suite now 44/44 passing.**
- [x] **Fixed a test-tooling bug found along the way:** `npm test` ran bare `node --test`, which
      recursively discovers `*.test.js` *inside `node_modules`* — once `@fastify/cookie` was added,
      it started running hundreds of third-party suites and appeared to hang indefinitely. Script is
      now scoped: `node --test test/*.test.js`. (I initially misdiagnosed this as iCloud Desktop sync
      interfering with `node_modules`; that was wrong and the `.nosync` workaround has been reverted.)

---

## Phase 4 — Containerize & deploy ✅

- [x] `Dockerfile`: **`node:22-alpine`** (bumped from the planned 20 — see note below), non-root
      (`USER node`), `NODE_ENV=production`, `npm ci --omit=dev`. `.dockerignore` excludes
      `node_modules`, `.git`, `.env`, `test/`, docs.
- [x] **Bumped Node 20 → 22, in the Dockerfile and `package.json`'s `engines` field.** Building on
      `node:20-alpine` produced an `EBADENGINE` warning: `@fastify/cookie`'s `cookie` dependency
      requires Node ≥22. All earlier local test runs happened to pass anyway since this Mac runs
      Node 25 (which satisfies `>=22`), so the incompatibility was invisible until the first real
      Docker build on the target Node version — worth knowing since it means "tests passed locally"
      didn't actually prove Node 20 compatibility.
- [x] `docker-compose.yml`: `build: .`, no `ports:` (Traefik reaches it over the shared network only),
      `networks: [root_default]` (declared `external: true`), `env_file: .env`,
      `restart: unless-stopped`, healthcheck runs `node -e "fetch(...)"` against `/health` (no curl/wget
      dependency needed in the image beyond what's already there).
- [x] Traefik labels on the service: `Host(\`waa.finnomalaysia.com\`)`, `entrypoints=web,websecure`,
      `tls.certresolver=mytlschallenge` — matches the live `n8n` router's labels from Phase 0.
- [x] **Deployed to the VPS** at `/root/auto-quote` via `rsync` (no git remote/commits yet to deploy
      from). Production `.env` created directly on the VPS (never touched your local machine):
      - `EVOLUTION_API_KEY` = the `auto-quote` instance's own scoped token (per the Phase 1/2 decision)
      - `AUTO_QUOTE_TOKEN` = freshly generated 32-byte hex secret
      - `DASHBOARD_PASSWORD` = freshly generated 20-char random password
      **Both secrets are in this file below — save them somewhere durable, they're only on the VPS
      otherwise:**
      - `AUTO_QUOTE_TOKEN=<redacted \u2014 rotate before reuse>`
      - `DASHBOARD_PASSWORD=<redacted \u2014 rotate before reuse>`
- [x] `docker compose build && up -d` — container is `Up ... (healthy)`, on `root_default`.
- [x] Verified reaches Evolution internally: `docker exec auto-quote node -e "fetch('http://evolution-api:8080')..."` → Evolution's welcome JSON.
- [x] Verified the actual app inside the container: logged in via `/api/login`, got back a correctly
      signed httpOnly cookie (matches the dashboard test suite's expectations against real infra, not
      just fakes).
- [x] **Side finding, not a problem:** a *different*, older, unrelated `node` process
      (`/root/wablast-repo/backend/index.js`, PM2-managed, running since Sep 11 — three days before
      any of my work) also happens to listen on host port 3000. No actual conflict — our container
      publishes no host port at all, so this was purely a testing gotcha (I initially curled
      `localhost:3000` on the VPS host itself and got this other app's 404 instead of ours). Worth
      knowing it's there, but out of scope to touch.
- [x] **DNS added by you** — `waa.finnomalaysia.com` → `72.61.117.125` confirmed resolving.
- [x] **TLS issued.** First attempt at container startup failed (`NXDOMAIN` — DNS hadn't propagated
      yet at that moment); a `docker compose restart` after your DNS change nudged Traefik into
      retrying. Verified with `openssl s_client`: `CN=waa.finnomalaysia.com`, issued by Let's Encrypt
      (`YR2`), valid through Dec 13 2026. Strict `curl` (no `-k`) now succeeds — `200`.
- [x] Confirmed Evolution API is still bound to `127.0.0.1:8080` only — port 8080 from the public
      internet times out, and `docker port auto-quote` shows no published ports at all.
      (`wa.finnomalaysia.com`, the *other* subdomain, still publicly exposes Evolution directly —
      pre-existing issue outside this project's scope, see Phase 0.)
- [x] **Full production smoke test, real public domain, real WhatsApp send:**
      `POST https://waa.finnomalaysia.com/send` with the real bearer token →
      `{"ok":true,"messageId":"3EB02409C0F88B520080BA","sentAt":"2026-09-14T06:04:33.143Z"}`.
      Also verified `/api/login` + `/api/status` over the real domain → `{"status":"Active",...}`.
      **The entire path is live: n8n → `waa.finnomalaysia.com` → Traefik → container → Evolution API
      → WhatsApp.**

---

## Phase 5 — Wire up n8n

- [ ] Add the HTTP Request node after the auto-quote packaging node in `root-n8n-1`:
      `POST https://waa.finnomalaysia.com/send`, `Authorization: Bearer <AUTO_QUOTE_TOKEN>` stored as
      an n8n credential (not inline in the node).
- [ ] Map the packaged fields to `{number, message}`.
- [ ] Set the node's retry policy in n8n (the service deliberately does not retry).
- [ ] On `ok:false`, just branch to n8n's normal error/log handling — no separate alert channel
      (decided in Phase 0: dashboard status is enough).
- [ ] End-to-end test: submit a real contact form → confirm the quote lands on WhatsApp.

---

## Phase 6 — Handover

- [x] `README.md`: env var table (names/purpose only, no values), rsync-based deploy/redeploy
      steps, first-time Evolution instance setup, local dev commands.
- [ ] **Not done — needs you:** move `AUTO_QUOTE_TOKEN`, `EVOLUTION_API_KEY`, and
      `DASHBOARD_PASSWORD` into wherever your secrets actually live (password manager / vault). I
      don't have access to one, so this has to be a manual step.
      **Flagging a real exposure risk found along the way:** all three values are sitting in
      plaintext in this repo's own `TASKS.md` (Phase 4 notes). Nothing's been committed yet (repo
      has zero commits, everything is currently untracked), so it hasn't leaked into git history —
      but the file itself is still a plaintext copy sitting outside any vault. Once you've stored
      the values properly, treat these copies as needing rotation, or tell me to redact them from
      `TASKS.md` and I will.
- [x] Short runbook written into `README.md` ("Runbook: dashboard shows Inactive or Error") —
      Inactive → Reconnect → scan QR; Error → check Evolution container/network first, Reconnect
      won't fix that case.

---

## Phase 7 — Brochure PDFs (added after Phase 6, scope change)

Overrides the Phase 0 "text-only" decision: clients now get the quote text, then the matching
product brochure as a second WhatsApp message.

- [x] **Two static brochures, selected by the age band `Build Quote` already computes** — no
      per-lead PDF generation:
      - `copayment` → `Allianz HealthAssured Brochure.pdf` (band 0–40, 15% co-payment)
      - `deductible` → `Allianz HealthInsured Brochure.pdf` (bands 41–60 *and* 61–70 — one
        brochure covers both the RM5,000 and RM10,000 deductible)
- [x] `POST /send-document` with `{number, document}`, on the same Bearer token as `/send`.
      **Deliberately a separate endpoint, not optional fields on `/send`:** the text and the PDF
      are two separate WhatsApp messages anyway, since WhatsApp caps document captions at ~1024
      chars and `quoteText` is already close to that.
- [x] **`document` is a logical name, never a path or filename** — so the n8n-facing surface can't
      be coaxed into reading arbitrary files off disk. Unknown name → `400 unknown_document` with
      the allowed list. Covered by a test that feeds it `../.env`, `/etc/passwd` etc.
- [x] `src/documents.js` loads both PDFs to base64 **at startup**, so a deploy that forgot to ship
      them fails immediately rather than on the first real client send.
- [x] Base64 rather than a URL for Evolution: no public `waa.finnomalaysia.com/pdf/...` path to
      scrape, and Evolution never has to fetch anything over the network.
- [x] **Media sends get a 90s timeout** (text keeps 15s) — the brochures are 1–4MB and Evolution
      re-uploads them to WhatsApp. In practice the 3.4MB one completed in **under 3 seconds**, and
      Evolution's request body limit turned out to be a non-issue.
- [x] Tests: `test/document.test.js` (10 cases, including a real-file test asserting both PDFs are
      present and actually start with `%PDF`). **Suite now 54/54 passing.**
- [x] Deployed and verified against production — both brochures sent to `601154047463` through
      `https://waa.finnomalaysia.com/send-document`, and `../.env` correctly rejected.
- [x] PDFs committed to the public GitHub repo (your call, asked first) so a clean clone builds.
- [x] `CLAUDE.md` updated: scope, the `/send-document` contract + band→brochure table, the
      `/message/sendMedia` row, and open question 2 marked resolved.
- [ ] **Still needs you:** add the second HTTP Request node in n8n (snippet provided in chat) —
      `POST /send-document`, same `Auto Quote Token` credential, after `Send WhatsApp Quote`.

---

## Phase 8 — Bug found by the first real lead

- [x] **`[object Object]` bug fixed (`src/evolution.js`).** The first real lead through the n8n
      workflow failed, and the Stop and Error node reported
      `WhatsApp delivery failed for (): [object Object]` — useless. Root cause was mine: Evolution
      reports an unreachable number as an *array of objects*
      (`[{exists:false, jid, number}]`), and both `String(obj)` and `[obj].join('; ')` collapse
      that to `"[object Object]"`, destroying the only diagnostic detail in the response.
- [x] Objects inside Evolution error payloads are now `JSON.stringify`'d rather than coerced.
- [x] **New error code `number_not_on_whatsapp`**, returned when Evolution says `exists: false`.
      Given the number comes from a web form, this is the failure n8n will hit most often, so it
      gets a stable machine-readable code rather than an opaque passthrough string.
- [x] Error mapping extracted into one shared `sendFailure()` so `/send` and `/send-document`
      can't drift apart.
- [x] **Root cause of the actual failure was the lead's number, not the code:** `601236533468`
      returns `exists:false` from Evolution's `/chat/whatsappNumbers` — it's one digit too long
      for an `012` mobile, so almost certainly a typo in the form submission. `/send` now says so
      plainly instead of `[object Object]`.
- [x] Verified in production against that exact number → `{"ok":false,"error":"number_not_on_whatsapp"}`,
      and a real number still sends fine. Tests 56/56.
- [ ] **Consider (not done):** the phone normalizer accepts `/^601\d{8,9}$/`, so it can't catch a
      wrong-length number for a given prefix (`011`/`015` are 11 local digits, `012`/`013`/etc are
      10). Tightening it would reject typos at the `400` stage instead of after a failed send —
      left alone deliberately, since a wrong prefix table would reject *real* customers, which is
      the worse failure.
