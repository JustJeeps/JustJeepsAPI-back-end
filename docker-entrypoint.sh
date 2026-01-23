#!/bin/sh

echo "==> Executando migracoes do Prisma..."
npx prisma migrate deploy || echo "AVISO: Migracoes falharam, continuando mesmo assim..."

echo "==> Iniciando servidor..."
exec node server.js
