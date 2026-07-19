#!/usr/bin/env bash
# Builds and pushes the 5 QFieldCloud images to ECR (RegistryStack repos).
# Run AFTER `cdk deploy QfcRegistry` and BEFORE deploying QfcApp.
# Usage: AWS_ACCOUNT_ID=123456789012 ./push-images.sh
set -euo pipefail

REGION="ap-northeast-1"
PREFIX="qfc"
PLATFORM="linux/amd64"   # matches CONFIG.cpuArchitecture=X86_64 (QGIS is amd64-only)
: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

build_push() {
  local name="$1" context="$2"; shift 2
  local image="${REGISTRY}/${PREFIX}-${name}:latest"
  echo "==> ${image}"
  docker build --platform "$PLATFORM" -t "$image" "$@" "$context"
  docker push "$image"
}

build_push app    "$ROOT/docker-app"   --target webserver_runtime
build_push worker "$ROOT/docker-app"   --target worker_wrapper_runtime
build_push nginx  "$ROOT/docker-nginx" --build-arg TEMPLATES_DIR=templates-fargate
build_push qgis3  "$ROOT/docker-qgis"  --build-arg UBUNTU_VERSION=noble --build-arg QGIS_REPOSITORY=ubuntu-ltr --build-arg "QGIS_VERSION=1:3.44.10+40noble"
build_push qgis4  "$ROOT/docker-qgis"  --build-arg UBUNTU_VERSION=resolute --build-arg QGIS_REPOSITORY=debian --build-arg "QGIS_VERSION=1:4.0.2+44resolute"

echo "All images pushed."
