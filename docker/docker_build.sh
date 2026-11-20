#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_NAME="${IMAGE_NAME:-q3dweb:local}"
DOCKERFILE_PATH="${PROJECT_ROOT}/docker/Dockerfile"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Please install Docker first." >&2
  exit 1
fi

echo "Building image: ${IMAGE_NAME}"
docker build -f "${DOCKERFILE_PATH}" -t "${IMAGE_NAME}" "${PROJECT_ROOT}"

echo "Done. Built ${IMAGE_NAME}"
