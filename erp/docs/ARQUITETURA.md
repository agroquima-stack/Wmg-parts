# WMG ERP — Arquitetura (primeira entrega)

> Escopo: ERP + gestão + BI + pricing + IA para distribuidora de motopeças, multiempresa/multifilial.
> Estado: **Fases 1 a 7 implementadas (Core, Estoque, Comercial, Compras, Financeiro, Fiscal e Controladoria)**. As demais fases estão especificadas aqui e entram em migrações incrementais.

## 1. Arquitetura geral

Monólito modular (um deploy, módulos com fronteiras claras) — o ponto certo entre simplicidade e escala para o porte inicial, com caminho para extrair serviços (fiscal, integrações, IA) depois.

```
 Navegador (SPA React) ──HTTPS──▶ API REST (Fastify) ──▶ PostgreSQL
                                     │  ├─ auth/sessões   ├─ dados de todas as empresas (company_id)
                                     │  ├─ RBAC           └─ audit_log (append-only)
                                     │  ├─ módulos de domínio (catálogo, estoque, comercial…)
                                     │  └─ outbox de eventos ──▶ workers (fiscal, WhatsApp, marketplaces, IA)  [fases futuras]
```

Princípios: (1) **uma transação por operação de negócio** — dado + movimento de estoque + financeiro + auditoria juntos; (2) **nada duplicado** — a venda gera o resto por regra, o usuário não relança; (3) **integrações desacopladas** por interface/adapters e outbox, nunca chamadas síncronas dentro da transação de negócio.

## 2. Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Banco | PostgreSQL 16 | relacional robusto, NUMERIC exato p/ dinheiro, JSONB p/ auditoria, `pg_trgm`/`unaccent` p/ busca rápida |
| API | Node 22 + TypeScript + Fastify | rápido, tipado; `zod` valida toda entrada |
| Front | React + Vite + TypeScript | SPA desktop-first, responsiva |
| Auth | token de sessão opaco (hash SHA-256 no banco) + senha scrypt | sessão revogável; sem cookies ⇒ sem CSRF |
| Testes | `node:test` (integração contra Postgres real) | |

SQL é escrito à mão (parametrizado) com migrações versionadas em `api/migrations` — sem ORM, para controlar índices/transações.

## 3. Estrutura do banco (Fase 1 implementada em `001_core.sql`)

```
companies ─┬─ branches (matriz/filiais)
           ├─ roles ── role_permissions            users ── user_branches
           ├─ users ── sessions                    audit_log (company, user, entity, action, before, after, ip)
           ├─ brands, categories(árvore)
           ├─ products ── product_barcodes (N EAN) ── product_applications ──▶ vehicle_models
           │       └─── product_equivalences ──▶ equivalence_groups   (1 grupo por produto)
           ├─ customers (PF/PJ, vendedor, tabela de preço, limite)
           └─ suppliers (condições comerciais)
```
Regras: UUID em todas as PKs; `company_id` obrigatório em toda tabela de negócio; unicidades por empresa (`sku`, `barcode`, CPF/CNPJ); custo/preço em `NUMERIC`; índices em chaves de busca e GIN trigram em descrições.

**Próximas fases (tabelas previstas):**
- F2 Estoque: `stock_balances(product, branch, status[disponível|reservado|trânsito|avariado|quarentena|consignado], qty)`, `stock_movements` (append-only: usuário, doc, origem, destino, qtd anterior/movida/posterior), `inventories`.
- F3 Comercial: `price_tables/price_rules`, `quotes/quote_items`, `orders/order_items`, `sales/sale_items`, `payments`, `discount_approvals`.
- F4 Compras: `purchase_requests`, `quotations`, `purchase_orders/items`, `receivings`, `supplier_price_history`.
- F5 Financeiro: `receivables`, `payables`, `cash_sessions`, `bank_accounts`, `bank_transactions`, `reconciliations`.
- F6 Fiscal: `fiscal_documents`, `tax_rules`, `tax_payments`. F7: `chart_of_accounts`, `cost_centers`, `journal_entries` (partidas dobradas — DRE e balanço saem daqui, garantindo consistência). F9: `alert_rules/alerts`, `forecasts`, `ai_queries`.

## 4. Diagrama dos módulos

```
 CADASTROS ─▶ COMPRAS ─▶ ESTOQUE ─▶ PRECIFICAÇÃO ─▶ ORÇAMENTO ─▶ VENDA/PDV/B2B ─▶ EXPEDIÇÃO ─▶ ENTREGA
    │            │           │            │                            │                          
    └────────────┴───────────┴────────────┴──────────┬─────────────────┘            DEVOLUÇÃO/GARANTIA
                                                      ▼
                    FISCAL ◀── FINANCEIRO (AR/AP/caixa/bancos/conciliação) ──▶ FLUXO DE CAIXA
                                                      ▼
                          CONTABILIDADE GERENCIAL (plano de contas, CC, DRE, balanço)
                                                      ▼
                              BI ──▶ ALERTAS ──▶ IA "Pergunte à Empresa" / PREVISÃO
 Transversais: Usuários/RBAC · Auditoria · Multiempresa/Multifilial · Integrações (WhatsApp, bancos, marketplaces, transportadoras)
```

