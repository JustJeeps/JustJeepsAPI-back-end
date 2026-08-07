# Requests (internal tickets)

Internal ticket system of the Pricing Tool. The team opens requests (website issues, data problems, improvements), triage assigns them, and everyone follows progress in one place instead of email threads.

Frontend lives in `JustJeepsAPI-front-end/src/features/requests/` (route `/requests`). Backend code map:

| Layer | File |
|---|---|
| Routes (HTTP only) | `routes/requests.js`, `routes/users.js`, `routes/trelloSettings.js` |
| Service (use cases, data access) | `services/requests/requestsService.js`, `services/trello/trelloSettingsService.js` |
| Domain rules (pure, tested) | `lib/requests/transitions.js`, `lib/requests/activity.js`, `lib/trello/*` |
| Constants and limits | `config/requests.js` |
| Storage (attachments) | `services/storage/requestAttachmentsStorage.js` |
| Trello client | `services/trello/trelloService.js`, `lib/trello/trelloClient.js` |
| Email | `utils/emailService.js` (`sendRequestAssignedEmail`, `sendRequestsDigestEmail`) |
| Digest data | `lib/reports/requestsDigest.js` (cron `report-requests-digest`) |
| DB models | `prisma/schema.prisma`: `Request`, `RequestComment`, `RequestAttachment`, `RequestActivity`, `TrelloSettings`, `TrelloUserBoard` |

## API

All routes require a logged in user (`ENABLE_AUTH=true`). While the team tests the feature, a rollout gate (`REQUESTS_ALLOWED_USERS`, default `ricardo,admin,tess`) hides it from everyone else: the menu item disappears, `/meta` answers with `requestsEnabled: false` and every other route returns 409 `REQUESTS_RESTRICTED`. To release, widen the env in `config/deploy.yml`. Business rule violations return **409 with a `code`**, never 403. Reason: the frontend interceptor logs the user out on auth 403, so 403 is reserved for real auth failures.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/requests/meta` | Statuses, priorities, projects, types, triage users, attachment limits, `trello.configured` |
| GET | `/api/requests` | Full list (filters and KPIs are client side) |
| POST | `/api/requests` | Create (always starts as New Request, unassigned) |
| GET | `/api/requests/:id` | Detail with comments, attachments, activity |
| PATCH | `/api/requests/:id` | Update fields, status, assignee. Accepts `comment` in the same call |
| POST | `/api/requests/:id/trello-card` | Create the Trello card manually (fallback button) |
| POST | `/api/requests/:id/comments` | Add comment (`internal` flag supported) |
| POST | `/api/requests/:id/attachments` | Upload files (multipart `files`) |
| GET | `/api/requests/:id/attachments/:attachmentId/download` | Authenticated download (stream from the private bucket) |
| DELETE | `/api/requests/:id/attachments/:attachmentId` | Delete (uploader or triage only) |
| GET | `/api/users` | Slim user list for assignee selects |

## Workflow rules

State machine in `lib/requests/transitions.js`:

- Statuses: New Request, Estimation, Assigned, Work in Progress, Awaiting Client Response, On Hold, Completed, Closed.
- Anyone can assign or unassign a request (product decision, Aug 2026). Only triage can close. Triage users come from `REQUESTS_TRIAGE_USERS` (default `ricardo,admin,tess`), exposed to the frontend as `meta.triageUsers`.
- A request can have **multiple assignees** (PATCH `assigneeIds: number[]`; the legacy single `assigneeId` is still accepted). The first id in the list is the **primary** assignee (`Request.assignee_id`): it drives the Trello board, the auto move to Assigned and the Unassigned KPI. The full list lives in `RequestAssignee` and comes back as `assignees` on every request. Every newly added person gets the assignment email.
- Assigning a New Request auto moves it to Assigned.
- Moving to Assigned requires an assignee.
- Awaiting Client Response, On Hold and Completed require a comment in the same PATCH.
- Closed can only go back to Assigned (reopen).

- Links must start with `http://` or `https://` (validated in `parseLinks`); attachment uploads check both the extension and the declared content type.
- Anyone who opened a request, plus triage, can **archive** it in any status (it disappears from the default screen filters and shows up under the Archived view) and **delete** it. Delete is a soft delete: the request disappears for everyone but nothing is erased — comments, attachments in the bucket and the Trello card stay. Only triage sees the deleted list (`GET /api/requests?deleted=true`) and can restore (`POST /api/requests/:id/restore`). Archiving is an explicit choice: changing the status of an archived request no longer brings it back.


