#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%Y%m%d_%H%M%S)
DEST="${BACKUP_DIR:-/home/theo7/backups/chromium-cloud}"
mkdir -p "$DEST"
# DB + gateway data
docker run --rm -v chromiumcloud_chromium-gateway-data:/data -v "$DEST":/backup alpine \
  sh -c "tar czf /backup/gateway-data-$STAMP.tar.gz -C /data ." 
# profiles
for v in $(docker volume ls --format '{{.Name}}' | grep '^chromiumcloud_profile_'); do
  uid=${v#chromiumcloud_profile_}
  docker run --rm -v "$v":/data -v "$DEST":/backup alpine \
    sh -c "tar czf /backup/profile-${uid}-$STAMP.tar.gz -C /data ."
done
# prune old backups keeping last 7 of each prefix? simple: keep all
echo "Backup completed: $DEST (*$STAMP*)"
