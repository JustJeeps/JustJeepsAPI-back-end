# QuickBooks Customer Lookup — Atualização de Dados (Runbook)

A página **QuickBooks Customer Lookup** do pricing tool (triagem de fraude) é
servida pelo **PostgreSQL** (`QB_LOOKUP_SOURCE=db`), populado a partir de dois
exports manuais do **QuickBooks Desktop**. Dado velho degrada a triagem de
fraude silenciosamente ("nunca comprou" para cliente recorrente) — por isso há
monitoramento de idade com alerta.

> **PENDÊNCIA (definir com o time):** dono do export e cadência ainda não
> definidos. Sugestão da mesa redonda: export semanal. Até lá, o alerta de
> staleness (14/30 dias) é a rede de segurança.
>
> Desde 07/08/2026 a atualização é feita **pelo painel** (Settings → Imports),
> sem `scp` nem `docker exec`. O atrito do fluxo antigo é a razão de o dado ter
> ficado 21 dias parado depois do primeiro import.

## 1. Export no QuickBooks Desktop

Gerar dois relatórios em CSV, com **exatamente** estes nomes e colunas
(o loader casa por header; coluna renomeada = campo silenciosamente vazio):

| Arquivo | Colunas obrigatórias |
|---|---|
| `customers_qb_desktop.csv` | `Customer, Invoice to, Main Email, First Name, Last Name, Main Phone, Balance Total, Street1, Street2, City, Province, Postal Code, Country` |
| `transactions_per_customer.csv` | `Type, Date, Num, Name, Memo, Account, Debit, Credit` |

**Handoff seguro:** os arquivos contêm PII + histórico financeiro. Transferir
por canal seguro (drive compartilhado da empresa ou scp direto). **Nunca por
e-mail.**

## 2. Import em produção

### Caminho normal: painel (Settings → Imports)

1. Abrir **Settings → Imports** e achar **QuickBooks customer export (2 CSVs)**.
   O item só aparece para quem está em `FEEDS_TRIAGE_USERS`: os arquivos têm PII
   e histórico financeiro, então nem os metadados ficam visíveis para o resto.
2. **Upload** e arrastar o(s) arquivo(s). **Não precisa ter os dois**: o que não
   for enviado continua sendo o do lote atual, e o painel diz qual ficou e de
   quando. O navegador manda os bytes direto para o bucket em partes assinadas.
3. **Run now** roda o `seed-quickbooks-customers` no servidor e mostra o log ao
   vivo.

O arquivo fica versionado no bucket com hash, data e autor, e a idade do
snapshot passa a ser a data do upload (não o mtime, que seria a hora do
download).

### Alternativa: CLI (arquivo maior que o limite do painel, ou painel fora do ar)

```bash
# 1) Copiar os CSVs novos para o inbox no servidor (volume que sobrevive a deploys)
scp customers_qb_desktop.csv transactions_per_customer.csv \
  root@138.197.173.222:/var/lib/justjeeps-api/quickbooks-inbox/

# 2) Rodar o seeder dentro do container em produção
ssh root@138.197.173.222
CID=$(docker ps --filter "label=service=justjeeps-api" -q)
docker exec "$CID" npm run seed-quickbooks-customers
```

Ou, catalogando no bucket (mesmo efeito do painel, um arquivo por vez se for o caso):

```bash
docker exec "$CID" npm run feed-upload -- quickbooks /data/quickbooks-customers/customers_qb_desktop.csv
docker exec "$CID" npm run feed-sync -- quickbooks
docker exec "$CID" npm run seed-quickbooks-customers
```

O seeder é **atômico por snapshot** (`importId`): o snapshot anterior continua
sendo servido até o novo estar 100% inserido e validado — pode rodar em horário
comercial. Ele **aborta sozinho** se o export parecer truncado (menos de 70% da
contagem anterior — ajustável via `QB_IMPORT_MIN_RATIO`).

A idade do dado (`sourceExportedAt`) vem do **mtime** dos arquivos — se copiar
por um canal que reseta mtime, o valor fica como a data da cópia (aceitável).

## 3. Verificar sucesso

```bash
# No output do seeder: "Import #N completo: ~65k clientes."
# Via API (com token JWT):
curl -H "Authorization: Bearer <token>" \
  https://pricingtoolapi.justjeeps.com/api/quickbooks/customers/meta
# Esperado: customers ≈ 65k, errors: [], lastImportAt = agora, ageDays baixo
```

Spot-check na UI: buscar um cliente conhecido em
https://pricingtool.justjeeps.com/quickbooks-customer-lookup.

## 4. Monitoramento e alertas

- Cron diário `report-quickbooks-freshness` (09:15 Toronto) checa a idade do
  snapshot: **> 14 dias** = warning (log Axiom + e-mail com assunto
  `⚠️ ... (Warning)` e exit code 0), **> 30 dias** = crítico (log error Axiom +
  e-mail de falha). Até 07/08/2026 o warning ia como "Failed" com exit code 1,
  enquanto o log do próprio job registrava exit 0 — alarme falso diário.
- A idade também aparece **na própria tela** do lookup, em faixa amarela acima
  de 14 dias e vermelha acima de 30, porque dado velho responde "sem histórico"
  para cliente recorrente e isso é indistinguível de uma resposta correta.
- Thresholds: `QB_STALE_WARN_DAYS` / `QB_STALE_CRIT_DAYS` (deploy.yml).
- Ao receber o alerta: rodar o fluxo da seção 2 com um export novo.

## 5. Rollback / contingência

- **Seeder falhou no meio:** nada a fazer — o snapshot anterior continua no ar
  (import novo fica `pending` e é ignorado pelas leituras). Corrigir o CSV e
  rodar de novo.
- **Voltar para o modo CSV (legado):** mudar `QB_LOOKUP_SOURCE` para `"csv"`
  no `config/deploy.yml` e redeployar. O modo csv lê os arquivos do volume
  `/var/lib/justjeeps-api/quickbooks-inbox` (montado em
  `/data/quickbooks-customers`, resolvido via env `QB_LOOKUP_DATA_DIR`; em dev
  sem a env, o fallback é a pasta local `QuickBooks Project/customers`).
- **Restauração de dados:** o Postgres é o DigitalOcean Managed Database
  (backups automáticos do plano). O QuickBooks Desktop é o sistema de registro
  — sempre dá para re-exportar.

## Arquitetura (referência rápida)

- Endpoints: `GET /api/quickbooks/customers/search|details|meta` (server.js).
- Service: `services/quickbooksCustomerLookup.js` (ramifica csv/db pela env
  `QB_LOOKUP_SOURCE`); lógica pura em `services/quickbooksCustomerData.js`.
- Seeder: `prisma/seeds/seed-individual/seed-quickbooks-customers.js`
  (batches de 500, swap atômico, validação de contagem, cleanup).
- Tabelas: `QuickBooksCustomer` (snapshot denormalizado, stats pré-computadas)
  e `QuickBooksImport` (proveniência: importedAt, sourceExportedAt, contagens).
- Histórico do incidente que motivou isto: jul/2026 — CSVs só existiam na
  máquina de build de um colega; deploy de outra máquina shipou imagem sem
  dados e a página quebrou (500).