## 5. Fluxo de informações (evento de venda)

Uma única transação `confirmarVenda`:
1. valida permissão, limite de crédito, desconto/margem mínima (exige aprovação se violar);
2. reserva/baixa estoque → `stock_movements` (origem = venda);
3. grava custo (CMV) e margem por item;
4. cria `receivables` (parcelas) e comissão do vendedor;
5. lança partidas contábeis (receita, impostos, CMV, estoque, contas a receber);
6. grava `audit_log` e publica evento no **outbox**.

Depois, assíncrono via outbox: emissão fiscal, envio WhatsApp, sincronização de estoque com marketplaces. Fluxo de caixa, DRE, BI e giro são **consultas/visões sobre os mesmos lançamentos** — não há cópia manual de dados.

## 6. Usuários e permissões (implementado)

RBAC: `perfil → permissões "recurso:ação"` com ações `view, create, edit, delete, approve` sobre os recursos (`products, brands, categories, vehicles, equivalences, customers, suppliers, users, roles, branches, audit, settings` — novos módulos acrescentam recursos).
Perfis padrão por empresa: administrador, diretor, gerente, financeiro, vendedor, comprador, estoquista, fiscal, expedição (editáveis na tela *Perfis e permissões*, exceto administrador). Toda rota checa `can(req, 'recurso:ação')` no servidor; o front apenas esconde menus. Usuário tem ainda `max_discount_pct` (alçada de desconto, usada na Fase 3) e filiais permitidas.

## 7. Roadmap

| Fase | Entrega | Status |
|---|---|---|
| 1 Core | auth, empresas, filiais, usuários/RBAC, auditoria, produtos, marcas, categorias, motos/aplicações, equivalências, clientes, fornecedores, busca global, demo | **feito** |
| 2 Estoque | saldos por filial/status, movimentações imutáveis, transferência, inventário, mínimo/máx, curva ABC, parados, custo médio global | **feito** |
| 3 Comercial | tabelas de preço, motor de pricing, descontos/alçadas, orçamento→pedido, venda, PDV, B2B | **feito** |
| 4 Compras … | (próxima: Compras) | |
| 4 Compras | sugestão de compra, cotação, pedido, recebimento, XML, custo médio | **feito** |
| 5 Financeiro | AR/AP, caixa, bancos, conciliação, fluxo de caixa | **feito** |
| 6 Fiscal | NF-e/NFC-e via provedor, parametrização tributária (validada por contador), guias | |
| 7 Controladoria | plano de contas, centros de custo, DRE, balanço | **feito** |
| 8 BI | painéis comercial/estoque/compras/financeiro, visão do dono, metas | **feito** |
| 9 Inteligência | central de alertas por regras, "Pergunte à Empresa" (sem IA externa), previsão de demanda, recomendações | **feito** |
| 10 Ecossistema | marketplace (estrutura sem integração), WhatsApp por link | **feito (parcial por decisão)** — app do representante, loja online e WhatsApp integrado adiados |

## 8. Wireframes (desktop)

```
┌ Sidebar ─┬ [🔎 Busca global: produto, código, EAN, cliente…]  [Filial ▾]  Usuário · Perfil ┐
│ Geral    ├────────────────────────────────────────────────────────────────────────────┤
│ Cadastros│  Visão geral                                                                 │
│ Admin    │  [Produtos][Clientes][Fornecedores][Marcas][Motos]    ← KPIs reais do banco  │
│ Conta    │  Alertas: 🔴 margem abaixo da mínima  🟡 sem NCM  🟡 sem aplicação            │
└──────────┴────────────────────────────────────────────────────────────────────────────┘
Lista (padrão): [Pesquisar…]  N registros                         [+ Novo]
                SKU │ Descrição │ Marca │ Cód.fab │ Custo │ Preço │ Margem │ Ativo   (clique abre edição)
Produto (modal): campos do cadastro · Aplicações em moto (add/remover) · Equivalentes (marca, código, custo, preço, margem)
Busca por aplicação: [ Pastilha CG 160 2020 ]  → peças + "compatível com Honda CG 160 Titan 2016–atual"
PDV (Fase 3):   [código/EAN/aplicação ▸ enter]   itens ▸ total ▸ [F2 cliente] [F4 desconto] [F10 pagar]
```

## 9. Segurança

