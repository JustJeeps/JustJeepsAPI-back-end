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
- Completed and Closed requests can be **archived** (PATCH `archived: true|false`): they stay saved but disappear from the default screen filters; the "Archived" view shows them. Archiving any other status returns 409 `ARCHIVE_ONLY_DONE`. Reopening an archived request (moving it back to an active status) unarchives it automatically, so it never stays active and invisible. The rule lives in `lib/requests/archive.js` (pure, unit tested). The board's Done lane has an "Archive all" button.

The board groups the 8 statuses into 4 lanes: **Requests** (New Request, Estimation, Assigned), **Doing** (Work in Progress), **Blocked** (Awaiting Client Response, On Hold) and **Done** (Completed, Closed). Dropping a card on a lane applies the lane's target status; Blocked and Done ask for the required comment first.

Every change writes a `RequestActivity` row (audit trail shown in the drawer).

## Trello integration

One way only: the Pricing Tool creates a card, nothing syncs back.

- Configuration lives **in the database**, set from the gear icon in the navbar (`/settings`, triage users only). There are no `TRELLO_*` environment variables.
- One global credential (API key + token of the workspace account) plus one board and list **per user**. The admin panel has a Test connection button, a board dropdown loaded from Trello and a list dropdown per board.
- When a request moves to Assigned, the card is created on the **assignee's** board, in the mapped list. The card name is `REQ-{id} - {title}` and the description links back to the request.
- If the assignee has no board mapped, no card is created and the activity log shows `Trello card not created`. If Trello fails (revoked token, API down), the log shows `Trello card creation failed`. Card creation never blocks the status change.
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

`npm test` runs `node --test` over `test/` (no database, no network: prisma and axios are injected as stubs). Requests suites: `requestTransitions`, `requestActivity`, `requestsDigest`, `trelloService`, `trelloSettings`, `trelloClient`. CI (`.github/workflows/ci.yml`) runs the same suite plus `prisma validate`.
