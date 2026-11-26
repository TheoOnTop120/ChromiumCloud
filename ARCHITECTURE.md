# Architecture

## Request path

```text
User browser --HTTPS--> Nginx Proxy Manager --existing Docker network--> Express gateway
                                                               |
                                                    private browser bridge
                                                               |
                                          per-account Chromium containers
```

Nginx Proxy Manager remains an external dependency. The gateway joins its existing `nginx-proxy-manager_default` network and the project-managed `chromiumcloud-browser` network. Browser containers are attached only to the latter. No host ports are published by this Compose file.

## Application components

- `server.js`: Express routes, HTML delivery, authentication middleware, admin endpoints, audit calls, HTTP and WebSocket proxying.
- `src/auth.js`: opaque authentication tokens, Argon2id password hashing using Node's built-in crypto API, secure cookies, CSRF validation, role checks, same-origin checks.
- `src/db.js`: synchronous SQLite access and additive schema migrations. SQLite is stored in `/data` on a named volume.
- `src/containers.js`: Docker CLI wrapper, dynamic container lifecycle, readiness polling, idle stop, per-container limits, and resource collection.
- `public/`: static HTML, CSS, and browser-side code.

The gateway uses the Docker socket to create and manage session containers. It does not expose Docker APIs or commands through user-facing HTTP endpoints, but compromise of the gateway has host-level Docker impact. Treat the gateway as a trusted administrative service.

## Identity and persistence

`users` store account identity, role, activity state, and Argon2id hashes. `sessions` store hashed authentication tokens and expiry. `browser_sessions` store one UUID per user, creation time, and last activity. Migrations backfill a UUID for existing users without changing their user ID, container name, or profile volume name.

The current manager supports one Chromium profile per account. A container named `chromium-u-<user-id>` mounts the account's persistent `chromiumcloud_profile_<user-id>` volume at `/config`. Container restarts retain that volume. Session UUIDs are validated and resolved server-side; the page and browser proxy reject requests unless the UUID belongs to the authenticated user.

Browser containers are created on demand from `CHROMIUM_IMAGE`, with a 1.2 GiB memory cap, 0.5 CPU limit, 1 GiB shared memory, and a configurable concurrency ceiling. `IDLE_STOP_MS` controls idle shutdown. The Compose project does not define ten fixed browser services.

## Browser display

The LinuxServer Chromium image provides its browser UI over HTTP on container port 3000. The gateway reverse-proxies regular HTTP and WebSocket requests under `/browser/:uuid/`; the session page embeds that path and offers full-screen display. noVNC is provided by the Chromium image rather than a separate project service.

## Database schema

- `users`: account data and role.
- `sessions`: authenticated web sessions; token values are stored as hashes.
- `browser_sessions`: stable browser UUID per account.
- `audit_log`: account and administrative activity.

Database migrations are performed at startup with `CREATE TABLE IF NOT EXISTS` and additive column checks. This is intentionally a small SQLite deployment; use a managed database and a migration framework before multi-instance operation.

## Isolation boundaries and limitations

Each account's Chromium process runs in a separate container with a distinct `/config` volume. The gateway checks browser-session ownership before proxying. Browser containers currently share one user-defined Docker bridge network; they are not mutually network-segmented, and the deployment has not been tested against hostile tenant workloads. Do not treat this configuration as a hardened public multi-tenant service without per-session network isolation and a restricted Docker API proxy.

The existing personal profile at `chrome.theoserver.duckdns.org` was not visible from the environment used to edit this repository. ChromiumCloud does not inspect, import, reset, or replace it. The operator must identify its container and volume on the Docker host and establish a verified mapping before deployment.

The current implementation provisions one browser session per account, not multiple UUID sessions for one account. Admin functionality manages users and their associated browser containers; full independent session CRUD and destructive profile-reset workflows are not implemented.