### The four lanes, in both views

The 8 statuses are shown as 4 lanes: **Requests** (New Request, Estimation, Assigned), **Doing** (Work in Progress), **Blocked** (Awaiting Client Response, On Hold) and **Done** (Completed, Closed). `BOARD_LANES` in `src/features/requests/requestsConstants.js` is the single definition, and **the list groups by the same lanes, with the same names, in the same order**. The list used to group by the 8 raw statuses, so the same data had a different shape depending on the view and the reader had to translate "Estimation" into "Requests" in their head. Inside a lane the exact status is still readable: the coloured dot next to the title carries it as a tooltip, and the card shows it as a tag.

Dropping a card on a lane applies the lane's target status; Blocked and Done ask for the required comment first. An empty lane stays visible in both views, so the flow reads the same whether or not anything is in it.

### Saved views and the trash

The saved views (My requests, Unassigned, All open, Archived, Deleted) are a filter, **not** a change of view mode: opening the trash from the board keeps the board. In the trash the board is read only, because a deleted request is restored rather than moved to another lane, so cards do not drag and the "Move to" select is hidden.

The filters in the bar above stay applied when the trash opens, and they were chosen for a different set of requests, so the usual result is an empty trash that looks broken. When filters are hiding everything, the screen says how many deleted requests exist and that clearing the filters will show them.

Every change writes a `RequestActivity` row (audit trail shown in the drawer).

## Trello integration

One way only: the Pricing Tool creates a card, nothing syncs back.

- Configuration lives **in the database**, set from the gear icon in the navbar (`/settings`, triage users only). There are no `TRELLO_*` environment variables.
- One global credential (API key + token of the workspace account) plus one board and list **per user**. The admin panel has a Test connection button, a board dropdown loaded from Trello and a list dropdown per board.
- When a request moves to Assigned, the card is created on the **assignee's** board, in the mapped list. The card name is `REQ-{id} - {title}` and the description links back to the request.
- **The sync only runs once the setup is complete.** With no credentials, or with an assignee that has no board mapped yet, the request simply does not sync: no card, no entry in the request history (the reason goes to the server log only). A real failure with everything configured (revoked token, Trello down) does show up as `Trello card creation failed` in the history, deduplicated so a repeated failure does not flood it. The manual "Create card now" button always explains the reason, since it is an explicit action. Card creation never blocks the status change.
- Reassigning after the card exists does not move the card.
- API endpoints for the panel are under `/api/trello-settings` (triage only, validated on the backend).

How the admin gets credentials: create a Power-Up at `trello.com/power-ups/admin` with the workspace account to get the API key. The panel then shows an authorize link that generates the token for that key. The token is stored in the database and never returned in full by the API (only masked).

## Attachments (DigitalOcean Spaces)

Private bucket, streamed downloads through the API. Configured by env:

```
DO_SPACES_ENDPOINT, DO_SPACES_REGION, DO_SPACES_BUCKET, DO_SPACES_KEY, DO_SPACES_SECRET
```

Without them the feature degrades: uploads answer 409 `ATTACHMENTS_DISABLED` and the UI hides the upload area. Limits: 10 MB per file, 5 files per upload (see `config/requests.js`).

## Email

- Assignment email: sent to the assignee when a request is assigned. Kill switch `REQUESTS_ASSIGNMENT_EMAIL_ENABLED=false`.
- Daily digest: cron `report-requests-digest`, opt in via `CRON_REQUESTS_DIGEST_ENABLED=true` plus `REQUESTS_DIGEST_EMAILS`. Watermark stored in `SyncState` under `requests-digest-last-run`.

## Tests

`npm test` runs `node --test` over `test/` (no database, no network: prisma and axios are injected as stubs). Requests suites: `requestTransitions`, `requestActivity`, `requestArchive` (archive + permissions), `requestsDigest`, `trelloService`, `trelloSettings`, `trelloClient`. The frontend has its own gates: `npm run lint` (no-undef as an error) and `npm test` (Vitest over the pure predicates). CI (`.github/workflows/ci.yml`) runs the same suite plus `prisma validate`.
