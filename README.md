# ChromiumCloud

ChromiumCloud is a self-hosted web gateway for persistent Chromium workspaces. The repository contains an Express application, a SQLite database, and a Docker-backed Chromium session manager. The web client is served from `public/`.

## Current scope

- Server-side login with Argon2id password hashes, HTTP-only secure cookies, CSRF tokens, rate-limited login attempts, and admin/user roles.
- Persistent SQLite account, authentication-session, browser-session UUID, and audit records.
- One persistent Chromium profile per account, started on demand in a resource-limited container.
- Authenticated reverse proxy for browser HTTP and WebSocket traffic.
- Admin pages for users, browser state, resource snapshots, settings, exports, and audit records.
- Up to 11 concurrent browser containers by default. Change `MAX_SESSIONS` to fit the host's available resources.

A browser-session UUID is a stable identifier for an account's current browser profile. It does not create multiple browser profiles for one account. Existing Chromium profiles on the host have not been mapped automatically; see [INSTALLATION.md](INSTALLATION.md) before deployment.

## Requirements

- Ubuntu or another Linux host with Docker Engine and the Docker Compose plugin.
- The existing Docker network `nginx-proxy-manager_default`.
- Sufficient memory for the configured number of Chromium containers (each is limited to 1.2 GiB and 0.5 CPU by the session manager).
- A TLS-terminating reverse proxy. ChromiumCloud sets secure authentication cookies.

## Start

1. Review the existing containers, networks, and volumes before changing anything. Back up the Chromium profile you intend to preserve.
2. Copy `.env.example` to `.env` and replace `ADMIN_PASSWORD` with a unique random value. Keep `.env` private.
3. Build and start the application from the project directory:

   ```sh
   docker compose up -d --build
   ```

4. Configure Nginx Proxy Manager manually as described in [INSTALLATION.md](INSTALLATION.md). Compose does not create or alter Proxy Hosts.
5. Sign in with `ADMIN_USER` and `ADMIN_PASSWORD` on the first initialization. Bootstrap credentials are ignored after a user database already exists.

There are no published host ports in the Compose configuration. NPM reaches `chromium-gateway:3000` over its existing Docker network. Browser containers use the separate `chromiumcloud-browser` bridge network.

## Operations

```sh
docker compose logs -f chromium-gateway
docker compose restart chromium-gateway
docker compose down
```

`docker compose down` stops and removes the gateway container and Compose network, but retains named volumes. Do not use `-v` unless you deliberately intend to delete application data.

Back up SQLite data and browser profile volumes before upgrades or restoration work. See the backup notes in [INSTALLATION.md](INSTALLATION.md). The existing `scripts/backup.sh` requires Docker access and backs up volumes whose names match this project's current naming convention.

## Routes

- `/` home page
- `/login` sign-in
- `/session` redirects to the signed-in user's UUID session
- `/session/:uuid` owner-checked browser workspace
- `/admin` admin console
- `/health` process health endpoint

The requested public hostnames are `chromium.theoserver.duckdns.org` for the application and `chrome.theoserver.duckdns.org` for the existing personal browser. These DNS and NPM entries must be configured and verified on the server; this repository does not edit them.

## Verification status

The current editor environment has neither Node.js nor Docker nor a mounted Docker socket. Static editor diagnostics were available, but startup, Compose validation, authentication flows, Chromium rendering, persistence, network isolation, and the existing personal session could not be tested here. See [RAPPORT_FINAL.txt](RAPPORT_FINAL.txt) for the exact audit results and required host-side checks.
