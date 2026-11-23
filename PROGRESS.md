# Progress

## Phase 1 — Foundation ✅ (2026-10-09)
- npm-workspaces monorepo: `apps/web` (Next 16 + Tailwind 4 + shadcn config), `apps/api` (NestJS 12 + Prisma 7), `packages/shared` (RBAC + booking workflow).
- Full DB schema: 61 models and 46 enums across 10 domain files. Initial migration adds CHECK constraints and an append-only AuditLog trigger.
- Idempotent seed: 6 roles, 98 permissions, Super Admin from env, settings, notification templates, automation rules, taxonomies.
- API foundation: zod env validation, Prisma service (pg adapter), helmet/CORS, `/api/v1/health`, field encryption util.
- Verified on Postgres 17 (embedded): migrate deploy, zero drift, seed run twice, unit tests 6/6, e2e tests 4/4, API boots, web builds.
- Docs: `docs/ARCHITECTURE.md` (modules, data model, statuses, assumptions).

## Phase 1b — Proposal reconciliation ✅ (2026-10-10)
- Read the 9-page PDF (`Downloads/Umrah_Travel_Commercial_Product_Proposal.pdf`). Schema, shared RBAC/workflow, seed and migration aligned (see `docs/ARCHITECTURE.md`). Tests: unit 6/6, e2e 5/5, zero migration drift.

## Phase 2 — Design system & layouts ✅ (2026-10-10)
- Tokens: emerald/gold/ivory palette (light + dark), Inter + Fraunces + Amiri (self-hosted, OFL), Islamic star-lattice pattern, RTL-safe logical CSS, reduced-motion support.
- shadcn/ui (new-york, 27 components) + brand variants (`gold` button, `xl` size).
- Shared components: Logo, ornaments, Section/SectionHeading, PublicShell (header w/ grouped menus + mobile sheet, footer), PortalShell (customer + admin; permission-filtered sidebar, drawer on mobile), PageHeader, EmptyState/ErrorState/SuccessState, skeletons, StatusBadge (all status enums), StatCard, DataTable, PackageCard, PriceTag, Rating, StepIndicator (8-step booking wizard), PriceSummary, FormField/PasswordInput, Reveal.
- Route groups: `(public)`, `(customer)/account`, `(admin)/admin`, dev-only `/design-system` (404 in production), global not-found/error/loading, favicon.
- Verified: Jest 9/9 (format, nav-vs-RBAC, status), Playwright 29/29 on Edge (no horizontal overflow at 390/820/1440 on 5 routes; axe WCAG 2.1 AA clean in light and dark; skip link; mobile nav; portal drawer), `tsc` clean, `next build` OK. Fixed along the way: money formatting bug, Sales Agent role was looser than the proposal, 2 contrast failures, stepper overflow at tablet width.
- Home page, `/account` and `/admin` are placeholders; `/login` and the Phase 3 public routes the header links to don't exist yet (404 until built).

## Phase 3 — Public website & CMS foundation ✅ (2026-10-13)
- **Public API** (`/api/v1/public/*`, read-only, published records only): packages (search/filters/sort/pagination/facets, details with priced departures, related), hotels (room types, nightly rates), transport, ziyarat, pages, posts/categories, FAQs, team, accreditations, reviews, settings, sitemap. Zod-validated queries, CDN cache headers, per-IP throttling with an internal-key bypass for SSR.
- **Lead capture** (`/public/leads/{contact,package-inquiry,custom-package}`): validation, honeypot + fill-time bot filter, 10-minute de-duplication, consent timestamp, UTM capture, `ENQ-YYYY-NNNNNN` references, customer matching, 5/min/IP limit. `Lead.reference` added to the schema.
- **CMS block model** in `@umrah/shared` (11 block types, safe-link rules, no raw HTML) + renderer; policies, About, Visa information, guides and blog are CMS-driven.
- **Web**: 22 route templates: home, About, packages (+URL-driven filters, mobile drawer, chips, sort, pagination), package details, hotels (+details), transportation, ziyarat (+details), visa information, Umrah guide (+sequence nav), blog, FAQ, contact, customized package, policies; plus `sitemap.xml`, `robots.txt`, branded OG image, JSON-LD (TravelAgency, WebSite, Product/Offer, Hotel, BlogPosting, FAQPage, BreadcrumbList), real 404s, WhatsApp button (when configured).
- **Demo data**: `npm run db:seed:demo` (refuses to run in production): fictional "Demo" hotels, 6 packages with departures, ziyarat, 6 guides, 2 posts, 14 FAQs, template policy pages. No fabricated reviews, customers, bookings or accreditations.
- **Verified**: API unit 38/38, API e2e (real Postgres) 27/27, web unit 11/11, Playwright on the *production build*: 57/57 public + 29/29 layout (forms through CORS to the DB, axe WCAG 2.1 AA light+dark on 18 pages, 3 viewports, SEO output, 404 statuses). `tsc` clean.
- **Bugs found and fixed by the tests**: filled honeypot returned 400 (revealed the trap), related packages empty for unique tiers, `bg-pattern` dropped by tailwind-merge (dark bands rendered pale), no-image gallery invisible, root `loading.tsx` caused soft-404 (HTTP 200), `<dl>` markup invalid, server→client render-prop 500 on `/design-system`, `ECONNRESET` on reused keep-alive sockets (API keep-alive 65 s + one GET retry), inactive-tab and muted-text contrast.
- **Headers**: public pages `s-maxage=60, stale-while-revalidate=300`; `/account`, `/admin`, `/login` `private, no-store`.

