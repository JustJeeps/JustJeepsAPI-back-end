# Deploy JustJeeps com Kamal na Digital Ocean

Este guia detalha o processo completo de deploy do backend Node.js usando Kamal e do frontend React como Static Site.

## Arquitetura do Deploy

```
┌─────────────────────────────────────────────────────────────────┐
│                      DIGITAL OCEAN                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐    ┌────────────────────────────────┐ │
│  │   App Platform       │    │        Droplet                 │ │
│  │   (Static Site)      │    │                                │ │
│  │                      │    │  ┌──────────────┐              │ │
│  │  ┌────────────────┐  │    │  │   Traefik    │ :443/:80     │ │
│  │  │   Frontend     │──┼────┼──│   (SSL/TLS)  │              │ │
│  │  │   React/Vite   │  │    │  └──────┬───────┘              │ │
│  │  │   (CDN)        │  │    │         │                      │ │
│  │  └────────────────┘  │    │  ┌──────▼───────┐              │ │
│  │                      │    │  │  JustJeeps   │              │ │
│  └──────────────────────┘    │  │  API         │ :8080        │ │
│                              │  │  (Node.js)   │              │ │
│  ┌──────────────────────┐    │  └──────┬───────┘              │ │
│  │  Managed PostgreSQL  │    │         │                      │ │
│  │                      │◄───┼─────────┘                      │ │
│  │  (SSL obrigatorio)   │    │                                │ │
│  └──────────────────────┘    └────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Pre-requisitos

### 1. Instalar Kamal (local)

```bash
# macOS/Linux
gem install kamal

# Verificar instalacao
kamal version
```

### 2. Criar recursos na Digital Ocean

1. **Droplet** (Backend):
   - Ubuntu 22.04 ou 24.04
   - Minimo: 2GB RAM / 1 vCPU ($12/mes)
   - Recomendado: 4GB RAM / 2 vCPU ($24/mes)
   - Habilitar IPv4
   - Adicionar sua SSH key

2. **Managed PostgreSQL** (Banco):
   - Development ($15/mes) ou Production
   - Anotar Connection String

3. **App Platform** ou **Spaces** (Frontend):
   - Sera configurado depois do backend

---

## Parte 1: Deploy do Backend com Kamal

### Passo 1: Configurar variaveis de ambiente

Crie o arquivo `.env.production` a partir do template:

```bash
cp .env.production.example .env.production
```

Edite com seus valores reais:

```bash
# .env.production
DATABASE_URL=postgresql://doadmin:SENHA@db-postgresql-xxx.ondigitalocean.com:25060/defaultdb?sslmode=require
JWT_SECRET=gerar_com_node_crypto
MAGENTO_KEY=sua_chave
KAMAL_REGISTRY_USERNAME=seu_usuario
KAMAL_REGISTRY_PASSWORD=seu_token
```

### Passo 2: Editar config/deploy.yml

Substitua os placeholders:

```yaml
# config/deploy.yml

service: justjeeps-api

image: SEU_USUARIO/justjeeps-api  # ex: johndoe/justjeeps-api

servers:
  web:
    hosts:
      - SEU_IP_DO_DROPLET  # ex: 143.198.123.45
    labels:
      traefik.http.routers.justjeeps-api.rule: Host(`pricingtoolapi.justjeeps.com`)
      # ... resto das labels

# Kamal 2.x: o TLS e resolvido pelo bloco `proxy:` do config/deploy.yml
# (nao existe mais a secao `traefik:` do Kamal 1.x). Ajuste `proxy.host`
# e os labels dos hosts no proprio deploy.yml.
```

### Passo 3: Carregar segredos

```bash
# Exportar variaveis do .env.production (set -a exporta tudo; um `source`
# simples NAO exporta e o hook pre-build aborta o deploy; `export $(cat ...)`
# quebra com valores contendo espacos)
set -a; source .env.production; set +a
```

O hook `.kamal/hooks/pre-build` valida os segredos ANTES do build: qualquer
variavel referenciada como `$VAR` no `.kamal/secrets` que resolver vazia
aborta o deploy (exceto as da lista OPTIONAL do proprio hook). O
`.env.production.example` nao cobre todos os segredos obrigatorios — se o
hook abortar, ele imprime exatamente o que falta.

Ou use um gerenciador de segredos:

```bash
# 1Password CLI
op run --env-file=.env.production -- kamal setup
```

### Passo 4: Setup inicial do servidor

```bash
# Prepara o servidor (instala Docker, configura SSH, etc)
kamal server bootstrap

