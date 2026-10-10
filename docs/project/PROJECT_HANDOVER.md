> Historical snapshot. Read [Phase 2 handover](PHASE_2_HANDOVER.md) for current source behavior, tests and next-phase planning.

# Historical Phase 0 handover

Superseded for current planning by [PHASE_1_HANDOVER.md](PHASE_1_HANDOVER.md).
This file records the earlier foundation only.

# Hire Me â€” project handover and next-development brief

Snapshot date: 9 October 2026. This document is self-contained and intended for upload to a ChatGPT Project or handover to another developer.

## 1. Current status

The Phase 0 development foundation is implemented and verified locally. There are three projects, each with an independent frontend and independent backend: six npm modules in total.

The software currently provides starter interfaces, API health checks, environment validation, developer tooling, tests, API documentation and a prepared local database setup. It does **not** yet provide a functioning service marketplace. Authentication, profiles, bookings, worker verification, dispatch, payments and database persistence remain future work.

The local scaffold is working. Production readiness, native device behavior and database container runtime have not been established.

## 2. Product context and source documents

The workspace folder is named **Hire Me**. The interfaces currently use **Trusted Assistance** as the working product name. Final branding remains a founder decision.

The supplied planning material describes a marketplace for trained, verified people offering non-medical practical assistance to customers or consenting adult family members. Its proposed starting area is selected Delhi NCR neighborhoods.

Illustrative starter categories are:

- Hospital visit escort.
- Elderly companionship and check-ins.
- Station pickup/drop assistance.

These categories appear as static examples in the interfaces; they are not a live catalog and cannot be booked.

The current product requirements exclude nursing, medication administration, intimate personal care, unsupervised childcare, medical emergency response, heavy lifting and overnight intercity escort from the initial offering.

Original inputs:

- `Codex_Phase_Prompts.md`: a proposed twelve-phase implementation sequence, Phase 0 through Phase 11.
- `Trusted_Assistance_Startup_Blueprint.pdf`: business/product planning material.

The founder requested project setup, then explicitly changed the architecture. The original documents are context, not proof that later phases or business forecasts have been implemented or validated. Their original monorepo/shared-backend instructions are superseded by the founder's instructions below.

## 3. Accepted architecture requirements

The founder explicitly requires:

1. Three top-level folders: `admin-panel`, `customer-app`, `worker-app`.
2. A `frontend` and a `backend` inside each project.
3. A separate backend application for each interface.
4. Each of the six modules owns its `package.json`, `package-lock.json`, `node_modules`, source code and tooling settings.
5. No root npm/pnpm workspace, root dependency directory or shared source-code package.
6. MongoDB may be shared by the three backends for now.

Do not replace this with a single backend or recreate root shared packages without a new founder instruction. The current decisions are recorded in `docs/adr/0003-independent-modules.md` under each project.

## 4. Folder structure

```text
Hire Me/
â”œâ”€â”€ admin-panel/
â”‚   â”œâ”€â”€ frontend/                Next.js admin portal
â”‚   â”œâ”€â”€ backend/                 NestJS admin API; owns shared local Compose setup
â”‚   â”œâ”€â”€ docs/                    Requirements, architecture, security, acceptance, ADRs
â”‚   â”œâ”€â”€ README.md
â”‚   â””â”€â”€ AGENTS.md
â”œâ”€â”€ customer-app/
â”‚   â”œâ”€â”€ frontend/                React Native / Expo customer starter
â”‚   â”œâ”€â”€ backend/                 NestJS customer API
â”‚   â”œâ”€â”€ docs/
â”‚   â”œâ”€â”€ README.md
â”‚   â””â”€â”€ AGENTS.md
â””â”€â”€ worker-app/
    â”œâ”€â”€ frontend/                React Native / Expo worker starter
    â”œâ”€â”€ backend/                 NestJS worker API
    â”œâ”€â”€ docs/
    â”œâ”€â”€ README.md
    â””â”€â”€ AGENTS.md
```

Each frontend/backend contains its own package manifest, npm lockfile, installed libraries, TypeScript configuration, lint/format configuration, environment example, Git ignore rules, tests, README and module workflow under `.github/workflows/`.

Former shared code was copied into the modules that use it:

| Local location                               | Purpose                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `src/lib/contracts.ts`                       | Zod response schemas, types and frontend sample service descriptions |
| Backend `src/config/environment.ts`          | Environment parsing and validation                                   |
| Backend `src/environment.ts`                 | Module-specific port, origin and service identity                    |
| Mobile `src/theme/tokens.ts`                 | Colors and design values                                             |
| Mobile `src/components/FoundationScreen.tsx` | Starter screen owned by that mobile module                           |
| Backend `docs/openapi.json`                  | Generated specification for that backend                             |