Implementado: senhas com scrypt+salt (nunca texto puro) e política mínima; sessão opaca revogável com expiração (12 h), hash no banco; bloqueio após 5 falhas (15 min) e mensagem de erro idêntica para e-mail inexistente/senha errada; rate limit global e específico no login; Helmet + CORS restrito; SQL 100 % parametrizado (nomes de coluna vêm de whitelist `zod`); React escapa saída (XSS); Bearer token em header (sem CSRF); senha provisória força troca; troca de senha revoga outras sessões; auditoria de logins, alterações de preço/custo, exclusões, permissões; isolamento por `company_id` com validação de referências cruzadas (testado).
A fazer: RLS do Postgres como segunda barreira, 2FA, criptografia de campos sensíveis em repouso, rotina de backup/restore (pg_dump + PITR), política LGPD (base legal, consentimento, exportação/anonimização de titular), retenção de logs.

## 10. Escalabilidade

Stateless API (escala horizontal atrás de balanceador); sessão no banco (migrável p/ Redis); paginação obrigatória (máx. 200); índices por `company_id` + chaves de busca; `stock_movements`/`audit_log` append-only e particionáveis por mês; saldos materializados em `stock_balances` (leitura O(1)); BI/relatórios pesados em réplica de leitura/visões materializadas; workers separados via outbox para integrações; multiempresa por coluna hoje, com caminho para schema/banco dedicado por cliente grande.

## Decisões do negócio (confirmadas)
- **Controladoria (confirmado):** DRE por **competência**; **saldo inicial de R$ 22.600,07** — interpretado como saldo inicial de caixa/bancos, com **Capital social** como contrapartida (se o valor tiver outro significado, o contador reclassifica por lançamento de abertura).
- **Fiscal (confirmado):** provedor de emissão **ainda não escolhido**; vendas para **CPF e CNPJ** (atacado e varejo), com regras próprias para CNPJ; **DAS apenas como estimativa** por enquanto.
- **Financeiro (confirmado):** banco único hoje = **BTG Pactual**, extrato em **CSV**; juros/multa pelo **padrão de mercado** (multa 2% única + juros 1% a.m. pro rata dia, configurável); **sem balcão** — vendas por representante externo e online, caixa físico opcional.
- **Compras (confirmado):** sem aprovação de compra por padrão — `emitir` já aprova; há um limite de aprovação configurável (`purchasing.approval_threshold`) para quando o negócio quiser. Fornecedores emitem **nota normal do Simples, sem ST**.
- **Regime tributário: Simples Nacional.** A Fase 6 usa CSOSN (não CST de ICMS), sem destaque de crédito de ICMS na saída, apuração via DAS; ICMS-ST/DIFAL tratados por regra de produto/UF. Parametrização a validar com o contador.
- **Custo médio: global** (um custo médio por produto, somando todas as filiais). Implementado: toda entrada com custo recalcula `cost_avg` ponderado pelo saldo próprio total (disponível+reservado+avariado+quarentena); transferência não altera custo.
- **Alçada de desconto:** todo desconto acima do limite do usuário (`users.max_discount_pct`) exige aprovação do gestor (permissão `sales:approve`), registrada em `discount_approvals` com solicitante, aprovador, percentual, margem antes/depois e auditoria. Vendas abaixo da margem mínima seguem a mesma trava. Entra na Fase 3.

## Fase 2 — Estoque (como funciona)
- `stock_balances` por produto × filial × status (disponível, reservado, trânsito, avariado, quarentena, consignado); saldo nunca negativo (CHECK + validação sob `FOR UPDATE`, testado com saídas concorrentes).
- `applyMovement` é a **única** porta de alteração de saldo: grava `stock_movements` (append-only, trigger bloqueia UPDATE/DELETE) com usuário, documento, origem/destino, quantidade anterior/movida/posterior e motivo.
- Operações: entrada, entrada consignada, saída, ajuste ±, reserva/liberação, bloqueio/desbloqueio, avaria, transferência (saída → trânsito → recebimento, ou cancelamento) e inventário geral/rotativo (acerto exige `stock:approve`).
- Análises: abaixo do mínimo / sem estoque / excesso, produtos parados por faixa (0–30 … +360) com capital, valor de venda, margem potencial e sugestão, e curva ABC configurável (corte A/B) por valor em estoque, quantidade ou saídas. **Faturamento e margem** como critério dependem das vendas (Fase 3) e hoje retornam erro explícito.
- "Parado" usa a data da última saída (ou da entrada, se nunca saiu); quando a venda existir, ela gera a saída e a análise passa a refletir vendas reais.

