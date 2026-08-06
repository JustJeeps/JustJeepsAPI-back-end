#!/bin/sh

if [ "$#" -eq 0 ]; then
	set -- node server.js
fi

if [ "$1" = "node" ] && [ "${2:-}" = "server.js" ]; then
	echo "==> Running Prisma migrations..."
	npx prisma migrate deploy || echo "WARNING: Migrations failed, continuing anyway..."

	echo "==> Starting server..."
else
	echo "==> Running command: $*"
fi

exec "$@"
