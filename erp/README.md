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
Fase 10 (Ecossistema) pronta em parte: marketplace sem integração (anúncios com margem real, pedidos, repasses) e WhatsApp por link (cobrança, lembrete, pedido); app do representante, loja online e WhatsApp integrado adiados. Fase 9 (Inteligência) pronta: central de alertas por regras (dentro do sistema), previsão de demanda, recomendações e "Pergunte à Empresa" sem IA externa (consultas fixas com origem do número). Fase 8 (BI) pronta: visão do dono (14 perguntas com origem), painéis comercial/estoque/compras/financeiro e metas editáveis em BI → Metas (estrutura pronta; ajuste os valores quando quiser). Fase 7 (Controladoria) pronta: razão de partidas dobradas imutável e balanceado, lançamentos automáticos de todas as operações, plano de contas configurável, DRE por competência (por filial, canal, categoria, marca, cliente e mês), balanço patrimonial, balancete, razão, centros de custo e verificações de consistência. Saldo inicial: `OPENING_BALANCE=22600.07` no bootstrap.

Fase 6 (Fiscal) pronta: documento fiscal (NF-e/NFC-e) com regras do Simples Nacional, validação, provedor intercambiável (manual e simulado), registro de nota emitida, cancelamento, CC-e, devolução, repositório de XMLs e painel do DAS (estimativa). Emissão com valor fiscal exige contratar um provedor.

Fase 5 (Financeiro) pronta: contas a receber/pagar com baixa parcial e juros/multa padrão de mercado, bancos e caixa opcional, importação de extrato CSV e conciliação, fluxo de caixa (realizado, previsto e projetado), comissões de representantes. Exemplos em `api/samples/`.

Fase 4 (Compras) pronta: sugestão automática de compra, cotações com comparação, pedidos (aprovação opcional), recebimento por XML de NF-e ou manual com conferência/divergências, custo médio global, contas a pagar (base), devolução ao fornecedor e comparação de fornecedores. NF-e de exemplo em `api/samples/`.

Fase 3 (Comercial) pronta: tabelas de preço, motor de precificação e simulador, PDV, vendas com reserva/baixa de estoque, orçamentos com link público de aprovação, alçada de desconto com aprovação do gestor (5% padrão), B2B (limite de crédito, painel do cliente, pedidos recorrentes), dashboard comercial.

Fase 2 (Estoque) pronta: saldos por filial/status, entradas/saídas/ajustes, reserva, bloqueio, avaria, transferências, inventário geral/rotativo, histórico imutável, custo médio global, produtos parados e curva ABC.

Fase 1 (Core) pronta: login/sessões, multiempresa/multifilial, RBAC, auditoria, produtos (múltiplos EAN), aplicações em moto + busca "Pastilha CG 160 2020", equivalências, clientes (CPF/CNPJ validados), fornecedores, marcas/categorias, busca global.
Nada é simulado: todas as telas leem/escrevem no banco e respeitam permissões.
