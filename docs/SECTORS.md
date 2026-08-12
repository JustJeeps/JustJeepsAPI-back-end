# Sectors (boards per sector)

Each company sector has its own board of requests, managed by that sector's admins — the Trello/ClickUp model applied to the internal ticket system, instead of one shared list for the whole company. A request belongs to exactly one sector; the sector decides which Trello board the card goes to.

Design source: research on how Trello and ClickUp handle per-department boards (plan `use-o-resarche-para-stateful-rossum.md`). Key choices:

- **Two admin levels.** Triage users (`REQUESTS_TRIAGE_USERS`) are the "workspace admins": they see and manage every sector, no opt-in (Trello policy, not ClickUp's). Sector admins manage only their sector: members, name/color, Trello board mapping, plus close/archive/delete for requests inside it.
- **Visibility follows membership** (changed 2026-08-12; the first cut was "everyone sees everything"). A request is visible to: members of its sector, the person who opened it (you always track your own tickets, even in another sector), anyone assigned to it, and triage. Enforced **server-side** in `listRequests`/`getRequestDetail` and in every mutation (invisible request answers 404, never 409, so ids don't leak). The pure rule lives in `lib/sectors/visibility.js`; the Prisma WHERE mirrors it. Sector **names** stay visible to everyone — anyone can open a request to any sector, that's the point of a ticket system.
- **Sector creation is triage-only** (anti-sprawl). Triage creates the sector and appoints the first admin; from there the sector runs itself.
- **Orphan guard.** No change can leave a sector without admins (409 `LAST_ADMIN`). Triage can bypass — the sector becomes triage-managed — and the bypass is recorded in the sector's audit log.
- **Moving a request between sectors** needs an admin of the **source** sector (or triage). The Trello card moves along to the destination sector's board.

## Code map

| Layer | File |
|---|---|
| Routes | `routes/sectors.js` (mounted at `/api/sectors`) |
| Service | `services/sectors/sectorsService.js` |
| Pure rules | `lib/sectors/permissions.js` (roles), `lib/sectors/membership.js` (LAST_ADMIN guard) |
| Constants | `config/sectors.js` |
| Trello mapping | `lib/trello/settings.js` (`*SectorBoard` trio), `lib/trello/resolveDestination.js` |
| DB models | `Sector`, `SectorMember`, `TrelloSectorBoard`, `SectorActivity` + `Request.sector_id` |
| Migration | `prisma/migrations/20260811120000_add_sectors/` (seeds General, backfills every request, seeds triage as General admins) |

## API

Same conventions as Requests: logged-in user required, rollout gate `REQUESTS_ALLOWED_USERS`, business denials are **409 with a `code`**, never 403.

| Method | Path | Who | Denial code |
|---|---|---|---|
| GET | `/api/sectors` | triage (all sectors) or sector admin (only the sectors they admin) | `SECTOR_ADMIN_ONLY` |
| POST | `/api/sectors` | triage | `TRIAGE_ONLY` |
| PATCH | `/api/sectors/:id` | triage or sector admin | `NOT_SECTOR_ADMIN`, `DEFAULT_SECTOR`, `SECTOR_NOT_EMPTY` |
| PUT | `/api/sectors/:id/members/:userId` | triage or sector admin | `NOT_SECTOR_ADMIN`, `LAST_ADMIN` |
| DELETE | `/api/sectors/:id/members/:userId` | triage or sector admin | `NOT_SECTOR_ADMIN`, `LAST_ADMIN` |
| PUT | `/api/sectors/:id/trello-board` | triage or sector admin | `NOT_SECTOR_ADMIN` |
| GET | `/api/sectors/:id/activity` | triage or sector admin | `NOT_SECTOR_ADMIN` |
| GET | `/api/sectors/trello/boards` | triage or admin of any sector | `SECTOR_ADMIN_ONLY` |
| GET | `/api/sectors/trello/boards/:boardId/lists` | triage or admin of any sector | `SECTOR_ADMIN_ONLY` |

The Trello read routes live here (not under `/api/trello-settings`) because that router is triage-gated as a whole: sector admins need the board/list dropdowns, but credentials stay triage-only.

## Rules worth knowing

- `SectorMember.role` is a validated string (`admin` | `member`), no Prisma enum — repo convention.
- **Members see the board, not the configuration** (2026-08-12). Sector configuration — member list, roles, Trello board mapping, rename/archive, audit log — is visible only to that sector's admins and triage. `meta.sectors` carries only the public catalog (id, name, slug, color, archivedAt); the full config comes from `/api/sectors`, which returns each caller only the sectors they admin (triage: all).
- The **General** sector (`slug: general`) is seeded by the migration, receives every request created without a `sectorId` (older frontend during deploys), and can never be archived (`DEFAULT_SECTOR`).
- Archiving a sector requires it to have no active requests (`SECTOR_NOT_EMPTY`) — move or archive them first. Sectors are never hard-deleted.
- `requestsService.actorContext` computes `effectiveTriage` (global triage OR admin of the request's sector) and feeds it to the existing state machine — `lib/requests/transitions.js` and `lib/requests/archive.js` did not change.
- Every governance change (create, rename, archive, member add/remove, role change, Trello board change) writes a `SectorActivity` row.
- After deploying: map the current Trello board/list on the **General** sector in `/settings`, otherwise card creation silently skips until the mapping exists (there is no per-assignee fallback anymore).

## Tests

`npm test` — suites `sectorPermissions`, `sectorMembership`, `sectorVisibility`, plus the sector cases inside `trelloService`, `trelloSettings`, `trelloClient` and `requestActivity`.