## Phase 4 - Auth, RBAC, security, API docs (done 2026-10-27)
- **API auth**: register / verify email / login / refresh / logout / sessions / forgot+reset+change password. Short-lived HS256 access JWTs; opaque rotating refresh tokens stored as HMAC hashes, with reuse detection (replay revokes the whole family; 10s grace returns `refresh_race`). argon2id, shared password policy, lockout (5 failures, 15 min), anti-enumeration responses.
- **Staff 2FA**: TOTP (RFC 6238) with replay guard (`twoFactorLastStep`, additive migration `20261027000000`), AES-256-GCM encrypted secrets, 10 single-use hashed backup codes, forced enrolment on first staff login.
- **RBAC**: default-deny global `AuthGuard` re-reads user/status/permissions from the DB each request; `@Public`, `@UserTypes`, `@RequirePermissions`; denials audited. Admin endpoints: audit logs, roles, staff.
- **Platform**: `AuditService` (redaction, append-only table), `MailerService` (`log` provider writes to `.local/outbox`; `resend` real; production refuses `log`/placeholders), settings cache, request IDs, unified error filter, throttler, Swagger at `/api/docs` (off in production unless `SWAGGER_ENABLED=true`).
- **Web**: `/login`, 2FA + setup + one-time backup codes page, `/register`, forgot/reset password, `/verify-email`; tokens only in httpOnly cookies; `proxy.ts` optimistic redirect + `requireUser()` real guard; silent refresh route; admin security page (password, backup codes, sessions); header shows My account / Staff portal.
- **Verified**: API unit 76/76, API e2e (real Postgres) 68/68, web unit passing, `tsc` clean, Playwright on the production build: 112+ passing (public, layouts, auth incl. axe on `/admin`, `/admin/security`, mobile drawer). Two axe timeouts were machine load; one real contrast bug (dimmed non-bookable departures) fixed.
- **Security fixes found while testing**: completed-refresh result cache (theft-replay hole) removed; backup codes shown via short-lived path-scoped cookie; Next 16.4.0 -> 16.4.3 (critical advisory); NestJS packages aligned at 12.2.0.
- **Operate**: `npm run db:deploy` then `npm run db:seed`; create staff with `npm run staff:create -w @umrah/api -- --email x --role SALES_AGENT`; dev emails land in `.local/outbox` (`EMAIL_PROVIDER=log`); set `WEB_TRUSTED_PROXY_HOPS` to the number of proxies in front of the web app.

## Phase 5 - Customer portal and booking workflow (done 2026-10-27)
- **API** (`/api/v1/me/*`, customers only, ownership enforced in services): profile; saved travelers (passport and national ID AES-256-GCM encrypted, hashed for duplicate detection, only ever returned masked, audited); departure room options; quote; booking draft, assign travelers, submit, cancel, list and detail.
- **Pricing is server-side** (`computeQuote` in `@umrah/shared`, exact integer minor units): per-room occupancy fares, child falls back to the adult fare, infants free unless priced, deposit rules (percentage, per person, per booking). The browser only previews.
- **Seat inventory**: seats are reserved with a conditional SQL `UPDATE` inside the booking transaction (no overselling under concurrency, tested with 3 simultaneous buyers for 2 seats). Drafts hold seats for 60 minutes and expire lazily; seats are released exactly once on expiry or cancel.
- **Workflow**: DRAFT -> PENDING_PAYMENT (submit) -> CANCELLED by the customer while unpaid; later states belong to staff (Phase 6/7). Status history, audit entries, confirmation email (`booking.submitted` template). Age category is by age on the return date (infant under 2, child 2-11); passport must be valid 6 months after return; submit is blocked with a clear list otherwise.
- **Web** (`/account`): dashboard, bookings list and detail (progress, travelers, price, history, cancel), room planner with live price preview, traveler assignment, travelers list/add/edit/remove, profile. Package pages now link to `/account/bookings/new?departure=...` when `NEXT_PUBLIC_ONLINE_BOOKING=1`.
- **Not in this phase** (honest scope): payments (no gateway chosen; bookings stay "Awaiting payment" and staff contact the customer), document upload and visa tracking (Phase 7), staff handling of bookings (Phase 6).
- **Verified**: API unit 83/83, API e2e (real Postgres) 82/82, `tsc` clean, Playwright portal journey 7/7 on the production build (register, verify, profile, travelers with masked IDs, rooms, assignment, passport fix, submit, email, cross-customer 404, cancel, axe WCAG AA and 390px no-overflow on 7 pages).
- **Bugs found by tests and fixed**: money fields serialised as `780000` instead of `780000.00`; child slot numbered by position instead of by type; a Phase 1 `booking.submitted` template with different variables produced a blank email (unified); dimmed non-bookable departures failed contrast.
- **Test helpers**: `npm run test:departure -w @umrah/api` (creates a published test departure), `npm run test:cleanup -w @umrah/api` (removes e2e data; the portal browser suite does this itself).

