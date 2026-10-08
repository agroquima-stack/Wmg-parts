# WMG ERP

ERP para distribuidora de motopeças. Arquitetura completa em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md). O `index.html` na raiz do repositório é o sistema anterior e não é alterado.

## Rodando localmente
Requer Node 22+ e PostgreSQL 16.
```bash
createdb wmg_erp                      # usuário/senha em api/.env.example
cd api && npm install && cp .env.example .env
npm run migrate && npm run seed:demo  # empresa de DEMONSTRAÇÃO (admin@demo.local / Demo@12345678)
npm start                             # API em :3000
cd ../web && npm install && npm run dev   # app em :5173 (proxy /api → :3000)
```
Produção: `ADMIN_EMAIL=… ADMIN_PASSWORD=… COMPANY_NAME=… npm run bootstrap` cria a empresa e o administrador (troca de senha obrigatória no 1º acesso). **Não rode `seed:demo` em produção.**

Testes: `cd api && npm test` (integração, exige Postgres com a demo).

## Estado
Fase 2 (Estoque) pronta: saldos por filial/status, entradas/saídas/ajustes, reserva, bloqueio, avaria, transferências, inventário geral/rotativo, histórico imutável, custo médio global, produtos parados e curva ABC.

Fase 1 (Core) pronta: login/sessões, multiempresa/multifilial, RBAC, auditoria, produtos (múltiplos EAN), aplicações em moto + busca "Pastilha CG 160 2020", equivalências, clientes (CPF/CNPJ validados), fornecedores, marcas/categorias, busca global.
Nada é simulado: todas as telas leem/escrevem no banco e respeitam permissões.
