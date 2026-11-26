# Security

## Controls in the application

- Passwords are hashed with Argon2id; authentication tokens are random and only their SHA-256 hashes are persisted.
- Authentication cookies are HttpOnly, Secure, SameSite=Lax, and scoped to `/`. Use HTTPS end to end through NPM.
- Mutating authenticated API calls require a session-bound CSRF token and same-origin validation.
- Login attempts are rate-limited in process. Authorization and browser-session ownership are checked on the server.
- SQL statements use SQLite prepared statements. Admin-rendered database values are HTML-escaped.
- Audit entries record security and administrative events; passwords, cookies, and authentication tokens must never be logged.
- The Compose file publishes no host ports. Browser containers are not attached to NPM's network.

## Deployment requirements

- Replace the example admin password before first startup. Restrict `.env` permissions and keep it out of source control.
- Keep `ALLOW_REGISTRATION=false` unless public signup is deliberately required.
- Terminate TLS at NPM and enable WebSocket proxying. Do not expose the gateway or Chromium container ports directly to the Internet.
- Back up SQLite and every profile volume before upgrades. Encrypt backups and restrict their access; Chromium profiles contain cookies and authenticated site data.
- Review and pin the Chromium image to a tested tag or digest. The current default uses `latest`, which is convenient but not reproducible.
- Monitor host memory and CPU before raising `MAX_SESSIONS`.

## Important residual risks

The gateway receives the host Docker socket. Docker access is effectively host-administrator access; a gateway compromise can create privileged workloads or access host resources. The current setup does not use a Docker socket authorization proxy.

Browser containers share the `chromiumcloud-browser` bridge. Their profile volumes are separate, but the network does not prevent one browser container from connecting to another container's reachable ports. Per-session networks or equivalent network policy are required before accepting hostile users.

The LinuxServer Chromium image, Compose deployment, and browser sandbox configuration could not be exercised in the available development environment. The existing session at `chrome.theoserver.duckdns.org` was not inspected. Do not claim that it has been preserved or mapped until the host-side container and volume have been verified.

The in-memory login limiter resets when the process restarts and does not coordinate across gateway replicas. The app is designed as a single-instance service until rate limiting and SQLite are moved to shared services.
