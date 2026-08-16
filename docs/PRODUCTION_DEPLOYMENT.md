# Production deployment and rollback

This runbook targets one Ubuntu 24.04 LTS VDS with 10 vCPU, 12 GB RAM and
200 GB NVMe. It keeps customer analysis concurrency at one while allowing the
queue to hold multiple jobs. Commands below are operator commands; they have
not been executed against a production host by this repository change.

The Docker installation follows the current [official Ubuntu
instructions](https://docs.docker.com/engine/install/ubuntu/). Docker-published
ports can bypass uncomplicated host-firewall rules, so the release publishes
only the frontend on `127.0.0.1`; enforce public ingress and outbound deny rules
in the host/provider firewall and Docker `DOCKER-USER` chain as well.

## 1. Host and Docker

Run as a sudo-capable deployment operator. Replace `DEPLOY_USER`, the domain,
repository URL and release commit with reviewed values.

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git age nginx certbot python3-certbot-nginx openssl

for pkg in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
  sudo apt-get remove -y "$pkg" 2>/dev/null || true
done

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/ubuntu' \
  "Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}" \
  'Components: stable' \
  "Architectures: $(dpkg --print-architecture)" \
  'Signed-By: /etc/apt/keyrings/docker.asc' \
  | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker nginx
sudo docker version
sudo docker compose version
```

Do not depend on membership in the `docker` group unless the operator accepts
that it grants root-equivalent access. The commands below therefore use
`sudo docker`.

## 2. Release checkout

Never deploy a moving branch. Replace `RELEASE_COMMIT` with the reviewed commit
SHA that contains this launch package.

```sh
sudo install -d -m 0750 -o DEPLOY_USER -g DEPLOY_USER /srv/webpage-analyzer
sudo -u DEPLOY_USER git clone https://github.com/onuracar-dev/WebPageAnalyz.git /srv/webpage-analyzer/app
cd /srv/webpage-analyzer/app
sudo -u DEPLOY_USER git fetch --tags --prune origin
sudo -u DEPLOY_USER git checkout --detach RELEASE_COMMIT
git status --short
```

The final `git status --short` must be empty. Do not reconstruct a release from
an uncommitted workstation checkout.

## 3. Environment and PostgreSQL TLS

Create the production environment outside Git and fill every required entry in
`docs/PRODUCTION_ENVIRONMENT.md`.

```sh
cd /srv/webpage-analyzer/app
sudo install -m 0600 -o DEPLOY_USER -g DEPLOY_USER .env.example .env
sudo -u DEPLOY_USER editor .env
```

Generate a private CA and a server certificate for the internal Compose DNS
name `postgres`. Keep the CA private key offline after signing; the database
container receives only the server key and public certificates.

```sh
sudo install -d -m 0700 /srv/webpage-analyzer/secrets/postgres-tls
cd /srv/webpage-analyzer/secrets/postgres-tls
sudo openssl genrsa -out ca.key 4096
sudo openssl req -x509 -new -sha256 -days 3650 -key ca.key -out ca.crt -subj '/CN=WebPageAnalyzer PostgreSQL CA'
sudo openssl genrsa -out server.key 4096
sudo openssl req -new -sha256 -key server.key -out server.csr -subj '/CN=postgres'
printf '%s\n' 'subjectAltName=DNS:postgres' 'extendedKeyUsage=serverAuth' | sudo tee server.ext >/dev/null
sudo openssl x509 -req -sha256 -days 825 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -extfile server.ext
sudo chown 70:70 server.key server.crt ca.crt
sudo chmod 0600 server.key
sudo chmod 0644 server.crt ca.crt
sudo install -d -m 0700 /srv/webpage-analyzer/offline-secrets
sudo mv ca.key /srv/webpage-analyzer/offline-secrets/postgres-ca.key
sudo rm -f server.csr server.ext ca.srl
```

Set this exact path in `.env`:

```text
POSTGRES_TLS_DIR=/srv/webpage-analyzer/secrets/postgres-tls
```

## 4. DNS and HTTPS

Point the chosen hostname at the VDS. If Cloudflare is used, do not enable its
proxy until the origin certificate and direct-origin test pass. Replace every
`app.example.com` occurrence in the checked-in example before installing it.

```sh
cd /srv/webpage-analyzer/app
sudo systemctl stop nginx
sudo certbot certonly --standalone -d app.your-domain.example
sed 's/app\.example\.com/app.your-domain.example/g' infra/nginx/webpageanalyz.conf.example \
  | sudo tee /etc/nginx/sites-available/webpageanalyz.conf >/dev/null
sudo ln -sfn /etc/nginx/sites-available/webpageanalyz.conf /etc/nginx/sites-enabled/webpageanalyz.conf
sudo nginx -t
sudo systemctl start nginx
sudo certbot renew --dry-run
```

Permit only operator SSH plus HTTP/HTTPS ingress at the VDS firewall. PostgreSQL,
backend, worker, AI and email ports must not be public. Add provider/firewall
egress rules that deny cloud metadata and private/link-local destinations and
allow only the explicitly documented provider traffic needed by each egress
network.

## 5. Validate, migrate and start

The production overlay enables certificate-verified PostgreSQL connections.
It is mandatory for this single-VDS topology.

```sh
cd /srv/webpage-analyzer/app
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml config --quiet
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml pull
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml build --pull
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml up -d postgres
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml run --rm db-bootstrap
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml run --rm db-migrate
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml run --rm db-grants
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml up -d --remove-orphans
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml ps
```

The one-shot migration is checksum-locked and repeatable. For an upgrade, take
and restore-check an encrypted pre-migration backup before running it:

```sh
cd /srv/webpage-analyzer/app
export BACKUP_AGE_RECIPIENT='age1REPLACE_WITH_OPERATOR_RECIPIENT'
sudo --preserve-env=BACKUP_AGE_RECIPIENT ./infra/backup/backup-postgres.sh /srv/webpage-analyzer/backups
sudo --preserve-env=BACKUP_AGE_RECIPIENT ./infra/backup/restore-check-postgres.sh /srv/webpage-analyzer/backups/REPLACE_WITH_BACKUP.dump.age
```

## 6. Health and first verification

```sh
curl --fail --silent --show-error https://app.your-domain.example/healthz
curl --fail --silent --show-error https://app.your-domain.example/readyz
curl --fail --silent --show-error https://app.your-domain.example/api/v1/status
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml ps
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml logs --since=10m --no-color
```

`/healthz` is the public uptime-monitor target. `/readyz` is the deployment
readiness probe. Neither may disclose database URIs, provider keys, stack
traces or customer data. Complete the ordered live smoke checklist in
`docs/LAUNCH_ACCEPTANCE_REPORT.md`; provider, payment, email and deployment
steps remain unproven until the operator supplies accounts and authorizes the
live/sandbox exercise.

## 7. Rollback

Before every upgrade record the prior release SHA and encrypted backup path.
If the new application fails before a schema migration, check out the prior SHA,
rebuild and start it:

```sh
cd /srv/webpage-analyzer/app
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml stop frontend backend analysis-worker maintenance-worker ai-service email-service
sudo -u DEPLOY_USER git checkout --detach PREVIOUS_RELEASE_COMMIT
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml build
sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.production.yml up -d
curl --fail --silent --show-error https://app.your-domain.example/readyz
```

If migrations ran, first execute `restore-check-postgres.sh` against the exact
pre-migration backup. Do not drop or overwrite production data automatically.
The operator must inspect migration compatibility and explicitly approve either
forward repair or a maintenance-window database restore. Record the backup
checksum, release SHAs, migration ledger and smoke results in the incident log.

## 8. Routine operations

- Schedule encrypted daily backups and off-VDS replication; run a disposable
  restore check after schema changes and at least monthly.
- Alert on public health failure, container restart loops, queue depth, failed
  jobs, disk usage, memory pressure, database health, provider errors and backup
  age.
- Keep `MAX_CONCURRENT_ANALYSES=1` for this launch VDS. Change it only after a
  measured capacity review.
- Rotate provider, auth, database and internal service tokens independently;
  restart only the services listed in the environment matrix.

## 9. Optional privileged-access edge layer

The application does not use a secret admin URL. `/admin` remains protected by Better Auth, verified email, TOTP, WebAuthn policy, server-side permissions and risk-based step-up.

An optional `admin.example.com` deployment may be placed behind Cloudflare Access or an equivalent identity-aware proxy as defense in depth. Apply the outer policy to the admin HTML, `/api/v1/admin/*`, and the Better Auth/passkey flows required by that origin; protecting only the page while leaving its APIs public is not an effective edge boundary. Do not trust arbitrary client-supplied identity headers. Any future provider JWT/header integration must be explicitly enabled and cryptographically verified.

Application authorization remains mandatory when the edge proxy is absent, unavailable or misconfigured. See `PRIVILEGED_ACCESS_SECURITY_REPORT.md` for enrollment and production proof steps.