## Fase 3 — Comercial (como funciona)
- **Preço de venda** (`resolvePrice`): base = preço de varejo do produto; a tabela do cliente aplica a melhor regra (cliente > produto > marca > categoria > geral; depois maior quantidade mínima; filtro por canal); promoções vigentes só podem reduzir o preço.
- **Motor de precificação**: custo de aquisição (custo médio global + frete + seguro + acessórias) → preço = aquisição ÷ (1 − impostos − comissão − cartão − despesas variáveis − margem). Parâmetros por empresa (`company_settings`); a alíquota efetiva do Simples é informada e deve ser validada pelo contador — nada vem pré-configurado. Simulador nos dois sentidos (preço → margem; margem → preço) e aplicação em lote da sugestão (permissão `pricing:approve`, auditada).
- **Alçada de desconto (decisão do negócio)**: o limite está em `users.max_discount_pct` (padrão 5% para vendedores). Desconto acima do limite, ou preço abaixo da margem/preço mínimo do produto, coloca a venda em `aguardando_aprovacao` (estoque já reservado) e abre `sale_approvals`. Só quem tem `sales:approve` aprova — e **nunca a própria venda** (segregação de funções). Quem já aprova não é barrado, mas o desvio é auditado (`self_approved`). Recusar cancela e libera a reserva. A prévia (`/sales/preview`) mostra margem antes/depois do desconto, margem mínima e impacto financeiro antes de concluir.
- **Venda**: pedido reserva estoque → conclusão exige pagamentos = total, baixa o reservado (movimento `saida` com custo), gera `receivables` (à vista = pago; cartão/boleto/crediário = parcelas abertas), comissão do vendedor, CMV e margem (total − imposto estimado − CMV). Venda a prazo valida limite de crédito: acima do limite só gestor conclui. Cancelar concluída exige gestor, devolve ao estoque e estorna recebíveis. Falta de estoque devolve 409 com **equivalentes disponíveis**.
- **Orçamento**: rascunho → enviado (link público com token; só o hash fica no banco) → visualizado → aprovado → convertido; expira automaticamente. Aprovação pelo cliente no link gera o pedido (preços do orçamento honrados; alçada avaliada contra o vendedor). Link de WhatsApp (`wa.me`) é gerado; **o envio automático por API do WhatsApp fica para a Fase 10**.
- **PDV**: busca por código, EAN, SKU, fabricante, original, descrição e aplicação; leitor de código de barras funciona como teclado (Enter adiciona o item exato).
- **B2B**: carteira com limite/utilizado/disponível/vencido, painel do cliente (faturamento, ticket, frequência, margem, mais comprados, inadimplência), repetir pedido em 1 clique e pedidos recorrentes (geração disparada pelo gestor; sem agendador automático ainda).
- Vendedores enxergam só as próprias vendas e orçamentos; gestores veem tudo. Dashboard comercial real: faturamento dia/mês, meta, ticket, margem, por vendedor e por canal.
- Limitações conscientes: documento fiscal só na Fase 6 (imposto da venda é **estimativa** pela alíquota informada); contas a receber são a base da Fase 5 (baixa/juros/multa/conciliação ainda não existem); comissão é calculada e gravada, mas ainda não há fechamento/pagamento de comissões.

## Fase 4 — Compras (como funciona)
- **Sugestão de compra**: para cada produto calcula posição (disponível + pedidos pendentes + em trânsito) contra o ponto de pedido = máx(mínimo, demanda no prazo + segurança por curva ABC: A 30%, B 15%, C 5%); demanda = venda média dos últimos 90 dias × fator de sazonalidade (mesmo período do ano anterior, só quando há 12+ meses de histórico — senão 1,0 e o motivo é exibido) × (prazo do fornecedor + dias de revisão). Repõe até o estoque ideal, limitado ao máximo. Fornecedor = o preferencial, ou o de menor último preço. Cada item mostra **nível de confiança** (baixa/média/alta pelo histórico) e a base do cálculo — nunca é apresentado como certeza.
- **Cotação**: itens × ofertas de fornecedores (preço, prazo de entrega, prazo de pagamento); melhor preço por item (empate pelo menor prazo); a adjudicação fecha a cotação e gera **um pedido por fornecedor vencedor**. Toda oferta entra no histórico de preços.
- **Pedido de compra**: rascunho → aprovado → enviado → parcial → recebido (ou cancelado). Com limite de aprovação configurado, pedidos acima dele aguardam quem tem `purchases:approve` (outra pessoa, nunca o criador).
- **Recebimento**: importa XML de NF-e (casa fornecedor pelo CNPJ; produto por código do fornecedor já aprendido → EAN → código do fabricante; itens sem casamento são vinculados na conferência e o sistema aprende) ou lançamento manual. Conferência física item a item; entrada parcial; divergência de quantidade (NF × físico × pedido) e de preço (NF × pedido, tolerância 0,5%) bloqueiam a conclusão até serem aceitas — **divergência de preço só por quem aprova compras**. NF duplicada (chave ou nº/série do fornecedor) é recusada. Leitor de XML recusa DTD/entidades.
- **Custo de entrada (Simples, nota normal, sem ST)**: sem crédito de ICMS/PIS/COFINS, o custo é valor do item + IPI do item + rateio proporcional de frete/seguro/outras despesas − rateio do desconto. Atualiza o custo médio **global** (ponderado) e o último custo; registra preço no histórico do fornecedor; gera contas a pagar (duplicatas do XML ou prazo do pedido/fornecedor). Pagar a NF integral mesmo com entrega parcial é intencional: a diferença deve ser tratada por devolução/crédito.
- **Devolução ao fornecedor**: baixa o estoque disponível (movimento `devolucao_fornecedor`) e gera **crédito** a abater no contas a pagar (a baixa/compensação é da Fase 5).
- **Comparação de fornecedores**: último preço, variação sobre o preço anterior, média/menor/maior, prazos e histórico — base para o alerta "fornecedor aumentando preço" (Fase 9).
- Permissões: `purchases:*` (pedidos, cotações, devoluções) e `receiving:*` (recebimento): o estoquista confere e dá entrada, mas não emite pedidos.
- Limitações: contas a pagar são só o registro (pagamento, juros, categoria e centro de custo na Fase 5); não há envio automático de pedido ao fornecedor por e-mail/portal (marcar "enviado" é manual); manifestação do destinatário/SEFAZ não é feita (importa apenas o XML recebido); XML de NF com ST ou de outro regime será lido, mas o custo não trata ICMS-ST (fora do escopo confirmado).

