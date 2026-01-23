#!/bin/sh
set -e

echo "==> Executando migracoes do Prisma..."
npx prisma migrate deploy

echo "==> Iniciando servidor..."
exec node server.js