## Phase 6 - Admin portal (done 2026-10-31)
- **API** (`/api/v1/admin/*`, each route names its permission): dashboard figures; bookings (list with filters, detail, status workflow, assignment, internal notes); customers (search, detail, notes); packages (list, create, edit, publish/unpublish/archive) and departures (create, edit, delete) with room prices.
- **Booking handling**: staff move bookings along the workflow (customers submit; staff confirm, progress or cancel). Cancelling needs a reason, needs `bookings:cancel`, and releases the seats exactly once; two staff acting at once cannot both succeed. Confirming records no payment and says so. Confirmation email to the customer. Every change is audited and keeps a status history.
- **Catalogue rules**: a package can only be published with an upcoming Open departure that has a price; the web address locks once live; seats cannot drop below those already booked; departures with bookings cannot be deleted; price edits never change existing bookings (they keep their snapshot); changing a package refreshes the public site immediately.
- **Web** (`/admin`): real dashboard, bookings list and detail, customers list and detail, packages list/new/edit with a departures editor, staff list, roles and permissions, audit log. Pages show a clear "no access" message instead of data when the role lacks the permission, and the API refuses regardless.
- **Staff views show identity numbers masked only.** Revealing a full passport number belongs to the documents module (Phase 7) with its own audit trail.
- **Not in this phase** (still to build): editors for hotels, transport, ziyarat, itinerary and photos; CMS pages, blog and FAQ editors; reviews moderation; media library; settings; creating staff accounts from the UI (use `npm run staff:create`); reports. Payments, invoices, refunds, documents and visa tracking are Phase 7.
- **Verified**: API unit 83/83, API e2e (real Postgres) 92/92, `tsc` clean, Playwright staff portal journey 8/8 on the production build (dashboard, filters, notes, assignment, status changes, customers, package create-price-publish-archive with the public site checked, audit log, role limits, axe WCAG AA and 390px no-overflow).
- **Bugs found by tests and fixed**: a failed cancel attempt reset the status dropdown so the retry moved the booking to the wrong status (status now travels in a hidden field); archived packages stayed visible for up to a minute (public cache purged on edit); low-contrast green badges; a dashboard that overflowed on phones.
- **Test helpers**: `staff:create ... --test-2fa` (known authenticator secret, never in production), `npm run test:booking -w @umrah/api` (a submitted booking fixture).

## Pending
- Phase 7: payments (gateway still to be chosen), invoices, refunds, documents and visa tracking, CRM (leads, quotations, follow-ups).
- Phases 8-10 per plan. Waiting for approval to start.

## Blockers / open items
- Online booking is built; package pages show the Book button only when `NEXT_PUBLIC_ONLINE_BOOKING=1` (set it once payments/staff handling exist). Sidebar links Documents, Payments, Invoices, Visa tracking, Notifications, Support 404 until Phases 6-8.
- Remaining `npm audit` items need breaking upgrades: `multer` (via platform-express), Prisma's `deepmerge-ts`, unused `mysql2`.
- Throttler store is in-memory (single instance); Redis-backed in Phase 8. SES mail provider not implemented (use `resend`).
- Local browser tests need ~2 GB free RAM; on small machines run `PW_WORKERS=1 PW_CHANNEL=msedge npm run test:e2e -w @umrah/web` (4 cores/8 GB saturated at 3 workers).
- Docker isn't installed locally. Use `docker compose up -d` (Postgres on 5432 + Redis) or any Postgres 15+.
- Payment gateway provider still to be chosen (decision due by Phase 7).

## Run locally (Windows, no Docker needed)
```
npm install                 # once
npm run dev:db              # terminal 1: local PostgreSQL on :5432 (keep open)
npm run setup:local         # terminal 2, once: migrate + reference seed + demo data
npm run dev:api             # terminal 2: http://localhost:4000/api/v1/health
npm run dev:web             # terminal 3: http://localhost:3000
```
Design gallery: http://localhost:3000/design-system. Reset all data: stop `dev:db`, delete `.local/postgres`, start it again, run `npm run setup:local`.
Web tests: `npm test -w @umrah/web` (Jest) and `PW_CHANNEL=msedge npm run test:e2e -w @umrah/web` (Playwright; in CI run `npx playwright install chromium` and omit PW_CHANNEL).