# Primeira instalacao completa
kamal setup
```

Este comando:
1. Conecta via SSH no Droplet
2. Instala Docker no servidor
3. Configura o kamal-proxy (proxy reverso do Kamal 2.x)
4. Executa o hook pre-build (validacao de segredos — aborta se faltar algo)
5. Faz build da imagem Docker e envia para o registry
6. Inicia o container; as migracoes Prisma rodam no docker-entrypoint.sh
   (`npx prisma migrate deploy`) na subida do container

### Passo 5: Deploys subsequentes

```bash
# Deploy normal
kamal deploy

# Deploy com rebuild forcado
kamal deploy --force

# Ver logs
kamal app logs -f

# Acessar console do container
kamal app exec -i -- node

# Executar comando especifico
kamal app exec -- npx prisma studio
```

---

## Parte 2: Injecao Segura de DATABASE_URL

### Opcao A: Variaveis de ambiente locais (Desenvolvimento)

```bash
# Terminal
export DATABASE_URL="postgresql://..."
export JWT_SECRET="..."
kamal deploy
```

### Opcao B: Arquivo .env com Kamal secrets (Recomendado)

O arquivo `.kamal/secrets` define como carregar os segredos:

```bash
# .kamal/secrets
DATABASE_URL=$DATABASE_URL
JWT_SECRET=$JWT_SECRET
```

Execute:
```bash
# Carrega do .env.production e executa (set -a exporta com espacos seguros)
set -a; source .env.production; set +a
kamal deploy
```

### Opcao C: 1Password CLI (Producao)

Instale a CLI do 1Password e configure:

```bash
# .kamal/secrets
DATABASE_URL=$(op read "op://Vault/JustJeeps/DATABASE_URL")
JWT_SECRET=$(op read "op://Vault/JustJeeps/JWT_SECRET")
```

Execute:
```bash
kamal deploy
```

### Opcao D: Direto no deploy.yml (NAO RECOMENDADO)

Apenas para testes, nunca em producao:

```yaml
env:
  clear:
    DATABASE_URL: "postgresql://..."  # NUNCA FACA ISSO!
```

---

## Parte 3: Script de Importacao Local -> Banco de Producao

Para rodar scripts locais que acessam o banco da DO com seguranca:

### Configuracao

1. **No painel da Digital Ocean:**
   - Va em Database > Settings > Trusted Sources
   - Adicione seu IP publico (ou "Allow All" temporariamente)

2. **Baixe o certificado CA:**
   - Database > Connection Details > Download CA Certificate
   - Salve como `ca-certificate.crt`

3. **Configure a connection string:**

```bash
# .env.local-to-production
DATABASE_URL="postgresql://doadmin:SENHA@HOST:25060/defaultdb?sslmode=require&sslrootcert=./ca-certificate.crt"
```

### Executando scripts de seed

```bash
# Carrega env e executa
export $(cat .env.local-to-production | xargs)

# Roda o seed desejado
npm run seed-hard-code
npm run seed-all
```

### Seguranca adicional

1. **Use IP Allowlist:** Remova "Allow All" apos importacao
2. **Use usuario read-only:** Crie um usuario com permissoes limitadas
3. **VPN:** Configure uma VPN entre sua maquina e a DO
4. **SSH Tunnel:**

```bash
# Abre tunel SSH atraves do Droplet
ssh -L 5432:db-postgresql-xxx.ondigitalocean.com:25060 root@SEU_DROPLET_IP