## Fase 5 — Financeiro (como funciona)
- **Contas** (`bank_accounts`: banco, caixa, aplicação) com **razão** (`account_movements`): saldo = saldo inicial + movimentos. Transferências e aplicações/resgates são pares de movimentos; tarifas, juros, rendimentos e ajustes são lançamentos avulsos (ajuste exige gestor).
- **Baixas** (`settlements`) totais ou **parciais**, para receber e pagar: caixa = principal − desconto + juros + multa (− taxa de cartão/gateway nos recebimentos). Juros/multa são calculados pelo padrão da empresa — multa uma única vez sobre o saldo, juros pro rata dia desde o vencimento ou da última baixa. **Perdoar encargos** ou dar desconto > 5% exige `finance:approve`; tudo é auditado. Estorno de baixa (gestor) gera movimento inverso e é bloqueado se já foi conciliado.
- **Contas a receber**: parcelas das vendas e títulos avulsos, aging (a vencer, 1–30, 31–60, 61–90, +90), inadimplência. Pagamentos à vista (Pix, débito, dinheiro) só baixam sozinhos se houver **conta padrão** para a forma de pagamento; senão ficam em aberto para baixa manual ou conciliação. Cartão de crédito e boleto sempre aguardam o recebimento (a taxa real entra na baixa).
- **Contas a pagar**: notas de compra, despesas avulsas com **categoria, centro de custo e competência**, parcelamento e recorrência mensal, compensação de créditos de fornecedor (devolução) e comissões. Categorias já trazem o grupo da DRE (`dre_group`) para a Fase 7.
- **Conciliação bancária**: importação de extrato **CSV** com mapeamento de colunas (detecção automática pelo cabeçalho, separador, formato numérico/data brasileiros, débito/crédito em colunas separadas ou valor com sinal; mapeamento salvo por conta; reimportar não duplica). Concilia automaticamente linha ↔ movimento do ERP quando há um único candidato exato (mesma conta, valor e data ±5 dias); o restante é resolvido por: vincular movimento, **baixar título direto do extrato** (o valor calculado precisa bater com o extrato), criar lançamento (tarifa/rendimento/…) ou ignorar com motivo.
- **Caixa físico (opcional)**: abertura, suprimento, sangria (com destino) e fechamento com diferença lançada como quebra de caixa. Fica desligado na prática enquanto não houver balcão.
- **Fluxo de caixa** (hoje, 7, 30, 60, 90 dias e 12 meses): *realizado* (movimentos), *previsto* (vencimentos em aberto) e *projetado* (previsto ajustado pelo atraso médio e taxa de recebimento medidos no histórico; com menos de 10 títulos históricos não há ajuste e a confiança é "baixa"). Alerta de saldo futuro negativo no painel.
- **Comissões**: calculadas por venda; o fechamento por vendedor gera um título a pagar (categoria Comissões) e marca as vendas — sem pagamento em duplicidade.
- **Limitação importante — layout do BTG**: não tive acesso a um extrato real do BTG Pactual; o importador trabalha por mapeamento de colunas e detecta pelos nomes de cabeçalho comuns (data, histórico/descrição, valor ou débito/crédito, documento). **Envie um CSV real (com dados sensíveis mascarados) para validarmos e fixarmos o perfil do BTG.** `api/samples/extrato-exemplo-demo.csv` tem layout genérico, não oficial.
- Outras limitações: não há integração bancária/Open Finance nem boleto/Pix emitidos pelo sistema; sem conciliação de cartão por operadora/gateway (a taxa é informada na baixa); sem rateio de baixa entre vários títulos de uma vez; comissão de venda cancelada depois do fechamento não é estornada automaticamente; DRE/lucro do mês entram na Fase 7.

