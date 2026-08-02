#!/bin/bash
set -e
git diff --quiet && git diff --cached --quiet || { echo "Uncommitted changes — commit first"; exit 1; }
VERSION=$(git rev-parse --short HEAD)
sed -i '' -e "s|local/joey-agent:[a-f0-9]*|local/joey-agent:$VERSION|g" charts/web/templates/deployment.yaml
docker build --load -t local/joey-agent:$VERSION .
docker save "local/joey-agent:$VERSION" | limactl shell "${LIMA_INSTANCE:-k3s}" -- sudo k3s ctr images import -