# Em outro terminal, use localhost
DATABASE_URL="postgresql://doadmin:SENHA@localhost:5432/defaultdb?sslmode=require"
npm run seed-all
```

---

## Parte 4: Deploy do Frontend (Static Site)

### Opcao A: Digital Ocean App Platform

1. Va em App Platform > Create App
2. Conecte seu repositorio GitHub/GitLab
3. Configure:
   - **Type:** Static Site
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Environment Variables:**
     ```
     VITE_API_URL=https://pricingtoolapi.justjeeps.com
     ```

4. Deploy automatico em cada push

### Opcao B: Digital Ocean Spaces + CDN

1. Crie um Space (Object Storage)
2. Habilite CDN
3. Configure CORS para permitir seu dominio
4. Build e upload:

```bash
# No diretorio do frontend
VITE_API_URL=https://pricingtoolapi.justjeeps.com npm run build

# Upload para Spaces (use s3cmd ou doctl)
s3cmd sync ./dist/ s3://seu-space-name/ --acl-public
```

### Script de build do Frontend

Adicione ao `package.json` do frontend:

```json
{
  "scripts": {
    "build:production": "VITE_API_URL=https://pricingtoolapi.justjeeps.com vite build",
    "build:staging": "VITE_API_URL=https://api-staging.seudominio.com vite build"
  }
}
```

### Configuracao CORS no Backend

Atualize o CORS no `server.js`:

```javascript
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://justjeeps.com",
      "https://www.justjeeps.com",
      // Adicione outros dominios conforme necessario
    ],
    credentials: true,
  })
);
```

---

## Comandos Kamal Uteis

```bash
# Status dos containers
kamal app details

# Ver logs em tempo real
kamal app logs -f

# Reiniciar aplicacao
kamal app boot

# Parar aplicacao
kamal app stop

# Executar comando no container
kamal app exec -- npm run seed-hard-code

# Acessar shell do container
kamal app exec -i -- /bin/bash

# Executar migracoes manualmente
kamal app exec -- npx prisma migrate deploy

# Rollback para versao anterior
kamal rollback

# Atualizar Traefik
kamal proxy reboot

# Ver configuracao atual
kamal config
```

---

## Troubleshooting

### Erro: "Connection refused" no health check

1. Verifique se a porta 8080 esta correta
2. Teste localmente: `curl http://localhost:8080/api/health`
3. Verifique logs: `kamal app logs`

### Erro: "Database connection failed"

1. Verifique DATABASE_URL
2. Confirme que `?sslmode=require` esta na URL
3. Verifique Trusted Sources no painel da DO
4. Teste conexao: `kamal app exec -- npx prisma db pull`

### Erro: "Permission denied" no hook pre-build

```bash
chmod +x .kamal/hooks/pre-build
git add .kamal/hooks/pre-build
git commit -m "Fix hook permissions"
```

### Imagem muito grande

1. Verifique `.dockerignore`
2. Use multi-stage build
3. Remova node_modules de desenvolvimento

### SSL nao funciona

1. Verifique se o dominio aponta para o IP do Droplet
2. Verifique email no Let's Encrypt config
3. Aguarde propagacao DNS (ate 48h)
4. Verifique logs do proxy: `kamal proxy logs` (Kamal 2.x)

---

## Checklist de Deploy

- [ ] Droplet criado e SSH funcionando
- [ ] Managed PostgreSQL criado
- [ ] Connection string copiada
- [ ] `config/deploy.yml` configurado
- [ ] `.env.production` criado (NAO commitado)
- [ ] Dockerfile.production testado localmente
- [ ] Hook pre-build com permissao de execucao
- [ ] Endpoint `/api/health` funcionando
- [ ] CORS configurado para dominio de producao (origens reais em server.js:
      pricingtool.justjeeps.com + localhost:5173)
- [ ] DNS configurado (producao real: pricingtoolapi.justjeeps.com para a API,
      pricingtool.justjeeps.com para o front)
- [ ] `kamal setup` executado com sucesso
- [ ] Frontend apontando para URL correta
- [ ] Frontend deployado (App Platform ou Spaces)
