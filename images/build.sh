#!/usr/bin/env bash
# Builds a golden MoodlIA lab image: Moodle already installed on SQLite, REST
# enabled, the lab service and fixture courses created, and optionally the
# MoodlIA plugin installed. Secrets are created later by runtime.php.
#
# usage: images/build.sh <erseco-tag> <core|moodlia> <image-name> [plugin-dir]
#   e.g. images/build.sh v4.5.12 moodlia ghcr.io/gafapa/moodlia-lab:4.5-moodlia ../plugin
set -euo pipefail

moodle_tag="$1"
variant="$2"
image="$3"
plugin_dir="${4:-}"
base="erseco/alpine-moodle:${moodle_tag}"
here="$(cd "$(dirname "$0")" && pwd)"
container="moodlia-lab-build-$$"

if [[ "$variant" != core && "$variant" != moodlia ]]; then
  echo "variant must be core or moodlia" >&2
  exit 2
fi
if [[ "$variant" == moodlia && ! -f "$plugin_dir/version.php" ]]; then
  echo "the moodlia variant needs the plugin directory" >&2
  exit 2
fi

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The build-time password is replaced by runtime.php on every start. The base
# image passes MOODLE_SITENAME to the installer unquoted, so it has no spaces.
docker run -d --name "$container" ${BUILD_MEMORY:+--memory "$BUILD_MEMORY"} \
  -e DB_TYPE=sqlite3 -e MOODLE_DATABASE_TYPE=sqlite3 \
  -e SITE_URL=http://127.0.0.1:8080 -e REVERSEPROXY=true -e AUTO_UPDATE_MOODLE=true \
  -e MOODLE_USERNAME=admin -e "MOODLE_PASSWORD=build-$(openssl rand -hex 16)" \
  -e MOODLE_EMAIL=lab@example.invalid -e "MOODLE_SITENAME=MoodlIA-lab-${moodle_tag}-${variant}" \
  -e MOODLE_LANGUAGE=en \
  "$base" >/dev/null

health() { docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo none; }
echo "Waiting for Moodle ${moodle_tag} to install..."
for _ in $(seq 1 180); do
  [[ "$(health)" == healthy ]] && break
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != true ]]; then
    docker logs --tail 80 "$container" >&2
    echo "Moodle stopped during installation" >&2
    exit 1
  fi
  sleep 5
done
if [[ "$(health)" != healthy ]]; then
  docker logs --tail 80 "$container" >&2
  echo "Moodle did not become healthy" >&2
  exit 1
fi

# Moodle 5.1+ serves from public/, but plugins still live under the code root.
if docker exec "$container" test -d /var/www/html/public; then
  local_dir=/var/www/html/public/local
else
  local_dir=/var/www/html/local
fi

if [[ "$variant" == moodlia ]]; then
  docker exec -u root "$container" mkdir -p "$local_dir/moodlia"
  tar -C "$plugin_dir" --exclude=.git --exclude=node_modules --exclude=tests --exclude=tools -cf - . \
    | docker exec -i -u root "$container" tar -C "$local_dir/moodlia" -xf -
  docker exec -u root "$container" chown -R nobody: "$local_dir/moodlia"
  docker exec "$container" php /var/www/html/admin/cli/upgrade.php --non-interactive --allow-unstable
fi

docker cp "$here/fixture.php" "$container:/tmp/moodlia-lab-fixture.php"
docker exec "$container" php /tmp/moodlia-lab-fixture.php "$variant"
docker exec -u root "$container" mkdir -p /opt/moodlia-lab
docker cp "$here/runtime.php" "$container:/opt/moodlia-lab/runtime.php"
docker exec -u root "$container" rm -f /tmp/moodlia-lab-fixture.php

docker stop "$container" >/dev/null
docker commit \
  --change 'LABEL moodlia-lab=true' \
  --change "LABEL org.opencontainers.image.description=MoodlIA lab ${moodle_tag} ${variant}" \
  --change 'LABEL org.opencontainers.image.source=https://github.com/gafapa/moodlia-test-lab' \
  "$container" "$image" >/dev/null
echo "Built $image"
