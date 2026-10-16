# Replayowl

Website: [replayowl.com](https://replayowl.com) · Source: [github.com/replayowl/replayowl](https://github.com/replayowl/replayowl)

Self-hosted session recording and replay for websites. A recorder of about 20 KB with zero runtime dependencies, replays that look exactly like what the visitor saw, search by user, page and behavior, and a dashboard protected by an admin password, OAuth 2.0 / OpenID Connect sign-in, or both.

This image runs the Node server: the collector endpoint, the dashboard and the recorder script. Session summaries are kept in Postgres; recordings are stored as files in `/data`, or in any S3-compatible storage when `S3_BUCKET` is set.

## Quick start

```bash
docker run -d --name replayowl -p 8790:8790 -v replayowl-data:/data \
  -e DATABASE_URL=postgres://user:pass@host:5432/replayowl \
  replayowl/replayowl:latest
```

Open http://127.0.0.1:8790/, set the admin password, then try the demo shop at http://127.0.0.1:8790/demo/ and replay the session in the dashboard. The tables are created on the first request.

## Docker Compose

```yaml
services:
  app:
    image: replayowl/replayowl:latest
    restart: unless-stopped
    ports:
      - "8790:8790"
    environment:
      DATABASE_URL: postgres://replayowl:replayowl@db:5432/replayowl
      SETUP_TOKEN: change-me
    volumes:
      - recordings:/data
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: replayowl
      POSTGRES_PASSWORD: replayowl
      POSTGRES_DB: replayowl
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U replayowl -d replayowl"]
      interval: 5s
      retries: 10
volumes:
  recordings:
  pgdata:
```

## Environment variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `PORT` | Listen port, default `8790` |
| `DATA_DIR` | Recording directory when S3 is not used, default `/data` |
| `SETUP_TOKEN` | Required to set the first admin password; recommended for any public instance |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `S3_PATH_STYLE` | S3-compatible storage (AWS S3, Cloudflare R2, MinIO, RustFS and so on); used when `S3_BUCKET` is set |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3 credentials |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_ISSUER`, `OAUTH_ALLOW` | OAuth / OpenID Connect sign-in, see the [documentation](https://github.com/replayowl/replayowl#oauth-sign-in) |

## Tags

- `latest`: the newest build of `main`
- `1.2.3`, `1.2`: releases
- `sha-<commit>`: a specific commit

Images are built for `linux/amd64` and `linux/arm64`. Full documentation: [README on GitHub](https://github.com/replayowl/replayowl#readme).

## License

[AGPL-3.0-only](https://github.com/replayowl/replayowl/blob/main/LICENSE). For commercial licensing, contact oss@replayowl.com.