There are no cross-module runtime source imports. Contract changes must be coordinated across the affected modules because the code is duplicated. Importing the Expo base TypeScript configuration uses the module's own installed Expo dependency.

Generated build output and dependencies stay inside the relevant module and are ignored by Git. The old root shared packages, pnpm files, root dependency folder and root tooling files were removed. The temporary root `index.html` is no longer part of the project.

## 5. Technology and connections

These are the versions pinned in the current manifests, not a recommendation to upgrade to them later.

| Area                          | Technology                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Admin frontend                | Next.js 16.4.0, React 19.2.0, TypeScript                                               |
| Customer and worker frontends | Expo 55.0.31, React Native 0.83.10, React 19.2.0, React Native Web 0.21.4              |
| All three backends            | NestJS 11.2.7, Express adapter, TypeScript                                             |
| API documentation             | Nest Swagger 11.4.7 / OpenAPI                                                          |
| Validation                    | Zod 4.6.5                                                                              |
| Quality tools                 | TypeScript 5.9.3, ESLint, Prettier, Node test runner; Supertest for backend HTTP tests |
| Package manager               | Independent npm projects with npm lockfiles                                            |
| Prepared local infrastructure | Docker Compose: MongoDB 8.0 replica set and Redis 7.4                                  |
| Runtime requirement           | Node.js 22.13 or newer; local checks used Node 22.18.0 and npm 10.9.3                  |

| Project  | Frontend port | Backend port | Health response service identity  |
| -------- | ------------- | ------------ | --------------------------------- |
| Admin    | 3000          | 4000         | `trusted-assistance-admin-api`    |
| Customer | 8081          | 4001         | `trusted-assistance-customer-api` |
| Worker   | 8082          | 4002         | `trusted-assistance-worker-api`   |

The admin browser calls the Next.js `/api/health` route. That server route calls the admin backend's `/v1/health`. Customer and worker apps call their corresponding backend directly. Each frontend validates its expected backend identity.

The admin health proxy returns HTTP 503 when its backend is unavailable or returns the wrong service identity. Its server-side origin is configured using `API_BASE_URL`. Mobile origins use `EXPO_PUBLIC_API_URL`.

## 6. What is implemented

### Admin frontend

- Local development portal with Overview, Applications, Build roadmap and System health views.
- Starter branding and service examples.
- App preview links, module directory instructions and startup commands.
- Health status from the actual admin backend through the Next.js proxy.
- Production build support for the frontend.

The portal is currently unauthenticated and contains development information. It has no customer management, worker management, booking operations or privileged business actions.

### Customer and worker frontends

- Separate React Native / Expo projects.
- Different customer/worker starter copy and local design components.
- Static pilot service cards.
- API connection button with loading, success and failure feedback.
- Link to the corresponding backend's Swagger documentation.
- Browser preview and Expo web export support.
- Native platform configuration identifiers and Android/iOS scripts; native binaries/devices have not been verified.

### Each backend

- Independent NestJS application, port and service identity.
- `GET /v1/health` returning status, service, version, phase, integration mode and timestamp.
- Strict environment parsing and common prepared MongoDB settings.
- Mock-only integration mode; startup rejects production mode and live integration mode.
- Helmet security headers and a configured browser CORS origin.
- UUID request correlation headers, structured request logs and correlated HTTP errors.
- Generic response for unexpected server errors.
- Swagger UI at `/docs`, live specification at `/docs-json`, and a generated local OpenAPI file.
- A mock provider registry describing SMS, payment, identity, maps and storage as mocked.

The provider registry is scaffolding. It does not implement OTP delivery, payment flows, verification or real external provider behavior. Health measures process liveness, not database connectivity or marketplace readiness.

## 7. Where data is saved

**No real customer, worker, recipient, booking or payment data is saved yet.**

- Service examples are static frontend source code.
- Health response timestamps are generated per request.
- Frontend connection state is held in component memory.
- Backend request logs go to the console.
- API specifications are generated as files inside each backend.
- There are no implemented MongoDB domain models, repositories, persistence flows or domain migrations.

The latest shared Atlas configuration is shown below with credentials replaced by placeholders. The real URL is stored only in each ignored backend .env:

