# Architecture & Data Model

## Monorepo (npm workspaces)

| Path | Purpose |
|---|---|
| `apps/web` | Next.js 16 (App Router, RSC) + Tailwind 4 + shadcn/ui. Public site, customer portal (`/account`), staff portal (`/admin`). |
| `apps/api` | NestJS 12 REST API (`/api/v1`). Prisma 7 + PostgreSQL. BullMQ workers (Phase 8). |
| `packages/shared` | Code-defined RBAC (roles, permissions, matrix) and booking workflow rules shared by API + UI. |

Pinned toolchain: Node ≥22.12, TypeScript 6.0 (ts-jest doesn't support TS 7 yet), Prisma 7.10 (8.x is still RC).
NestJS 12 is ESM-only. The API compiles to CommonJS and loads Nest through Node's `require(esm)`; Jest runs with `--experimental-vm-modules`.

## Frontend structure (`apps/web/src`)

`app/(public)` marketing site · `app/(customer)/account` customer portal · `app/(admin)/admin` staff portal · `app/(dev)/design-system` component gallery (not served in production). `components/ui` is shadcn; `components/{brand,layout,commerce,data,feedback,forms,motion}` are product components; `config/site.ts` holds navigation (admin items carry a permission key and are filtered against the signed-in role). `lib/status.ts` is the single mapping from every status enum to a label and tone. Server components can't pass icon components to client components, so the portal shell selects its own nav by `variant`.

## Public website & CMS (Phase 3)

**Data flow.** Next.js Server Components call the NestJS public API (`/api/v1/public/*`, read-only, published records only) through `apps/web/src/lib/api.ts`. Responses use Next's data cache (`revalidate: 60`, tagged) and the API adds `Cache-Control: s-maxage=60, stale-while-revalidate=300` for a CDN. Pages render on request, so `next build` does not need the API. SSR requests carry `x-internal-key` to bypass per-IP throttling (all pages would otherwise share the web server's IP).

**Contracts.** Response shapes (`public-api.ts`), filter/search query, lead-form schemas and the CMS block schema live in `@umrah/shared`, so the API validates and the browser pre-validates with the same zod schemas.

**Search.** `/packages` is URL-driven (shareable, crawlable): departure city, travel month/dates (open, bookable departures only), price, duration, hotel stars, tier, category, services, free text, sort, pagination. Filtered views are `noindex` and canonicalise to `/packages`. `Package.startingPrice` is denormalised; `refreshStartingPrice()` must run whenever departures or prices change.

**CMS content model.** Pages and posts store `{ version: 1, blocks: [...] }` (heading, paragraph, list, callout, image, steps, table, quote, cta, faq, divider). There is no raw-HTML path: text supports `**bold**`, `*italic*` and `[label](href)`, links are limited to site paths, https, mailto and tel, and the renderer builds React elements. Scheduled posts (`publishedAt` in the future) stay hidden until due. Policies (`PageType.POLICY`), About, Visa information, guides and blog are all CMS-driven; the admin editor arrives in Phase 6.

**Lead capture.** Contact, package enquiry and custom-package forms POST directly to the API: strict per-IP throttle (5/min), honeypot + minimum fill time (bots are dropped silently), de-duplication within 10 minutes, consent timestamp, UTM capture, human-readable reference (`ENQ-YYYY-NNNNNN`, atomic Postgres sequence) and automatic linking to an existing customer by email/phone. Success is only shown after the lead is stored.

**SEO.** Per-page title/description/canonical/Open Graph, JSON-LD (TravelAgency, WebSite, Product with Offer, Hotel, BlogPosting, FAQPage, BreadcrumbList), `sitemap.xml` built from published content, `robots.txt`, branded default OG image, real 404 status codes. Analytics and consent management are Phase 8.

**Demo data.** `npm run db:seed:demo` loads clearly-labelled sample hotels, packages, departures, ziyarat, guides, blog posts and FAQs. It refuses to run in production and never creates customers, bookings, payments, reviews or accreditations. Replace it through the admin CMS.

## Backend modules (planned, one Nest module per bounded context)