## Fase 6 — Fiscal (como funciona)
- **Provedor intercambiável**: o sistema monta um documento fiscal normalizado (emitente, destinatário, itens com NCM/CFOP/CSOSN, totais, pagamentos, referências) e o entrega a um *provedor* (`fiscal/providers.ts`). Como a escolha ainda não foi feita, existem dois: **manual** (padrão — a nota é emitida no seu sistema/portal e *registrada* aqui) e **simulado** (sandbox de testes, marcado "SEM VALOR FISCAL", bloqueado em produção). Integrar Focus NFe, eNotas, PlugNotas etc. = escrever um adaptador que implemente `emit/cancel/correct`; nada mais muda.
- **Regras (Simples Nacional, mercadoria adquirida de terceiros)**: CFOP 5102 (mesma UF) / 6102 (outra UF) / 6108 (outra UF a não contribuinte); CSOSN 102 por padrão (sobrescrevível por produto: 500/201 se houver ST, exigindo CEST); PIS/COFINS CST 49; texto legal do Simples nas informações complementares. Indicador de IE (1/2/9), consumidor final (revenda/lojista compram para revender; oficina e PF são consumidor final; pode ser forçado no cliente), presença do comprador (balcão presencial, online internet, demais "outros").
- **Regras para CNPJ e CPF**: **venda para CNPJ ⇒ sempre NF-e (55)**, com IE obrigatória se contribuinte. Para **CPF**: NFC-e (65) só em **venda presencial de balcão** e se habilitada; vendas por representante externo ou online (não presenciais) ⇒ NF-e. NF-e exige destinatário identificado com CPF/CNPJ válido e endereço completo.
- **Validação antes de emitir** (erros bloqueiam; alertas pedem conferência): CNPJ/IE/endereço/CRT do emitente (por filial), documento e endereço do destinatário, NCM de 8 dígitos, origem, unidade, CSOSN válido, CEST se ST, total da nota = total da venda. Alertas permanentes: **ST** (autopeças/motopeças costumam estar sujeitas, por estado) e **DIFAL** em venda interestadual a não contribuinte — **o sistema não calcula DIFAL nem ST**; precisa de validação do contador.
- **Ciclo**: venda concluída → rascunho (manual ou em lote) → revalidação com cadastros atuais → emitir (provedor que emite) ou registrar nota emitida fora (valida **chave de 44 dígitos: dígito verificador, CNPJ, modelo, UF**, e confere o XML com chave e valor) → cancelamento (gestor/fiscal, justificativa ≥ 15 caracteres, **prazo configurável**, protocolo obrigatório quando manual), **CC-e** (≥ 15 caracteres, até 20) e **nota de devolução** (CFOP 1202/2202, referencia a nota original, quantidade limitada ao saldo). Venda com nota autorizada **não pode ser cancelada** antes de cancelar a nota.
- **XMLs**: repositório de XMLs emitidos e **recebidos** (o XML da NF de compra passou a ser guardado na importação), com download.
- **Impostos (DAS)**: painel mensal com faturamento por competência, estimativa e obrigação (valor oficial da guia, vencimento no dia 20 ajustado para dia útil sem feriados, comprovante). A estimativa usa **alíquota efetiva informada** (padrão) ou a **tabela do Anexo I (comércio)** pelo RBT12 (calculado, proporcionalizado no 1º ano, ou informado pelo contador). Gerar o título cria a conta a pagar (categoria "Simples Nacional (DAS)") e o status acompanha o pagamento. **Sempre estimativa** até o contador informar a guia do PGDAS-D.
- **Reforma tributária (IBS/CBS)**: campos previstos no documento (opcionais, zerados) — sem cálculo até a regra e o layout do provedor serem confirmados.
- Limitações: nenhuma emissão com valor fiscal enquanto não houver provedor (nem certificado A1/CSC configurados); sem inutilização de numeração, contingência, manifestação do destinatário, MDF-e/CT-e nem DANFE próprio (o provedor fornece); a devolução gera só a nota — estoque/financeiro da devolução serão tratados no módulo de devoluções e garantias; código IBGE do município deve ser informado (alerta, não bloqueio); não há "ZIP" de XMLs para o contador (download individual).

