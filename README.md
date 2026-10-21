# Replayowl

Website: [replayowl.com](https://replayowl.com)

Self-hosted session recording and replay for websites. It deploys to Cloudflare Workers, keeps recordings in S3-compatible storage and session summaries in a database (Cloudflare D1 or Postgres), lets you search sessions by user, page and behavior, and protects the dashboard with an admin password, sign-in through any standard OAuth 2.0 / OpenID Connect provider, or both. The recorder is about 20 KB (minified, before gzip) with zero runtime dependencies; the server depends only on aws4fetch and, for Postgres, pg; the player focuses on replays that look exactly like what the visitor saw and are pleasant to watch.

## Quick start (local)

Requires Node 24 or later (it runs TypeScript directly) and a Postgres server for session summaries and search. Start one with Docker:

```bash
docker run -d --name replayowl-pg -p 15432:5432 -e POSTGRES_USER=replayowl -e POSTGRES_PASSWORD=replayowl postgres:17
npm install
DATABASE_URL=postgres://replayowl:replayowl@127.0.0.1:15432/replayowl npm start   # build and serve http://127.0.0.1:8790
```

The first visit to http://127.0.0.1:8790/ asks you to set the admin password; sign in with it from then on. Open http://127.0.0.1:8790/demo/, click, type and browse around the demo shop, then go back to the dashboard to see the session list and replay it.

The tables are created automatically on the first request. Recordings are stored as files (`DATA_DIR`, default `./data`); when `S3_BUCKET` and related variables are set, S3 is used instead. Other environment variables: `DATABASE_URL` (required), `PORT` (default 8790), `HOST` (default 127.0.0.1), `SETUP_TOKEN`, and the `OAUTH_*` variables described under [OAuth sign-in](#oauth-sign-in).

## Docker

`docker compose up -d` builds the image and starts Replayowl with Postgres at http://127.0.0.1:8790/ (change the host port with `REPLAYOWL_PORT`). Recordings go to the `recordings` volume, or to S3 when `S3_BUCKET` is set. `SETUP_TOKEN`, `S3_*`, `OAUTH_*` and `POSTGRES_PASSWORD` are read from a `.env` file next to `docker-compose.yml` when present.

To run the image on its own against an existing Postgres:

```bash
docker run -d -p 8790:8790 -v replayowl-data:/data -e DATABASE_URL=postgres://user:pass@host:5432/replayowl replayowl/replayowl:latest
```

The image listens on `0.0.0.0:8790`, stores recordings in `/data` and has a health check on `/api/auth/status`.

## Deploying to Cloudflare Workers

The Worker handles the collector endpoint, the dashboard API and sign-in checks; the dashboard pages, the recorder script and the demo shop are uploaded alongside as static assets (Workers Static Assets, with `run_worker_first` so the Worker decides whether sign-in is required). Recordings live in any S3-compatible storage (AWS S3, Cloudflare R2, MinIO, RustFS, Aliyun OSS and so on), accessed with aws4fetch signatures. Session summaries, search indexes and the admin password live in a database: Cloudflare D1, or Postgres through Hyperdrive. `nodejs_compat` is on in `wrangler.jsonc` because the Postgres driver (`pg`) needs it.

1. Create a bucket and an access key that can only read and write that bucket. For R2, the endpoint is `https://<account-id>.r2.cloudflarestorage.com` and the region is `auto`.
2. Edit `vars` in `wrangler.jsonc`:

| Variable | Description |
| --- | --- |
| `S3_ENDPOINT` | Service endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or the R2 endpoint |
| `S3_BUCKET` | Bucket name |
| `S3_REGION` | Region; `auto` for R2 |
| `S3_PREFIX` | Optional key prefix, useful when several deployments share one bucket |
| `S3_PATH_STYLE` | Defaults to `true` (`endpoint/bucket/key`); set to `false` on AWS for virtual-hosted style (`bucket.endpoint/key`) |

3. Create the database, either D1 or Postgres. For D1, run `npx wrangler d1 create replayowl` and add the printed `d1_databases` block to `wrangler.jsonc` with binding `DB`. For an existing Postgres, create a Hyperdrive config with `npx wrangler hyperdrive create replayowl --connection-string=postgres://...` and add a `hyperdrive` block with binding `HYPERDRIVE`. When both are present the Worker uses `DB`; when neither is configured every request returns 500 naming the missing setting. The tables are created on the first request.
4. Store the secrets:

```bash
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
npx wrangler secret put SETUP_TOKEN      # recommended, see below
npx wrangler secret put OAUTH_CLIENT_SECRET   # only with OAuth sign-in, see below
```

To sign in through an OAuth provider, also add the non-secret `OAUTH_*` variables from [OAuth sign-in](#oauth-sign-in) to `vars`.

5. Deploy with `npm run deploy`. To debug locally on workerd, put the secrets in `.dev.vars` (see `.dev.vars.example`) and run `npm run dev:worker`.

The Workers paid plan is recommended. The free plan allows only 10 ms of CPU per request, which decompressing and validating a large initial snapshot or running PBKDF2 at sign-in (100k iterations) can exceed.

## Upgrading an existing deployment

Versions before the database stored the admin password in `config/admin.json` in the bucket. It now lives in the `settings` table, so after the upgrade the dashboard asks for setup again. Set `SETUP_TOKEN` before deploying (`npx wrangler secret put SETUP_TOKEN`) and complete setup right after the deploy, so nobody else can claim the dashboard in between.

Add the D1 or Hyperdrive binding (step 3 above) before deploying the new version; without it every request returns 500.

`config/admin.json`, `index/*` and `sessions/*/summary.json` in the bucket are no longer used and can be deleted.

Existing recordings are not imported into the database: their parts stay in the bucket, but they do not appear in the session list.

The session tables now carry a project column (see [Projects](#projects)). On the first request after the upgrade, the `sessions`, `session_pages`, `session_users` and `batches` tables are copied into the new layout, with every existing session in the project `default`, in one transaction. Nothing in the bucket changes. With many sessions this first request can take a while; on D1, a copy that runs into the statement time limit is rolled back and retried by the next request, so for a very large D1 database run the upgrade at a quiet time.

## Admin sign-in

The dashboard has a single admin account and two ways in: a password, and OAuth sign-in through a provider you configure (see the next section). Either one alone is enough, and both can be on at the same time; whoever signs in either way is the same admin.

- There is no username. Without OAuth configured, set the password (at least 8 characters) on your first visit to the dashboard; you are signed in automatically afterwards.
- After deploying and before the password is set, anyone who opens the dashboard could set it first. When `SETUP_TOKEN` is configured, setting the password also requires that token.
- With OAuth configured, the dashboard never offers first-time password setup and `POST /api/auth/setup` is refused, so nobody can claim a fresh deployment with a password. A password is optional: after signing in through OAuth, use "Set password" at the top right of the session list (no current password is asked for the first one).
- The password is hashed with PBKDF2-SHA256 (random salt, 100k iterations) and stored in the `admin` row of the `settings` table in the database. The plaintext is never stored. When only OAuth is used, the row holds just the cookie signing secret, created on the first OAuth sign-in.
- The sign-in state is an HttpOnly, SameSite=Lax cookie signed with HMAC using a random secret, valid for 14 days, with Secure added over HTTPS. Password and OAuth sign-ins get the same cookie.
- You can change the password and sign out from the top right of the session list. Changing or setting the password rotates the signing secret, which immediately signs out every other browser, OAuth sessions included (up to 10 seconds of delay across Worker instances).
- The sign-in endpoint limits failures (after 5 consecutive failures from one IP it locks for an increasing time; tracked per Worker instance, best effort). Changing the password, deleting sessions and similar actions only accept same-origin JSON requests.
- Only these are public: the collector endpoint `/api/ingest` (cross-origin posts from any site are allowed), `/recorder.js`, the sign-in page, the OAuth start and callback endpoints and the demo shop. The session list, replays and all session APIs require sign-in.
- Deleting a session that is still being recorded removes what was stored so far; if the visitor keeps browsing, the session comes back with only the batches uploaded after the delete.
- If you forget the password, delete the `admin` row with `DELETE FROM settings WHERE key = 'admin'` (on D1: `npx wrangler d1 execute replayowl --remote --command "DELETE FROM settings WHERE key = 'admin'"`) and open the dashboard to set a new one. With OAuth configured, sign in through OAuth and set a new password from the dashboard instead; deleting the row there removes the password and signs everyone out.

## OAuth sign-in

Any standard OAuth 2.0 or OpenID Connect provider works: Google, Microsoft Entra ID, Okta, Auth0, Keycloak, Authentik, GitLab, GitHub and so on. The flow is the authorization code grant with PKCE (S256) and a `state` check; the identity is read from the provider's userinfo endpoint with the access token. OAuth is on when `OAUTH_CLIENT_ID` is set.

1. Register an application (client) with the provider. The redirect (callback) URL is `https://<your-dashboard>/api/auth/oauth/callback`.
2. Set the variables. On Workers put the non-secret ones in `vars` in `wrangler.jsonc` and the client secret in a secret (`npx wrangler secret put OAUTH_CLIENT_SECRET`); for the Node server set them in the environment.

| Variable | Description |
| --- | --- |
| `OAUTH_CLIENT_ID` | Client ID; turns OAuth on |
| `OAUTH_CLIENT_SECRET` | Client secret (a secret on Workers). Leave empty for public clients that rely on PKCE alone |
| `OAUTH_ISSUER` | Issuer URL of an OpenID Connect provider; the endpoints are read from `<issuer>/.well-known/openid-configuration` |
| `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`, `OAUTH_USERINFO_URL` | The endpoints one by one, for providers without discovery such as GitHub. Each also overrides the discovered value |
| `OAUTH_ALLOW` | Required. Who may sign in, separated by commas or spaces: an email (`alice@example.com`), a whole email domain (`@example.com`) or a provider account ID (`sub:<id>`) |
| `OAUTH_SCOPES` | Default `openid email profile` |
| `OAUTH_NAME` | Name on the sign-in button ("Continue with ..."), default `SSO` |
| `OAUTH_TOKEN_AUTH` | How the client secret is sent to the token endpoint: `basic` (HTTP Basic) or `post` (form body). Default: what discovery advertises, preferring `basic`; `post` without discovery |
| `OAUTH_REDIRECT_URI` | Overrides the callback URL. Needed when the server cannot see the public origin, e.g. the Node server behind an HTTPS reverse proxy |

`OAUTH_ALLOW` is required because without it every account at the provider (every Google account, say) could open the dashboard; a missing allowlist or missing endpoints make every request fail with 500 naming the problem. Emails count only when the provider does not mark them unverified (`email_verified: false`). Account IDs are the `sub` claim, or the numeric `id` for providers like GitHub. When an account is refused, the sign-in page names its email and ID, so you can copy the ID into `OAUTH_ALLOW`.

Examples:

```bash
# Google (OpenID Connect)
OAUTH_NAME=Google
OAUTH_ISSUER=https://accounts.google.com
OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com
OAUTH_CLIENT_SECRET=...
OAUTH_ALLOW=@example.com

# GitHub (plain OAuth 2.0, no discovery). The email is the account's public email and may be empty, so allow by ID.
OAUTH_NAME=GitHub
OAUTH_AUTHORIZE_URL=https://github.com/login/oauth/authorize
OAUTH_TOKEN_URL=https://github.com/login/oauth/access_token
OAUTH_USERINFO_URL=https://api.github.com/user
OAUTH_SCOPES=read:user
OAUTH_CLIENT_ID=...
OAUTH_CLIENT_SECRET=...
OAUTH_ALLOW=sub:1234567
```

For Keycloak the issuer is `https://<host>/realms/<realm>`, for Microsoft Entra ID `https://login.microsoftonline.com/<tenant-id>/v2.0`, for Okta and Auth0 the tenant URL.

The ID token is not used, so no keys are fetched or verified; trust comes from redeeming the code at the token endpoint over HTTPS with the PKCE verifier. The `state` and verifier live in an HttpOnly cookie scoped to `/api/auth/oauth/` for 10 minutes, and the page to return to after sign-in is limited to paths on the same site. Provider errors are written to the server log and the sign-in page shows a short message.

## Recording your own site

```html
<script src="https://your-server/recorder.js" data-endpoint="https://your-server/api/ingest" defer></script>
```

Or start it manually with `ReplayOwl.start({ endpoint: "https://your-server/api/ingest" })` and stop it with `ReplayOwl.stop()`.

To find sessions by your own user ID, pass it with the `data-user-id` attribute on the script tag, `ReplayOwl.start({ userId })`, or `ReplayOwl.identify(userId)`. `identify` can be called at any time after the script has loaded, including before `start`, and the whole session, including the part before the call, is attributed to that user. An ID is 1 to 128 characters; a session keeps at most five distinct IDs (a session that switches accounts is findable by each), and the current ID is kept in sessionStorage so later pages of the same session carry it. With `defer`, the script has not run yet when inline code executes, so call `identify` after the script has loaded (for example in its `load` event) or use `data-user-id`.

Options (written as `data-mask-all-text` and so on on the script tag):

| Option | Default | Description |
| --- | --- | --- |
| `maskAllInputs` | true | Mask all text inputs by default |
| `maskAllText` | false | Mask all text on the page |
| `maskEmails` | true | Mask email addresses in regular text |
| `maskCardNumbers` | true | Mask runs of 12 to 19 digits (card and account numbers) |
| `maskDigits` | false | Mask all digits (off by default because it badly hurts replay readability) |
| `sessionTimeoutMin` | 30 | Idle minutes after which the next page load starts a new session |
| `captureLogs` | true | Capture console.error / warn, uncaught exceptions and unhandled promise rejections |
| `project` | none | Project key added to the endpoint as `?project=`, for a collector that serves several projects. A self-hosted Replayowl has one project and ignores it |

Privacy markers on the page:

- `data-ro-unmask`: unmask this input (or the inputs in its subtree). Password fields, `autocomplete="cc-*"` fields and fields named like password / cvv / iban are never unmasked.
- `data-ro-mask`: mask all text and title / alt / placeholder in the subtree.
- `data-ro-block`: do not record the element at all; the replay shows a same-sized hatched placeholder.

Masking keeps the length of each word (characters become `*`), so the layout does not shift in replay. Passwords always show 8 dots and do not reveal their length. All masking happens in the browser; the original text never leaves the page.

Deploy the collector on a public domain: Chrome's Local Network Access blocks public pages from sending requests to addresses such as 127.0.0.1.

## Replay experience

- **Cursor**: the recorder samples every 40 ms and the player interpolates with Catmull-Rom curves, so movement follows smooth curves instead of straight segments. After a pause the cursor stays put and glides to the next sample only in the last 140 ms, avoiding fake slow drifting. An optional amber trail shows the last 0.6 seconds of movement.
- **Scrolling**: interpolated between samples, so scrolling is continuous. Images and fonts load asynchronously in the replay document and an early `scrollTo` can get clamped; the player keeps correcting until the scroll position matches the recorded value.
- **Hover, focus, active**: `:hover`, `:focus`, `:focus-visible`, `:focus-within` and `:active` in the replay document are rewritten into attribute selectors (same specificity) driven by the replay cursor. Pure CSS dropdown menus and button hover effects are reproduced.
- **Flicker-free seeking**: two iframes are double-buffered. Seeking backwards or switching pages rebuilds in the hidden one and swaps when done. A seek applies only DOM changes and the final scroll, focus and viewport state, so the browser lays out once; on a 5,700-node Wikipedia page a seek takes about 3 to 7 ms.
- **Idle skipping**: stretches of 3 seconds or more without user activity are drawn hatched on the timeline and, however long, are fast-forwarded in about 1 second during playback with a "Skipping inactivity" notice. Scrolls, value changes and focus changes made by page script (carousels, auto-scrolling feeds, form scripts) with no user input in the 3 seconds before them do not count as activity.
- **Timeline**: a waveform of user activity density along the bottom; clicks (amber), rage clicks (red dots), inputs (purple dots), errors (red diamonds) and page changes (purple lines) are marked; hovering shows the time and event description; dragging previews instantly, with pointer moves coalesced into one seek per frame.
- **Sidebar**: the activity list (pages opened, what was clicked, what was typed, rage clicks) highlights and follows playback, and clicking an entry jumps to it; the console panel lists errors and warnings with stack traces; the details panel lists the device, viewport and every page visited.
- **Multi-page sessions**: page loads in the same tab within 30 minutes are merged into one session, and the address bar shows the page being replayed and its page number.
- **Shortcuts**: space plays and pauses, left and right arrows jump 5 seconds (15 with Shift), `,` `.` go to the previous and next event, `1` to `5` set 0.5x to 8x speed, `S` toggles idle skipping, `T` the trail, `F` fullscreen.

## What gets recorded

- **DOM**: a full snapshot of the first screen, then incremental changes via MutationObserver. Every node has a fixed numeric id that the player uses to find it, with no reliance on CSS selectors (selector-based paths such as `index:selector` easily target the wrong node after the DOM changes). A batch of changes is reduced to its final state: removed ids, added or moved subtrees in document order, and attribute and text changes. Moving a known node sends only a reference.
- **Styles**: rules from same-origin (or CORS-enabled) `<link>` stylesheets are inlined into the snapshot, so replay does not depend on the original site still serving the same CSS; `url()` values are made absolute, and sheets still loading are sent once they load. Rules CSS-in-JS writes only into the CSSOM (`<style>` elements with empty text) are read from the CSSOM; `insertRule` / `deleteRule`, constructed stylesheets and `adoptedStyleSheets` (including changes like `push` that bypass the setter) are all captured.
- **Shadow DOM**: open shadow roots and their constructed stylesheets, including custom elements that call `attachShadow` after the snapshot.
- **Forms**: typing, selecting and checking, plus values assigned directly by scripts (the `value` / `checked` / `selectedIndex` setters are intercepted, so autofill by form libraries is recorded too).
- **Behavior**: mouse and touch movement, clicks (with the button or link text, privacy-filtered), window and element scrolling, viewport size, focus, tab visibility, media play and pause, and console errors.
- **Transport**: the initial snapshot is uploaded immediately, then a batch every 4 seconds, gzipped above 2 KB, sent one at a time in order and retried with exponential backoff on failure; when the page is hidden or closed, the remaining data is sent right away with `keepalive`. A retried batch overwrites the same object, and the database deduplicates by (session, page, sequence number).

## Storage and API

Storage layout (S3 has no append, so every upload is its own object). Object storage holds only the recordings:

| Key | Contents |
| --- | --- |
| `sessions/<session>/parts/<first-timestamp>-<page>-<seq>.json.gz` | One uploaded batch, gzipped; batches the browser already compressed are stored as is |

The database (the same schema on D1 and Postgres) holds everything else:

| Table | Contents |
| --- | --- |
| `sessions` | One row per session: start, end and duration, first and last URL, page views, user agent, device, viewport, and counters for events, clicks, rage clicks, errors and inputs |
| `session_pages` | One row per page view: session, timestamp, host, path and full URL |
| `session_users` | The user IDs of each session |
| `batches` | One row per uploaded batch, used to skip retried batches and to detect rage clicks that span two batches |
| `settings` | The admin password hash (when a password is set) and cookie signing secret (the `admin` row) |

Every session table also has a `project_id` column, part of each primary key; see [Projects](#projects).

For replay, the browser downloads the parts directly (6 in parallel, gzip decoded by the browser) and merges and sorts them locally. The server neither parses nor compresses them, so the Worker's CPU cost is close to zero.

API: `POST /api/ingest`; with sign-in, `GET /api/sessions` (list and search, see below), `GET /api/sessions/:id` (summary and part list), `GET /api/sessions/:id/parts/:name`, `DELETE /api/sessions/:id`; for authentication, `GET /api/auth/status`, `POST /api/auth/setup`, `/login`, `/logout`, `/password`, and for OAuth `GET /api/auth/oauth/start?next=<path>` and `GET /api/auth/oauth/callback`.

The player can also be embedded on its own: `createPlayer(container, events, { speed, skipIdle, trail })` returns a `replayer` with `play`, `pause`, `seek`, `setSpeed` and `on("time" | "page" | "state" | "end")`.

## Projects

A self-hosted Replayowl records one project, named `default`, and needs no configuration for it. The building blocks also serve a host with many projects in one database, each with its own object storage (its own bucket, or a key prefix in a shared one):

- `new SessionStore(storage, db, projectId)` (`src/server/store.ts`) reads and writes one project's sessions. The storage must hold only that project, for example an `S3Storage` whose `prefix` names it.
- `ingestRequest(req, store, { beforeStore })` and `sessionsRequest(req, url, rest, store, { canDelete })` (`src/server/app.ts`) are the collector endpoint and the session API for that store; the host decides which project a request belongs to and who may see it. `beforeStore(batch)` sees each parsed upload first and may refuse it by throwing an `HttpError` (a quota, for example). `errorResponse(err, cors)` turns what they throw into a JSON response.
- The recorder's `project` option (`data-project`) adds `?project=<key>` to the endpoint, so the host can pick the project before reading the upload.
- The dashboard pages read an optional `<script type="application/json" id="replayowl-config">` with `base` (prefix of the pages and of `<base>/api/sessions`), `canDelete`, `snippet` (the recorder tag shown while a project is empty), `account` and `demo` (show the admin account menu and the demo shop links). Without it they behave as described above.
- `build({ out, demo })` from `scripts/build.ts` builds the recorder and dashboard into another directory.

The package exports these as `replayowl/server/store.ts`, `replayowl/server/app.ts`, `replayowl/build` and so on.

## Search

`GET /api/sessions` lists sessions newest first and, with sign-in, accepts these optional parameters, combined with AND:

| Parameter | Meaning |
| --- | --- |
| `user` | Exact user ID |
| `url` | A visited page, see URL matching below |
| `urlMode` | `prefix` (default), `exact` or `contains` |
| `from`, `to` | Session start time range (milliseconds) |
| `minDuration`, `maxDuration` | Duration in seconds |
| `minPages` | Minimum page views |
| `errors=1`, `rage=1` | Sessions with errors, sessions with rage clicks |
| `device` | `desktop`, `mobile` or `tablet` |
| `cursor` | Opaque keyset cursor returned as `next` by the previous page |
| `limit` | Page size, default 30, maximum 100 |

The response is `{ sessions, next }`; each session includes `userIds` and `device`. No total count is returned. Invalid values (a non-numeric duration, an unknown device or mode, a malformed cursor) return 400 with a message. The dashboard exposes the same filters and keeps them in the query string, so a search can be bookmarked or shared.

URL matching looks at every page view of a session, not only the first, and a session matches once however many of its pages match. An input starting with `/` matches the path on any host. An input names a host only when it has a scheme (`https://shop.com/checkout`), starts with `//` (`//shop.com/checkout`) or has a dot in its first segment (`shop.com/checkout`); it then matches host and path. Anything else is a path, so `localhost:3000/x` without a scheme is the path `/localhost:3000/x`. A bare word such as `checkout` means `/checkout` in `prefix` and `exact` mode, and in `contains` mode matches anywhere in the path. The query string and fragment in the input are ignored, and an input containing a backslash is rejected. `prefix` and `exact` use the path indexes. `contains` matches a substring of the path and scans page views, so it is slower on large data and, on D1, billed by rows read.

## Tests

```bash
npm run typecheck
npm test             # unit tests + end-to-end tests (Node + Postgres + local file storage)
npm run test:s3      # the same with a real S3-compatible service as storage
npm run test:worker  # end-to-end tests on workerd (wrangler dev, the Workers runtime) + S3, once with local D1 and once with Postgres through a local Hyperdrive binding
npm run test:live    # needs internet: injects the recorder into Wikipedia, react.dev and GitHub and compares replays
```

`npm test` and the other database-backed tests need Postgres, by default at `postgres://replayowl:replayowl@127.0.0.1:15432/replayowl` (override with `PG_TEST_URL`); start it with the `docker run` line from the quick start. `test:s3` and `test:worker` also need an S3-compatible service, by default at `http://127.0.0.1:19000`. Start one with Docker:

```bash
docker run -d --name replayowl-s3 -p 19000:9000 -e RUSTFS_ACCESS_KEY=replayowl -e RUSTFS_SECRET_KEY=replayowl-secret-key rustfs/rustfs
```

You can also point `S3_TEST_ENDPOINT`, `S3_TEST_KEY` and `S3_TEST_SECRET` at another service. The storage test confirms that a wrong secret is rejected by the server, proving requests really are signed and checked. If only an existing bucket is available, also set `S3_TEST_BUCKET` (and `S3_TEST_REGION`); the tests then run inside a new folder in that bucket (`S3_TEST_PREFIX`, timestamped by default) and empty it afterwards.

To run the end-to-end tests against a deployed Worker, deploy it with a D1 database (or Hyperdrive), `S3_PREFIX` set to a new empty folder and `SETUP_TOKEN` set, then run:

```bash
REMOTE_BASE=https://<worker>.<subdomain>.workers.dev SETUP_TOKEN=<token> npm run test:remote
```

The roundtrip, search and sign-in tests each expect an empty database and folder and change the admin password, so before each spec delete all rows from `sessions`, `session_pages`, `session_users`, `batches` and `settings` and empty the folder (run the specs one at a time, for example `npx playwright test roundtrip --workers 1`, instead of `test:remote` in one go).

- The end-to-end roundtrip test (`tests/e2e/roundtrip.spec.ts`) walks through three pages of the demo shop, signs in to the dashboard, seeks the replay to the matching moment on each page and compares it with the live page: DOM structure (including Shadow DOM), text (only masking differences allowed), form values, window and inner scroll positions, and computed styles that prove each styling path works. It also checks that the session API returns 401 without sign-in, that sensitive input never appears in stored data, that hover menus open in replay, that seeking backwards then forwards gives the same state, and that real playback at 8x to the end gives the same state.
- The sign-in test (`tests/e2e/auth.spec.ts`) covers first-time setup (length, mismatched confirmation), refusing a second setup, wrong passwords, another browser being signed out after a password change in the dashboard, the old password no longer working, signing out, refusing cross-origin and form requests, and `SETUP_TOKEN`.
- The OAuth test (`tests/e2e/oauth.spec.ts`) runs against a mock OpenID Connect provider and checks discovery, PKCE and Basic client authentication, the OAuth-only sign-in page and the refused password setup, setting a password after an OAuth sign-in and then signing in both ways, allowing by email and by `sub:`, refusing unlisted accounts and unverified emails, a cancelled sign-in, a forged callback without the state cookie and an off-site `next`. `tests/unit/oauth.test.ts` covers configuration parsing, allowlist matching and token endpoint authentication.
- The storage test runs the same contract against both the local file and S3 implementations: reads and writes, paginated listing and deletion of recordings. The database tests (`tests/unit/db.test.ts`, `store.test.ts`, `search.test.ts`) run against Postgres and cover ingest, deduplication of retried batches, rage clicks spanning batches, concurrent batches of one session, every search filter, URL modes, keyset pagination and deletion.
- The search test (`tests/e2e/search.spec.ts`) finds sessions by user ID, URL and filters through the API and the dashboard.

On three real websites, the replayed DOM matched the live DOM in node count and node-by-node structure, with zero text differences and matching scroll positions.

## Limitations

- Images, fonts and cross-origin stylesheets without CORS still load from the original site; if the site goes down or changes, these resources go missing or change.
- iframe contents, canvas contents and closed shadow roots are not recorded.
- Seeking backwards in a long-running single-page app replays all changes since the page snapshot, which slows down when there are very many changes.
- Counters are exact, but a rage click burst split across keepalive uploads sent at page unload may be missed, since those uploads go out in parallel. The events, markers and stats shown on the replay page are recomputed from the parts anyway.
- Every upload is one object, so a very long session has hundreds of parts; the browser downloads them for replay (6 in parallel), so the first open takes a moment.
- Public pages cannot report to local addresses such as 127.0.0.1 (Chrome's Local Network Access), so the collector must be deployed on a public domain.

## License

Copyright 2026 replayowl. Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). If you run a modified version as a network service, you must offer its complete source code to its users. For commercial licensing without these terms, contact oss@replayowl.com.
