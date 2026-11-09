# MineHost Panel

Painel web Node.js para hospedagem de servidores Minecraft Java e Bedrock, com API, PostgreSQL e integração Matrix por Client-Server API.

## Importante sobre hospedagem sem VPS

Este projeto roda como uma aplicação Node.js persistente em uma hospedagem que suporte:
- Node.js 20 ou superior;
- processo web Node.js mantido ativo;
- variáveis de ambiente;
- conexão de saída HTTPS;
- PostgreSQL externo ou PostgreSQL fornecido pela hospedagem.

Não requer cPanel, Docker ou acesso root. Não é compatível com hospedagens que só executam scripts Node por poucos segundos. O bot Matrix usa long-polling e precisa que o processo permaneça ativo.

O painel não consegue criar servidores em máquinas de terceiros por conta própria. Para provisionamento real, é necessário configurar uma API oficial de um provedor e implementar/ativar seu adaptador autorizado. Não informe credenciais de painel de terceiros a este projeto sem verificar as permissões.

## Deploy genérico

1. Crie um banco PostgreSQL na hospedagem ou em serviço gerenciado.
2. Envie o conteúdo deste ZIP para o serviço Node.js ou conecte o repositório.
3. Configure a versão Node.js para 20+.
4. Configure as variáveis de ambiente conforme `.env.example`.
5. Comando de instalação: `npm install`
6. Comando de inicialização: `npm start`
7. Configure `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL` e `ADMIN_PASSWORD`.
8. Abra o domínio da aplicação. O banco e o administrador inicial são preparados automaticamente.

Se a hospedagem exigir porta fixa, configure `PORT` conforme a documentação dela. A aplicação usa `process.env.PORT`.

## Primeiro acesso

Use o e-mail e a senha definidos em `ADMIN_EMAIL` e `ADMIN_PASSWORD`. O usuário administrador é criado no primeiro boot, caso ainda não exista. Altere a senha no ambiente e nunca compartilhe o `.env`.

## Criação automática de servidores (Pterodactyl)

O painel cria servidores de verdade pela API oficial do Pterodactyl (Application API). Configure no `.env`: `PTERO_URL`, `PTERO_API_KEY`, `PTERO_USER_ID`, `PTERO_LOCATION_ID` e `PTERO_EGGS` (mapa `edição:software` → nest/egg do seu Pterodactyl, ex.: `java:paper`, `bedrock:vanilla`).

- Com tudo configurado, **painel e bot criam o servidor na hora** (status `provisioning` → `active`, com o endereço IP:porta).
- Sem Pterodactyl (ou sem egg para o software escolhido), a solicitação fica `pending` e o admin aprova; ao aprovar com Pterodactyl ativo, o servidor é criado.
- Se falhar, o status vira `failed` com o motivo; o admin pode "Aprovar" de novo para tentar outra vez.
- Softwares: Java (paper, purpur, fabric, forge, vanilla) e Bedrock (vanilla, pocketmine, powernukkitx). Edite `CATALOG` em `src/provision.js`.

## Modo LOCAL (sem API do Pterodactyl) — painel, bot e servidores na mesma hospedagem

Com `LOCAL_SERVERS=true`, o painel baixa o software e roda cada servidor como processo filho, dentro do seu container. `!criar` e o botão do painel já deixam o servidor no ar.

- **Java:** Paper, Purpur, Fabric, Vanilla. Se não houver Java 21 no PATH, o painel baixa um JRE sozinho (precisa de `tar` e saída HTTPS).
- **Bedrock:** PowerNukkitX (Java, funciona em qualquer arquitetura) e Bedrock oficial (só x64, experimental).
- Controle: `!iniciar`, `!parar`, `!reiniciar`, `!matar`, `!status`, `!cmd`, `!log` (e botões no painel). Servidores que estavam ligados voltam sozinhos quando o painel reinicia.
- Dados em `DATA_DIR` (`./data/servers/<id>`). Mantenha em disco persistente.

**O que a hospedagem precisa dar (confira com ela):**
1. **Portas extras.** Só portas alocadas ao seu container ficam acessíveis de fora. Liste-as em `MC_JAVA_PORTS` / `MC_BEDROCK_PORTS`. Bedrock usa UDP. Cada servidor usa uma porta; sem portas extras só cabe um servidor, e a porta do painel não pode ser usada.
2. **RAM e disco.** Painel e servidores dividem o limite do container. Use `LOCAL_TOTAL_RAM_MB` para o painel recusar iniciar além do plano. A cota de disco por servidor não é aplicada.
3. **PostgreSQL externo** (o painel precisa de `DATABASE_URL`), por exemplo um Postgres gratuito de um serviço gerenciado.
4. **EULA:** defina `ACCEPT_MINECRAFT_EULA=true` somente se você aceita https://aka.ms/MinecraftEULA.

Os links de download (PaperMC, Purpur, Fabric, Mojang, GitHub do PowerNukkitX e Adoptium) não foram testados contra os servidores reais. Se algum mudar, use `MC_URL_<EDICAO>_<SOFTWARE>` (ex.: `MC_URL_JAVA_PAPER`) para apontar o arquivo.

## Modo cliente (hospedagem onde você não é admin do Pterodactyl)

A chave de cliente (`ptlc_`) não cria servidores. Então o fluxo é:
1. O usuário pede (`!criar` no Element X ou pelo painel) e a solicitação fica `pending`.
2. O admin cria o servidor no painel da hospedagem e, no MineHost, clica em **Vincular** informando o identificador (8 caracteres da URL do servidor). O status vira `active` e o IP:porta é preenchido.
3. O usuário controla pelo bot ou pelo painel: `!iniciar`, `!parar`, `!reiniciar`, `!matar`, `!status`, `!cmd`.

Configure `PTERO_URL` e `PTERO_CLIENT_KEY`. Excluir no MineHost remove só o registro; o servidor continua no painel da hospedagem.

## Matrix / Element X

Crie um usuário/bot Matrix e configure `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` e `MATRIX_BOT_USER`. Convide o bot para uma sala (ele aceita o convite sozinho) e use:

- `!link CODIGO` — vincula sua conta (código gerado no painel, vale 15 min)
- `!criar <nome> <java|bedrock> [software] [ram] [disco]` — ex.: `!criar survival java paper 2G 10G`, `!criar mundo bedrock`
- `!servidores`, `!info ID`, `!excluir ID confirmar`, `!ajuda`

**Importante:** o bot não suporta E2EE. No Element X, crie a sala **sem criptografia** (DMs novas vêm criptografadas por padrão). Se o bot ler uma mensagem criptografada, ele avisa.

## Funcionalidades

- Cadastro/login (bcrypt + JWT em cookie HttpOnly), CSP ativa, rate limit, validação com zod;
- Criar/excluir servidores pelo painel ou pelo bot, com limite por usuário (`MAX_SERVERS_PER_USER`);
- Painel admin: aprovar, recusar, excluir, provedores e máquinas;
- Atualização automática do status enquanto o servidor é criado.

## Limitações

- Sem Pterodactyl configurado, nada é criado automaticamente.
- Console, arquivos, energia e backups ainda ficam no próprio Pterodactyl.
- Sem E2EE no Matrix. Configure HTTPS e backups do PostgreSQL.

## Estrutura

- `src/index.js`: servidor web.
- `src/db.js`: PostgreSQL e schema.
- `src/auth.js`: autenticação.
- `src/routes.js`: API.
- `src/matrix.js`: integração Matrix.
- `public/`: interface web.
