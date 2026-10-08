# GTX MOTO PARTS ERP — usar no seu computador (provisório)

Tudo roda localmente, com os dados guardados no seu computador. Nada vai para a internet.

## O que instalar (uma vez)
**Docker Desktop** (gratuito para uso pequeno): https://www.docker.com/products/docker-desktop — instale, abra e espere ele ficar "em execução". Funciona no Windows, Mac e Linux.

## Ligar o sistema
Abra um terminal (no Windows: PowerShell) **dentro desta pasta (`erp`)** e rode:
```
docker compose up -d --build
```
A primeira vez demora alguns minutos (baixa e monta tudo). Depois abra no navegador: **http://localhost:8080**

## Primeiro acesso — escolha UMA das duas opções

**A) Ver o sistema com dados de demonstração (fictícios)**
```
docker compose exec app npm run seed:demo
```
Entre com `admin@demo.local` e a senha `Demo@12345678`. Serve para conhecer; **não use para dados reais**.

**B) Começar para valer, com a empresa real (sem dados de exemplo)**
```
docker compose exec -e ADMIN_EMAIL=voce@empresa.com -e ADMIN_PASSWORD="Troque-Esta-Senha-123" -e COMPANY_NAME="GTX Moto Parts" -e OPENING_BALANCE=22600.07 -e BANK_NAME="BTG Pactual" app npm run bootstrap
```
Entre com esse e-mail e senha; o sistema pede para você criar uma senha nova no primeiro acesso.
(Se você testou a demonstração antes, apague tudo antes de começar para valer — veja "Recomeçar do zero".)

## Dia a dia
- Desligar: `docker compose stop` · Ligar de novo: `docker compose start` (os dados continuam).
- **Backup (faça com frequência!):** `docker compose exec -T db pg_dump -U erp wmg_erp > backup-AAAA-MM-DD.sql`
  Guarde o arquivo `.sql` em outro lugar (pen drive, nuvem).
- **Restaurar um backup:** `docker compose exec -T db psql -U erp wmg_erp < backup-AAAA-MM-DD.sql` (em banco vazio).
- Ver erros: `docker compose logs app`

## Recomeçar do zero (apaga TODOS os dados)
```
docker compose down -v
```

## Observações
- Só você acessa (localhost). Para outras pessoas usarem, é preciso publicar num servidor (veja `docs/DEPLOY.md`).
- Atualizar para uma versão nova do sistema: baixe a pasta atualizada e rode `docker compose up -d --build` (os dados são preservados).
- O computador precisa ficar ligado para o sistema funcionar.
