#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-q3dweb}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Please install Docker first." >&2
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Stopping container: ${CONTAINER_NAME}"
  docker stop "${CONTAINER_NAME}" >/dev/null
  echo "Stopped: ${CONTAINER_NAME}"
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Container ${CONTAINER_NAME} exists but is not running."
  echo "Nothing to stop."
  exit 0
fi

echo "Container ${CONTAINER_NAME} not found."
