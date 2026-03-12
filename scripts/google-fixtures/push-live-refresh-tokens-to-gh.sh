#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-dobutsustationery/admin}"
ENV_FILE="${ENV_FILE:-.env.live.local}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${E2E_GOOGLE_DRIVE_REFRESH_TOKEN:?Missing E2E_GOOGLE_DRIVE_REFRESH_TOKEN in $ENV_FILE}"
: "${E2E_GOOGLE_PHOTOS_REFRESH_TOKEN:?Missing E2E_GOOGLE_PHOTOS_REFRESH_TOKEN in $ENV_FILE}"

gh secret set E2E_GOOGLE_DRIVE_REFRESH_TOKEN --repo "$REPO" --body "$E2E_GOOGLE_DRIVE_REFRESH_TOKEN"
gh secret set E2E_GOOGLE_PHOTOS_REFRESH_TOKEN --repo "$REPO" --body "$E2E_GOOGLE_PHOTOS_REFRESH_TOKEN"

echo "Updated refresh token secrets on $REPO"