`auth` (JWT access 15m + rotating refresh sessions, argon2id, TOTP 2FA for staff) · `rbac` (permission guard reading `@umrah/shared`) · `catalog` (packages, departures, hotels, transport, ziyarat) · `bookings` (state machine in `packages/shared/booking-workflow.ts`) · `customers`/`travelers` · `payments` (gateway adapter interface + `manual` provider, webhook idempotency) · `invoices` · `documents` (private S3, presigned PUT/GET, audit every access) · `visas` · `crm` (leads, custom requests, quotations, follow-ups, notes) · `reviews` · `cms` (pages, posts/guides, FAQs, media) · `notifications` (email: SES/Resend; WhatsApp Cloud API; in-app; queued via BullMQ) · `automation` (rules → delayed jobs) · `reports` · `settings` · `audit`.

## Security baseline

- Passport and CNIC numbers are AES-256-GCM encrypted (`common/crypto/field-encryption.ts`). Each also gets an HMAC hash so duplicates can be found without decrypting.
- Private files stay in a private S3 bucket and are served only through short-lived presigned URLs, after ownership or permission checks.
- `AuditLog` is append-only, enforced by a DB trigger.
- DB CHECK constraints guard star ratings, seat inventory, positive amounts, passenger counts, and lowercase emails.
- Env is validated at boot (zod) and the app fails fast on bad config. Secrets come only from env and are never stored in the `Setting` table.
- Payment success is set only by a verified gateway webhook or by finance-officer verification of offline proof.

## Authentication & authorization (Phase 4)
- Web server holds tokens in httpOnly cookies; the API is bearer-based. Access JWT 15m (iss `umrah-api`, aud `umrah-web`); refresh tokens are opaque, rotated on every use, stored as HMAC-SHA256 hashes grouped by `familyId`. Replaying a rotated token outside a 10s grace revokes the family.
- `AuthGuard` (global, default-deny) loads the user, status and permissions from the DB per request; routes opt out with `@Public()` and require `@UserTypes()` / `@RequirePermissions()` from `@umrah/shared` RBAC. Denials are written to `AuditLog`.
- Staff must enrol TOTP 2FA (secret encrypted AES-256-GCM, replay-guarded, backup codes hashed). Customers use email verification; password reset is single-use and anti-enumerating.
- Next `proxy.ts` is only an optimistic redirect; `requireUser()` in layouts is the real check. Token refresh runs in `/auth/refresh` (cookies cannot be set while rendering).
- Mail goes through `MailerService` (`log` in dev, `resend` in production). Throttling is per IP; SSR GETs bypass it with `INTERNAL_API_KEY`, and mutations carry the visitor IP via `x-client-ip` (trusted only with the key).

## Customer portal and bookings (Phase 5)
- `/api/v1/me/*` is customer-only. Every lookup is scoped by the signed-in customer id and answers 404 for anything not theirs, so ids cannot be probed.
- Prices come only from the database: `computeQuote` (shared, integer minor units) runs on the server at draft creation; the stored `pricingSnapshot` keeps the prices, deposit rule and room plan used, so later price edits never change an existing booking.
- Seats: `UPDATE "PackageDeparture" SET "seatsReserved" = "seatsReserved" + n WHERE ... AND "seatsReserved" + n <= "seatsTotal"` inside the booking transaction. Release (cancel or hold expiry) is a guarded transition (`updateMany` on status) followed by `GREATEST(seatsReserved - n, 0)`, so a seat is never released twice.
- Draft holds last 60 minutes (extended when travelers are saved) and are swept lazily on access; a scheduled sweep arrives with BullMQ in Phase 8. Submitted bookings keep their seats until staff or the customer cancels.
- Traveler identity numbers: encrypted (AES-256-GCM) plus a keyed hash for duplicate detection; DTOs expose masked values only; the audit log redacts them. Travelers on submitted bookings are locked (staff correct them).

## Admin portal (Phase 6)
- `/api/v1/admin/*` routes each declare a `@RequirePermissions` key from `@umrah/shared`; the web pages check the same keys only to show a friendly message. Workflow rules (`BOOKING_TRANSITIONS`) are enforced in the service, so the UI only offers moves the server will accept (`allowedTransitions`).
- Concurrent edits: every status change is `updateMany WHERE id AND status = <status the staff member saw>`; a count of 0 means someone else changed it first and the request is refused.
- Catalogue edits that affect the public site call `revalidatePath('/', 'layout')` so the 60-second data cache does not keep archived or edited packages on show. Behind a CDN the `s-maxage` of 60 seconds still applies.
- Server actions that re-render the same form must not rely on controlled-select values surviving React's automatic form reset: anything that decides what is submitted (such as the target booking status) lives in a hidden input driven by state.