## Fase 7 — Controladoria (como funciona)
- **Razão de partidas dobradas** (`journal_entries`/`journal_lines`), **imutável** (gatilho bloqueia UPDATE/DELETE; correção só por estorno) e **balanceado pelo banco** (gatilho de restrição recusa, ao fim da transação, qualquer lançamento com débitos ≠ créditos). Cada linha carrega dimensões (filial, canal, cliente, produto, marca, categoria, vendedor, centro de custo, fornecedor, conta bancária) e cada lançamento tem **data** e **competência**.
- **Lançamentos automáticos** (um por origem, idempotentes): venda concluída (receita, contas a receber, CMV/estoque, provisão do DAS e comissão — por item); cancelamento (devolução como dedução da receita, estoque de volta, valor já recebido vira "clientes a restituir" e gera conta a pagar de restituição); baixas de recebíveis (juros/multa = receita financeira, desconto concedido, taxa de cartão) e de pagáveis (juros pagos, descontos obtidos) e seus estornos; entrada de NF (estoque × fornecedores, diferença de conferência em "créditos com fornecedores"); devolução ao fornecedor; despesas por **competência** (despesa × outras contas a pagar) ou imobilizado; tarifas, juros, rendimentos, ajustes, transferências e aplicações (conta de compensação que fecha em zero), quebra de caixa; perdas/sobras de estoque (CMV – perdas) e entradas manuais (saldo de abertura a classificar); ajuste da provisão do DAS ao valor da guia; saldo inicial das contas bancárias (**contrapartida: Capital social**).
- **Plano de contas configurável** (padrão para comércio com ~45 contas): renomear/renumerar/criar contas e **mapear cada categoria financeira para a conta contábil**; contas "sistema" (usadas pelos lançamentos automáticos por chave interna) não são inativadas. **Lançamentos manuais e de abertura** (imobilizado, empréstimos, lucros acumulados…) exigem `accounting:approve`, devem balancear e são estornáveis.
- **DRE gerencial por competência** — receita bruta, (−) devoluções/cancelamentos/descontos, (−) impostos (DAS), = receita líquida, (−) CMV (inclui perdas de estoque), = lucro bruto, (−) despesas comerciais/administrativas/financeiras, (+) receitas financeiras, = resultado operacional, (+/−) outros, = **lucro líquido**; por período e **por mês, filial, canal, categoria, marca ou cliente**, com análise vertical e exportação CSV. Despesas sem dimensão aparecem em "Não alocado". Valores com sinal (deduções/custos/despesas negativos).
- **Balanço patrimonial** em qualquer data (circulante/não circulante, passivo, patrimônio líquido com resultado apurado), **balancete**, **razão por conta**, **despesas por centro de custo**.
- **Verificações de consistência**: razão × saldo de cada conta bancária, × contas a receber, × fornecedores (NF e créditos), × estoque físico valorizado (tolerância: razão usa custo de cada movimento; físico usa custo médio atual), débitos = créditos, **Ativo = Passivo + PL**, vendas sem lançamento. **Sincronizar razão** lança o que ainda não tem lançamento (útil sobre dados anteriores à Fase 7).
- **Registrar o saldo inicial de R$ 22.600,07 em produção**: `ADMIN_EMAIL=… ADMIN_PASSWORD=… COMPANY_NAME=… OPENING_BALANCE=22600.07 npm run bootstrap` cria a conta BTG Pactual com esse saldo (ou cadastre a conta em Financeiro → Bancos e caixa). Outros saldos de abertura: Controladoria → Lançamentos → Abertura do balanço.
- Limitações: sem fechamento/bloqueio de períodos nem encerramento do exercício (o resultado do período aparece como "resultado apurado" no PL; a transferência para lucros acumulados é manual do contador); provisão do DAS usa a alíquota efetiva dos parâmetros (true-up só ao gerar o título do DAS); comissão e imposto de venda cancelada após fechamento de comissão/DAS dependem de ajuste manual; rateio de imposto/comissão por item é proporcional; estoque no razão pode divergir do físico pelo custo médio; sem depreciação, provisões, IRPJ/CSLL (Simples), conciliação de cartão por operadora, nem SPED/ECD/ECF.

## Fase 8 — BI (como funciona)
- **Metas** (`goals`, tela BI → Metas): estrutura pronta e editável; tipos faturamento, margem bruta mínima, ticket médio, giro, cobertura máxima e inadimplência máxima; escopo empresa/vendedor/categoria; meta de um mês específico substitui a "todos os meses". Sem meta definida, os painéis mostram o resultado sem comparar. Os valores do ambiente de demonstração são exemplos (seed DEMO); em produção nenhum valor é inventado.
- **Visão do dono** (`/bi`): 14 perguntas de gestão respondidas com número, origem e link de detalhe; janela móvel de 30 dias contra os 30 anteriores.
- **Comercial**: KPIs com variação, linha diária com comparação, meta com projeção do mês, rankings (vendedor/cliente/produto/categoria/marca/canal/filial), clientes que reduziram compras (queda ≥ 30% com base mínima R$ 500, configuráveis), vazamentos de margem e maiores descontos.
- **Estoque**: valor, giro (CMV 90d anualizado ÷ estoque), cobertura, ABC, rupturas, excesso e parados. **Compras**: fornecedores (prazo/pontualidade), variação de preço, economia, pedidos abertos. **Financeiro**: caixa, aging, inadimplência, PMR/PMP, fluxo 30/60/90 (estimativa com confiança), resultado 6 meses.
- Gráficos em SVG próprio com tooltip, legenda e alternância para tabela.
- Limitações: giro/previsões dependem do histórico disponível; DAS é estimativa; sem exportação agendada de relatórios.

