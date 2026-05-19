#!/usr/bin/env bash
set -euo pipefail
curl -sS -m 300 -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://community-connector-agent.netlify.app/.netlify/functions/backfill-structured?reembedAll=1"