## Data model (Prisma, `apps/api/prisma/schema/*.prisma`)

| Domain | Models |
|---|---|
| auth | User, Role, Permission, RolePermission, UserRole, Session, TwoFactorBackupCode, UserToken |
| customers | Customer (optional login), Traveler (mahram link, encrypted IDs) |
| catalog | Hotel(+Image, RoomType, RoomRate), TransportService (kind, shared/private), Ziyarat, PackageCategory, Package(+Image/Hotel/ItineraryDay/Transport/Ziyarat), PackageDeparture (seat inventory), DeparturePrice (per occupancy × adult/child/infant) |
| bookings | Booking (pricing snapshot, seat hold, wizard step), BookingRoom, BookingTraveler, BookingStatusHistory |
| payments | Payment, PaymentInstallment, Refund, PaymentWebhookEvent, Invoice, InvoiceLine |
| documents/visa | Document, VisaApplication, VisaStatusHistory |
| crm | Lead, CustomPackageRequest, Quotation(+Item, PDF), FollowUp, CrmNote, Communication, SupportRequest, Review |
| cms | MediaAsset, Page, PostCategory, Post (BLOG/GUIDE/NEWS), Faq, TeamMember, Accreditation |
| platform | NotificationTemplate, Notification, AutomationRule, AuditLog, Setting, Sequence, FunnelEvent |

### Status sets
- **Booking:** DRAFT → PENDING_PAYMENT → CONFIRMED → VISA_PROCESSING → TRAVEL_PREPARATION → COMPLETED, or CANCELLED. Wizard steps: PACKAGE, DATE, TRAVELERS, ROOMS, TRAVELER_DETAILS, DOCUMENTS, PAYMENT, CONFIRMATION.
- **Booking payment:** UNPAID, DEPOSIT_PAID, PARTIALLY_PAID, PAID, OVERDUE, REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED.
- **Payment transaction:** PENDING, PROCESSING, SUCCESSFUL, FAILED, REFUNDED, PARTIALLY_REFUNDED (proposal §9) + AWAITING_VERIFICATION (offline proof, finance verify/reconcile) and CANCELLED.
- **CRM lead (proposal §11):** NEW → CONTACTED → QUALIFIED → QUOTATION_SENT → FOLLOW_UP → NEGOTIATION → CONVERTED, plus LOST as an exit.
- **Visa:** NOT_STARTED, DOCUMENTS_PENDING, UNDER_REVIEW, READY_TO_SUBMIT, SUBMITTED, IN_PROCESS, APPROVED, ISSUED, REJECTED, CANCELLED.

## Proposal reconciliation (Umrah_Travel_Commercial_Product_Proposal.pdf, 9 pages)

Aligned in Phase 1b: CRM stages, payment statuses (+ finance verify/reconcile fields), booking lifecycle (no "in travel" state), hotel room types and rates, transport kinds and shared/private, About-page team and accreditations, communication history, quotation PDFs, customer-portal support requests, first-party funnel events, invoice / missing-document / welcome templates, inactive WhatsApp templates (Meta approval needed), missing-document automation rule, and least-privilege roles (Sales Agent has no booking write access; Booking Manager creates bookings from accepted quotations).

Proposal items scheduled for later phases: Swagger/OpenAPI docs and rate limiting (P4), Sentry + CloudWatch (P9/10), Google Analytics + Search Console, sitemap/robots/schema markup (P8), backups with PITR and a DR runbook (P9/10), dev/staging/prod environments and CI/CD (P10), Arabic/Urdu/English (listed as future scalability, so the UI uses RTL-safe logical CSS properties from Phase 2).

The proposal estimates ~20-30 core tables. The model has more because it includes join tables, history/audit tables and CMS entities.

## Remaining assumptions

1. Market is Pakistan (CNIC). Default currency PKR and timezone Asia/Karachi, both configurable in `Setting`.
2. Deposit is configured per package (percentage or fixed). Default balance due date is 30 days before departure.
3. UI language is English only for now. Templates and settings carry `locale`.
4. The payment gateway is "agency-selected" (not yet chosen). An adapter interface ships with a `manual` (bank transfer / offline) provider.
5. Only staff need 2FA ("Admin 2FA"). Customers use email verification.
6. LOST is added as a CRM exit stage, and CANCELLED / AWAITING_VERIFICATION are added to payment statuses. These go beyond the proposal's lists.
