#!/bin/bash
set -e
# Allow deployment.yaml to be the only uncommitted change (leftover from last push)
git diff --quiet -- ':!charts/web/templates/deployment.yaml' \
  && git diff --cached --quiet -- ':!charts/web/templates/deployment.yaml' \
  || { echo "Uncommitted changes — commit first"; exit 1; }

export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"
VERSION=$(git rev-parse --short HEAD)
sed -i '' -e "s|local/joey-agent:[a-zA-Z0-9._-]*|local/joey-agent:$VERSION|g" charts/web/templates/deployment.yaml
git add charts/web/templates/deployment.yaml
git diff --cached --quiet || git commit -m "Update deployment image tag to $VERSION"
docker build --load -t local/joey-agent:$VERSION .
docker save "local/joey-agent:$VERSION" | limactl shell "${LIMA_INSTANCE:-k3s}" -- sudo k3s ctr images import -
