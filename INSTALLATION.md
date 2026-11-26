# Installation

## Host audit and preservation

Do not start this Compose project until the host's existing Chromium container and profile volume have been identified and backed up. Run these read-only inventory commands on the Ubuntu Docker host:

```sh
docker ps -a --no-trunc
docker network ls
docker volume ls
docker inspect <existing-chromium-container>
```

Inspect the container's mounts and reverse-proxy labels, then take a separate backup of its profile volume. Do not remove, recreate, rename, or mount that profile into a new account until its ownership and current contents are confirmed. The existing browser at `chrome.theoserver.duckdns.org` was not inspectable from the development environment used for this implementation.

The app currently names managed containers `chromium-u-<user-id>` and profile volumes `chromiumcloud_profile_<user-id>`. Its SQLite database assigns each account a stable browser-session UUID. A pre-existing profile is preserved only if the host operator deliberately maps the verified profile volume to the correct account; no automatic mapping is safe without the host inventory.

## Prerequisites

- Docker Engine and Docker Compose plugin on the Ubuntu host.
- The pre-existing external network `nginx-proxy-manager_default`.
- A working TLS reverse proxy and DNS records managed separately.
- Adequate host capacity. Each browser container is capped at 1.2 GiB RAM and 0.5 CPU; the default maximum is 11 concurrent containers.

Check that the NPM network exists before deployment:

```sh
docker network inspect nginx-proxy-manager_default
```

The Compose file will create a project network named `chromiumcloud-browser`. It does not publish ports on the host and does not change NPM or any other container.

## Configure and start

```sh
cp .env.example .env
```

Edit `.env` and set a unique administrator password (at least 24 random characters is recommended). Keep the file readable only by the deployment operator. Registration is disabled by default. The first startup creates the admin account only if the database contains no users; changing bootstrap credentials later does not reset an existing account.

Start the gateway:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 chromium-gateway
```

The gateway listens on port `3000` inside Docker. Chromium containers also listen on `3000` inside the browser network. Neither port is published to the host. Session containers are created dynamically when a user first signs in or opens their browser.

## Nginx Proxy Manager

Create or verify the Proxy Host entries manually; this project never edits NPM configuration:

- `chromium.theoserver.duckdns.org` -> `http://chromium-gateway:3000`
- Enable WebSocket support for the ChromiumCloud host.
- Attach NPM's existing `nginx-proxy-manager_default` network to the gateway (Compose already attaches the gateway to that external network).
- Configure a valid TLS certificate and force HTTPS. Authentication cookies are `Secure` and will not be sent over plain HTTP.

Do not point `chrome.theoserver.duckdns.org` at ChromiumCloud unless the existing personal browser has been independently backed up and you explicitly intend to change its routing. No Proxy Host changes are made automatically. An `admin.` hostname is optional; the application already protects `/admin` by role.

## Users and sessions

The bootstrap administrator can create accounts in `/admin`. Self-registration is disabled unless `ALLOW_REGISTRATION=true` is explicitly configured. Each account receives one browser-session UUID and one persistent profile volume. The UUID in `/session/:uuid` is checked against the authenticated account on the server; knowing another user's UUID is insufficient.

Stopping or restarting a browser container does not delete its named profile volume. Deleting a user removes the Docker container but does not currently delete the persistent profile volume. Treat volume cleanup as a separate, explicitly confirmed data-destruction task.

## Backups and restore

Back up both the SQLite volume (`chromiumcloud_chromium-gateway-data` under the default Compose project name) and each `chromiumcloud_profile_<user-id>` volume. The project script can archive volumes:

```sh
BACKUP_DIR=/path/on/backup-storage ./scripts/backup.sh
```

The script creates temporary Alpine helper containers and requires Docker access. Store backups encrypted and outside the project directory. Verify the actual volume names with `docker volume ls`; a Compose project name override changes the database volume's prefix.

For restoration, stop only this project's gateway and affected browser containers, make a copy of the current target volumes, then restore each archive into its corresponding named volume. Confirm ownership and volume names before running any restore command. Start the project again and check account-to-profile mapping. No restore was performed as part of this implementation.

## Troubleshooting

- Compose cannot find the NPM network: verify the exact external network name; do not create or rename NPM's network from this project.
- Browser shows a gateway error: check gateway logs, image pull status, browser container state, and that both gateway and browser containers share `chromiumcloud-browser`.
- Login cookie is missing: access through HTTPS and verify the proxy forwards the original host and scheme.
- Browser session starts blank: stop and inspect the mapped profile volume before making changes; do not reset or delete the volume.
- Health endpoint: `GET /health` on the gateway reports process status and configured session capacity.
