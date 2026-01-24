#!/bin/bash
# Deploy script for JustJeeps API

set -e

# Load secrets
if [ -f ".kamal/secrets" ]; then
    set -a
    source .kamal/secrets
    set +a
else
    echo "Error: .kamal/secrets file not found"
    exit 1
fi

# Check if already logged in to ghcr.io
if ! docker manifest inspect ghcr.io/ricardotassionunchi/justjeeps-api:latest > /dev/null 2>&1; then
    echo "Logging into GitHub Container Registry..."
    echo "$KAMAL_REGISTRY_PASSWORD" | docker login ghcr.io -u ricardotassionunchi --password-stdin
fi

# Deploy
echo "Starting deployment..."
kamal deploy

echo "Deployment complete!"