```dotenv
MONGODB_URL=mongodb+srv://YOUR_USERNAME:YOUR_PASSWORD@inventorycluster.flnec0d.mongodb.net/hire_me?retryWrites=true&w=majority&appName=daily_life
MONGODB_DB_NAME=hire_me
```

MONGODB_URL is normalized to the internal MONGODB_URI field; legacy MONGODB_URI input remains supported. These are settings only: the current application has no database client and does not persist domain data. Atlas connectivity, authentication and permissions have not been verified. Changing the URI database path selects hire_me for future operations; it does not rename, migrate or modify the existing inventory_db.

`admin-panel/backend/compose.yaml` declares MongoDB and Redis services and Docker-managed named volumes `mongo-data` and `redis-data`, under Compose project name `trusted-assistance`. When started, those services use their volumes for container data. Database container startup and replica-set initialization have not been verified in this session.

Before implementing persistence, decide collection ownership, database access permissions, migration ownership and how all three backends coordinate changes. Separate processes sharing a database do not automatically provide authorization boundaries.

## 8. Local startup and testing

Open the workspace in VS Code. Each running module needs its own terminal. Start backends before their frontends. Existing module dependencies are installed.

Start each new terminal from the workspace root:

```powershell
cd "C:\Users\kshit\OneDrive\Desktop\Hire Me"
```

Then run the folder command and startup command from the relevant row:

| Module            | Folder command               | Startup command   | Local URL                  |
| ----------------- | ---------------------------- | ----------------- | -------------------------- |
| Admin backend     | `cd .\admin-panel\backend`   | `npm.cmd run dev` | http://127.0.0.1:4000/docs |
| Admin frontend    | `cd .\admin-panel\frontend`  | `npm.cmd run dev` | http://localhost:3000      |
| Customer backend  | `cd .\customer-app\backend`  | `npm.cmd run dev` | http://127.0.0.1:4001/docs |
| Customer frontend | `cd .\customer-app\frontend` | `npm.cmd run web` | http://localhost:8081      |
| Worker backend    | `cd .\worker-app\backend`    | `npm.cmd run dev` | http://127.0.0.1:4002/docs |
| Worker frontend   | `cd .\worker-app\frontend`   | `npm.cmd run web` | http://localhost:8082      |

For a fresh dependency installation, run `npm.cmd ci --ignore-scripts` inside each module. Do not run installation from the Hire Me root. Each `.npmrc` keeps the npm cache inside that module.

Default configuration works for local browser checks. To change it, copy the relevant module's `.env.example` to `.env`. Keep actual environment files and secrets out of version control.

For mobile device preview, run `npm.cmd run dev` in the mobile frontend. A physical device needs a reachable computer LAN address in `EXPO_PUBLIC_API_URL`, the corresponding backend configured to bind to `HOST=0.0.0.0`, and network access between the device and computer. Android emulator examples use `10.0.2.2` instead of the device's own loopback address. Restart the relevant processes after changing environment settings. Device behavior remains untested.

Manual checks:

1. Open admin System health and click Check again.
2. Open each mobile web preview and click Check API connection.
3. In each backend's `/docs`, execute `GET /v1/health`; expect HTTP 200 and the corresponding service identity.
4. Stop a backend with Ctrl+C; its frontend should show an unavailable connection while the other backend processes continue running.

Stop the relevant development module before running a full build/check. From its own folder:

```powershell
npm.cmd run check
npm.cmd run format:check
```

`check` runs lint, TypeScript, tests and build. `npm.cmd test` runs tests alone. Each backend also supports `npm.cmd run openapi` to regenerate `docs/openapi.json`. Mobile `build` exports web; it does not create signed native apps.

MongoDB/Redis are optional for the implemented health endpoints. Local MongoDB is not needed for Atlas; Compose remains a local alternative. To start the prepared shared services, open Docker Desktop and run from `admin-panel/backend`:

```powershell
npm.cmd run services:up
```

Stop containers with `npm.cmd run services:down`. This command does not remove the declared persistent volumes.

## 9. Verification evidence and limits

The following records checks already executed during setup and the follow-up review on 9 October 2026. It does not imply that checks automatically run whenever this document is read.