## Fase 9 — Inteligência (como funciona)
- **Decisões**: alertas ficam **dentro do sistema** (sem e-mail/WhatsApp até a Fase 10); **sem IA externa** (não há chave de API). "Inteligência" aqui = regras objetivas + estatística simples + consultas fixas, sempre mostrando a origem do número.
- **Central de alertas** (`alerts`, `alert_rules`): 14 regras (ruptura, abaixo do mínimo, estoque parado, venda abaixo da margem mínima, meta de faturamento/margem em risco, cliente comprando menos, inadimplência, contas a pagar, caixa projetado negativo, extrato sem conciliar, fornecedor aumentou preço, aprovações paradas, notas rejeitadas/rascunhos). Cada alerta tem identificador estável (`fingerprint`): reexecutar não duplica, o alerta **fecha sozinho** quando o problema some e reabre se voltar. Reconhecer/adiar/reabrir são auditados; adiamento vence sozinho. Limites de cada regra e liga/desliga em Alertas → Regras (validados). Alertas de meta só existem se houver meta cadastrada. Atualiza sozinho a cada 5 min ao abrir a tela; sino na barra superior.
- **Previsão de demanda**: média móvel ponderada de 12 semanas + tendência amortecida (limitada a ±50% da média); **sem sazonalidade** (exigiria 24+ meses). Confiança baixa/média/alta pelo histórico e a nota explica o motivo. Cobertura e data estimada de ruptura; compra sugerida vem do mesmo motor da sugestão de compra.
- **Recomendações**: comprar, girar estoque parado (até o preço mínimo do cadastro), rever preço (margem alvo sobre o custo médio) e cobrar — cada uma com a base do cálculo. São sugestões; nada é executado automaticamente.
- **Pergunte à Empresa**: interpretador por regras (palavras-chave normalizadas) → consulta fixa no banco → resposta com tabela, origem e link. ~18 intenções (vendas, lucro, vendedor, cliente, produto, caixa, a pagar, impostos, estoque, parado, comprar, ruptura, fornecedor, margem, alertas, produto por SKU). Período entendido: hoje, ontem, semana, este mês, mês passado, ano, "últimos N dias". O que não entende, diz que não entendeu (registrado em `ask_log` para ampliar o catálogo).
- Limitações: perguntas fora do catálogo não são respondidas; previsão sem sazonalidade e com pouco histórico tem confiança baixa; sem notificação fora do sistema; regras não consideram promoções/eventos futuros.

## Fase 10 — Ecossistema (como funciona)
- **Decisões**: app do representante, loja online/B2B com login do cliente e WhatsApp integrado foram **adiados**; WhatsApp **só por link** (wa.me). Marketplace: ainda sem canal definido, então a estrutura é **independente de canal** e **sem integração** (pedidos entram por lançamento, anúncios saem em planilha CSV).
- **Venda externa (atacado e varejo)**: usa o que já existe — vendas tipo `externo`/`atacado`, tabelas de preço por cliente/quantidade/canal, alçada de desconto, regras fiscais para CPF e CNPJ, comissão por vendedor.
- **Marketplace** (`marketplaces`, `marketplace_listings`, `marketplace_orders`): canal com comissão %, taxa fixa por pedido, frete médio e prazo de repasse. Anúncio = preço por produto/canal; o sistema mostra a **margem real** (preço − imposto estimado − comissão − taxa − frete − custo), o preço para a margem alvo, a quantidade publicável (disponível − reserva de segurança) e baixa/prejuízo. **Pedido** do canal vira venda concluída (`channel=marketplace`, baixa estoque, custo, margem, contabilidade) com recebível vencendo no repasse esperado; preço abaixo da margem mínima exige gestor. **Repasse**: baixa pelo valor cheio e lança as taxas reais como despesa (taxa de recebimento); repasse atrasado move o vencimento sem juros/multa. Cancelar antes do repasse devolve o estoque. Resumo por canal com margem após taxas. Alertas: repasse atrasado e anúncio no prejuízo.
- **WhatsApp por link**: cobrança (valor atualizado com multa/juros do padrão da empresa), lembrete de vencimento e confirmação de pedido; cotação já tinha o link público. O sistema só monta o texto e abre a conversa (quem envia é a pessoa); sem telefone, mostra o texto para copiar. Cada geração é auditada.
- Limitações: sem integração automática (pedidos/estoque/preço não sincronizam sozinhos); devolução de pedido já repassado é manual; margem do BI por venda não inclui comissão/frete do canal (o resumo do marketplace inclui); taxa fixa e frete são por pedido, na análise de anúncio considera-se 1 unidade.

## Perguntas em aberto
- Provedor de emissão fiscal (ex.: Focus NFe, eNotas) para a Fase 6.
- Percentual de desconto inicial por usuário/perfil (hoje cada usuário tem `max_discount_pct`).
