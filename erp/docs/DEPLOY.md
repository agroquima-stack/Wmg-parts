# Publicar o GTX MOTO PARTS ERP (Firebase + Google Cloud + GitHub)

**Arquitetura:** o site (React) fica no **Firebase Hosting**; a API (Node) roda no **Cloud Run**; os dados ficam num **PostgreSQL** (Cloud SQL ou Neon/Supabase). O Hosting encaminha `/api/**` para a API, então site e API ficam no mesmo endereço (sem problema de CORS). O **Firestore não é usado**: o sistema é relacional (estoque, contabilidade e financeiro dependem de transações) e trocar de banco exigiria reescrever tudo.

> Eu (Claude) não consigo criar contas nem entrar no seu Google/Firebase. Os arquivos de publicação já estão no repositório; os passos abaixo são os que dependem de você.

## 1. O que você precisa criar (uma vez)
1. **Conta Google** da empresa (a que será dona do projeto).
2. **Projeto no Firebase** (console.firebase.google.com) — anote o *ID do projeto*.
3. **Plano Blaze** (pago conforme o uso) no projeto: o Cloud Run exige faturamento ligado. Em tráfego pequeno o custo costuma ser baixo, mas o **banco de dados** é o item fixo (veja o passo 4).
4. **Banco PostgreSQL** — escolha um:
   - **Neon** ou **Supabase** (têm plano gratuito/barato; copie a *connection string* com `?sslmode=require`); ou
   - **Cloud SQL for PostgreSQL** (mesmo Google; mais caro; exige configurar a conexão do Cloud Run).
5. No Google Cloud (mesmo projeto), ative as APIs: *Cloud Run*, *Cloud Build*, *Artifact Registry*, *Secret Manager*.
6. **Segredo da conexão:** no Secret Manager crie `gtx-erp-database-url` com a connection string do banco.
7. **Conta de serviço** para o GitHub publicar: IAM → Contas de serviço → nova, com os papéis *Cloud Run Admin*, *Service Account User*, *Cloud Build Editor*, *Artifact Registry Writer*, *Secret Manager Secret Accessor* e *Firebase Hosting Admin*. Gere a chave JSON.
   **Não cole essa chave em nenhum chat nem no código**: ela só entra como segredo do GitHub (passo 8).

## 2. GitHub
O código já está no repositório `agroquima-stack/wmg-parts` (pasta `erp/`, branch `claude/erp-motopeças-distribuidora-61ailh`). Quando estiver satisfeito, faça o merge para a branch principal.
- Workflow **ERP — testes** (`.github/workflows/erp-ci.yml`): roda sozinho a cada push (tipos, migrações, testes e build).
- Workflow **ERP — publicar (manual)** (`.github/workflows/erp-deploy.yml`): só roda quando você clica em *Actions → ERP — publicar → Run workflow*.

## 3. Variáveis e segredos no GitHub (Settings → Secrets and variables → Actions)
| Tipo | Nome | Valor |
|---|---|---|
| Secret | `GCP_SA_KEY` | conteúdo do JSON da conta de serviço |
| Variable | `GCP_PROJECT_ID` | ID do projeto (o mesmo do Firebase) |
| Variable | `PUBLIC_URL` | endereço final, ex.: `https://SEU-PROJETO.web.app` (ou seu domínio) |

Edite também `erp/.firebaserc` trocando `SEU-PROJETO-FIREBASE` pelo ID do projeto.

## 4. Primeira publicação
1. Rode o workflow *ERP — publicar*. Ele publica a API no Cloud Run (a API aplica as migrações do banco ao subir) e o site no Hosting.
2. **Crie a empresa e o administrador** (uma única vez, a partir de um computador com Node 22, apontando para o banco de produção):
   ```bash
   cd erp/api && npm ci
   DATABASE_URL='<connection string>' ADMIN_EMAIL=voce@empresa.com ADMIN_PASSWORD='uma-senha-provisoria-forte' COMPANY_NAME='GTX Moto Parts' \
     OPENING_BALANCE=22600.07 BANK_NAME='BTG Pactual' npm run bootstrap
   ```
   A troca de senha é obrigatória no primeiro acesso. **Nunca rode `seed:demo` em produção.**
3. Abra `https://SEU-PROJETO.web.app` e entre.

## 5. Depois
- **Domínio próprio:** Firebase → Hosting → Adicionar domínio personalizado (ex.: `erp.gtxmotoparts.com.br`); atualize a variável `PUBLIC_URL`.
- **Backup:** ligue o backup automático do provedor do banco (Neon/Supabase/Cloud SQL) e teste uma restauração. O sistema não faz backup sozinho.
- **Custos e limites:** `--max-instances 3` e memória de 512 Mi no workflow; ajuste se o uso crescer.
- **Monitoramento:** Cloud Run → Logs. Erros 500 aparecem lá.

## Como testar o que foi preparado (sem Google)
`docker build -t gtx-erp-api erp/api && docker run -p 8080:8080 -e DATABASE_URL=... gtx-erp-api` sobe a API; ela aceita chamadas com ou sem o prefixo `/api`.

## Limitações honestas
Estes arquivos de publicação **não foram executados contra uma conta Google real** (não tenho acesso a uma). Os testes do sistema e o build rodam; o primeiro deploy pode pedir ajustes de permissão (papéis da conta de serviço) ou de região.
