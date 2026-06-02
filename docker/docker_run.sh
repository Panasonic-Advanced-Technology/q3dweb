#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_NAME="${IMAGE_NAME:-q3dweb:local}"
CONTAINER_NAME="${CONTAINER_NAME:-q3dweb}"
HOST_PORT="${HOST_PORT:-4173}"
CONTAINER_PORT="4173"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Please install Docker first." >&2
  exit 1
fi

if [[ -z "$(docker images -q "${IMAGE_NAME}")" ]]; then
  echo "Image ${IMAGE_NAME} was not found. Run docker_build.sh first." >&2
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Removing existing container: ${CONTAINER_NAME}"
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

echo "Starting container ${CONTAINER_NAME} on 0.0.0.0:${HOST_PORT}"
docker run -d \
  --rm \
  --name "${CONTAINER_NAME}" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  "${IMAGE_NAME}" >/dev/null

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "${LAN_IP}" ]]; then
  echo "q3dweb is running."
  echo "Local:   http://localhost:${HOST_PORT}"
  echo "LAN:     http://${LAN_IP}:${HOST_PORT}"
else
  echo "q3dweb is running at http://localhost:${HOST_PORT}"
fi

echo "To stop: ./docker/docker_stop.sh or docker stop ${CONTAINER_NAME}"