| Check                        | Recorded result                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Root structure               | Only the three requested project folders                                                                    |
| Dependency isolation         | All six modules resolve their direct dependencies within their own directories                              |
| Manifest/lockfile alignment  | Passed for all six modules                                                                                  |
| Lint, TypeScript, formatting | Passed for all six modules                                                                                  |
| Automated tests              | 33 passed; no failures or skips                                                                             |
| Build                        | Three Nest builds, one Next production build, two Expo web exports passed                                   |
| Frontend test counts         | Two tests per frontend: six total                                                                           |
| Backend test counts          | Nine tests per backend: 27 total                                                                            |
| Fresh admin TypeScript check | Passed with generated Next files temporarily absent                                                         |
| Backend runtime              | All three APIs running simultaneously; correct identities, CORS headers, UUID headers and Swagger documents |
| Frontend runtime             | Next home/proxy and both Expo development web bundles served successfully                                   |
| Failure handling             | Independent backend shutdown, admin offline response and wrong-backend rejection passed                     |
| OpenAPI freshness            | Regeneration matched the existing specification in each backend                                             |
| Compose configuration        | Validates successfully                                                                                      |
| Expo dependency check        | Passed against offline bundled metadata; online validation not performed                                    |

Tests cover health/error schemas, wrong backend identity, environment defaults and invalid inputs, mock/production restrictions, correlation IDs, selected security headers, unimplemented routes and OpenAPI route scope. They are foundation tests, not end-to-end tests of business features.

Recent corrections included mobile footer newline rendering and Expo's module-local base TypeScript configuration. Checks were repeated after the mobile changes. Temporary QA servers, their worker processes and helper scripts were removed after verification.

Outstanding verification:

- Docker Desktop was stopped: actual MongoDB/Redis startup, replica-set initialization and database behavior remain untested.
- Physical Android/iOS devices, native builds/signing and app lifecycle behavior remain untested.
- Browser visual, accessibility and interaction QA remain untested.
- Remote GitHub Actions have not run.
- No comprehensive dependency vulnerability audit, load test, penetration test, backup restore rehearsal or deployment verification has been completed.

Module workflows are prepared under each module's `.github/workflows`. GitHub runs them when that module is its repository root. Nested workflows do not automatically run when Hire Me or a project parent folder is the repository root. Repository organization must be decided before relying on CI.

## 10. Work not implemented

| Area                 | Remaining work                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Identity             | Phone OTP, login screens, sessions, refresh rotation/revocation, role guards, admin MFA                |
| Customer information | Profiles, recipients, consent, emergency contacts, encrypted notes, care-circle invitations            |
| Catalog/pricing      | Database-backed services, coverage zones, availability, versioned rules, expiring quotes               |
| Bookings             | Creation, state transitions, concurrency, cancellation, event history and idempotency                  |
| Workers              | Onboarding, verification review, training, eligibility and document access controls                    |
| Dispatch             | Availability, offers, expiry, assignment, atomic acceptance and dispatcher overrides                   |
| Payments             | Sandbox gateway, signed webhooks, ledger, reconciliation, refunds, earnings and payouts                |
| Delivery             | Start/end PIN, milestones, authorized family visibility, offline events and incident escalation        |
| Operations           | Booking board, support tickets, incident queue, reports, sensitive-action audits and privacy workflows |
| Release              | Staging, runtime monitoring, backup/restore, accessibility, device/E2E tests and release runbooks      |

No real OTPs, personal identity documents, card details or marketplace records are present. Atlas credentials are now configured in ignored backend .env files only; they are excluded from this document and the examples. Atlas connectivity and domain persistence have not been verified or implemented. No live SMS/payment/identity integration, hosting or production deployment has been configured or verified.

## 11. Proposed next planning step

The next phase in the supplied sequence is **Phase 1: identity and access**. Treat this as a proposed planning direction until the founder selects its scope. Do not begin implementation simply because it appears in this handover.

Before coding it, resolve:

| Decision                   | Why it matters                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Final name and pilot scope | Align screens, identifiers, categories and launch assumptions                             |
| Shared identity model      | Decide how one phone number relates to customer, worker and admin roles                   |
| Collection ownership       | Avoid conflicting writes across three independent backends                                |
| Token policy               | Define which backend issues and accepts which tokens, role checks and revocation behavior |
| Admin account provisioning | Prevent public self-registration into privileged roles                                    |
| Mock SMS testing           | Define a safe development OTP flow without storing or logging plaintext OTPs              |
| Repository organization    | Make module CI usable without recreating the rejected root workspace                      |
| First verification target  | Choose local browser, Android emulator or physical device for the first usable login flow |

A bounded Phase 1 specification should include the relevant screens, API routes, database entities/indexes, authorization rules, migration responsibility, mock provider behavior and acceptance tests. It should retain all six independent modules and the shared MongoDB arrangement. Live SMS, payments and production deployment should remain separate decisions.

Candidate acceptance criteria, not completed functionality:

- A customer can request and verify a mocked phone challenge and receive a customer-scoped session.
- A worker has a separate login flow and worker-scoped authorization.
- Invalid, expired and reused OTP challenges fail; abuse limits apply; OTPs are hashed and not logged.
- Refresh tokens rotate; logout/revocation and token reuse handling are tested.
- Wrong-role requests are denied by the corresponding backend.
- Privileged admin actions remain blocked until the agreed MFA requirement is met.
- Tests exercise real persistence behavior and forbidden access, not only response shapes.
- The relevant OpenAPI documents, setup instructions and module checks are updated.

## 12. Remaining sequence from the supplied prompts

This is a planning sequence, not a statement of implemented features or a delivery estimate.

| Phase | Planned focus                                                                      |
| ----- | ---------------------------------------------------------------------------------- |
| 0     | Foundation â€” current completed scaffold, with the documented verification limits |
| 1     | Identity and access                                                                |
| 2     | Profiles, recipients and consent                                                   |
| 3     | Catalog, coverage, policies, pricing and quotes                                    |
| 4     | Booking state machine and history                                                  |
| 5     | Worker onboarding, verification and training                                       |
| 6     | Availability, dispatch and assignment                                              |
| 7     | Sandbox payments, ledger, reconciliation and payouts                               |
| 8     | Service delivery, family visibility and incident handling                          |
| 9     | Admin operations, support, reporting, audits and privacy requests                  |
| 10    | Security, resilience, accessibility and end-to-end hardening                       |
| 11    | Staging and pilot release preparation                                              |

Business forecasts, staffing, legal/tax/insurance obligations, provider selection and the proposed service model still need founder and professional validation. This codebase does not establish those matters.

## 13. Prompt to use for the next planning conversation

Copy the following after attaching this document and, optionally, the original blueprint and phase prompts:

```text
Use the attached Hire Me project handover as the current-state snapshot. Separate
implemented features, verified checks, untested items and proposed future work.
The original blueprint and phase prompts are planning inputs; my later architecture
instructions override their original monorepo and shared-backend layout.

Preserve three top-level projects: admin-panel, customer-app and worker-app. Each has
independent frontend/backend modules, each with its own package.json, lockfile,
node_modules and local source/configuration. Keep three separate NestJS backends.
They may share MongoDB for now. Do not propose a root workspace, shared code package
or single backend unless I explicitly request an architecture change.

Help me decide the next development phase. Explain the few decisions needed before
Phase 1 identity/access, especially shared user identity, MongoDB collection ownership,
token roles, admin provisioning/MFA, and repository/CI organization. Explain tradeoffs
in plain language. Do not assume those decisions have already been made.

Then draft a bounded implementation brief with screen list, module responsibilities,
API routes, data model/indexes, authorization rules, mocked integrations, acceptance
criteria, meaningful tests and an implementation order. Give me a final coding prompt
adapted to the existing six modules once the decisions are settled. Do not implement
later phases, activate live providers or deploy based only on this planning request.
```

## 14. Supporting files

The existing project docs include `PRD.md`, `ARCHITECTURE.md`, `SECURITY.md`, `ACCEPTANCE.md`, historical ADRs, `PHASE_PROMPTS.md` and `BLUEPRINT_EXTRACT.md`. Each backend also owns its generated `docs/openapi.json`.

For the next conversation, this handover supplies the current technical context. The original blueprint and prompt file provide additional planning context. Source code remains the authority for implementation behavior; this snapshot must be updated when the project changes. Do not upload environment secrets, installed dependencies or generated caches as project knowledge.

## 15. Latest change: Atlas configuration

After this handover was first written, the founder supplied an Atlas URL. All three backends
now have ignored .env files using the hire_me database, replacing inventory_db only in the
connection-string database path. Connection query options are retained. The previous inventory
database was not modified. Examples and this handover contain no actual username/password.

The configuration accepts MONGODB_URL, with precedence over legacy MONGODB_URI when both
are supplied, and retains MONGODB_URI as the normalized internal field. Database name defaults
to hire_me. One additional environment test per backend raises the suite to 36 tests overall:
30 backend tests plus the 6 existing frontend tests. The earlier verification table records the
pre-Atlas review (33 tests). Atlas connectivity and actual database storage are still pending.

Atlas update verification: all three backend check scripts, formatting and OpenAPI generation passed; 30 backend tests passed. Each actual local .env passed configuration validation and selects hire_me. Source, example and documentation checks found no exposed Atlas password. No live Atlas connection check was performed.
