#!/usr/bin/env bash
# Keeps the backend container (Chromium runs with --no-sandbox there) from opening new connections to private
# networks or to this host. It can still reach the public internet, which is what scanning needs.
#
# Idempotent: every rule carries the comment below and is removed before the set is added again.
# Docker's embedded DNS (127.0.0.11) lives inside the container's own network namespace, so it is not affected.
set -euo pipefail

BACKEND_IP="${BACKEND_IP:-172.30.240.10}"
TAG="wpa-lite-egress"
PRIVATE_RANGES=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8 224.0.0.0/4)

if [[ $EUID -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

remove_tagged() {
  local chain="$1" rule
  while rule="$(iptables -S "$chain" | grep -- "--comment $TAG" | head -n 1)" && [[ -n "$rule" ]]; do
    # shellcheck disable=SC2086 # the rule spec must be split into words
    iptables ${rule/-A /-D }
  done
}

if [[ "${1:-}" == "--remove" ]]; then
  remove_tagged DOCKER-USER
  remove_tagged INPUT
  echo "removed $TAG rules"
  exit 0
fi

if ! iptables -S DOCKER-USER >/dev/null 2>&1; then
  echo "DOCKER-USER chain missing; is Docker running?" >&2
  exit 1
fi

remove_tagged DOCKER-USER
remove_tagged INPUT

# Forwarded traffic (container -> other networks). Inserted in reverse so the final order is:
# allow replies, then drop new connections to each private range.
for ((i = ${#PRIVATE_RANGES[@]} - 1; i >= 0; i--)); do
  iptables -I DOCKER-USER 1 -s "$BACKEND_IP" -d "${PRIVATE_RANGES[$i]}" -m comment --comment "$TAG" -j DROP
done
iptables -I DOCKER-USER 1 -s "$BACKEND_IP" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$TAG" -j RETURN

# Traffic addressed to this host (gateway, public IP, any local address) goes through INPUT, not FORWARD.
# Placed first so it is evaluated before UFW's rules.
iptables -I INPUT 1 -s "$BACKEND_IP" -m conntrack --ctstate NEW -m comment --comment "$TAG" -j DROP

echo "applied $TAG rules for $BACKEND_IP"
iptables -S DOCKER-USER | grep -- "$TAG"
iptables -S INPUT | grep -- "$TAG"
