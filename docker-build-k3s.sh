#!/bin/bash
set -e

export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"
HEAD=$(git rev-parse --short HEAD)
DEPLOYED=$(grep -o 'local/joey-agent:[a-zA-Z0-9._-]*' charts/web/templates/deployment.yaml | head -1 | cut -d: -f2)
if [ "$HEAD" != "$DEPLOYED" ]; then
  VERSION=$HEAD
else
  VERSION=$(date +%s)
fi
sed -i '' -e "s|local/joey-agent:[a-zA-Z0-9._-]*|local/joey-agent:$VERSION|g" charts/web/templates/deployment.yaml
docker build --load -t local/joey-agent:$VERSION .
docker save "local/joey-agent:$VERSION" | limactl shell "${LIMA_INSTANCE:-k3s}" -- sudo k3s ctr images import -
