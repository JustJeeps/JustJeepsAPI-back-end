#!/bin/sh

if [ "$#" -eq 0 ]; then
	set -- node server.js
fi

if [ "$1" = "node" ] && [ "${2:-}" = "server.js" ]; then
	echo "==> Executando migracoes do Prisma..."
	npx prisma migrate deploy || echo "AVISO: Migracoes falharam, continuando mesmo assim..."

	echo "==> Iniciando servidor..."
else
	echo "==> Executando comando: $*"
fi

exec "$@"
