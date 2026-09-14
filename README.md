# Bot Gateway - Sistema de Vendas Discord

Bot privado para automatização de vendas e entrega de produtos digitais no Discord.

## 🚀 Funcionalidades

- **Pagamento PIX** via Mercado Pago
- **Pagamento Internacional** via Stripe (Cartão/Cripto)
- **Entrega Automática** via DM após confirmação
- **Atribuição de Cargo VIP** no servidor
- **Painel de Produtos** com comandos slash

## 📁 Estrutura do Projeto

```
botGateway/
├── src/
│   ├── api/                    # Servidor Express
│   │   ├── middleware/         # Middlewares
│   │   └── routes/webhooks/    # Rotas de webhook
│   ├── bot/                    # Bot Discord
│   │   ├── commands/           # Comandos slash
│   │   ├── events/             # Event handlers
│   │   └── interactions/       # Handler de botões/menus
│   ├── services/
│   │   ├── database/           # Prisma client
│   │   └── payments/           # Integrações de pagamento
│   ├── utils/                  # Utilitários
│   └── index.ts               # Entry point
├── prisma/
│   └── schema.prisma          # Schema do banco de dados
├── .env                       # Variáveis de ambiente
└── package.json
```

## ⚙️ Configuração

### 1. Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha:

```env
# Discord
DISCORD_TOKEN=seu_token_do_bot
DISCORD_CLIENT_ID=seu_client_id
VIP_ROLE_ID=id_do_cargo_vip

# Database
DATABASE_URL="postgresql://usuario:senha@localhost:5432/bot_gateway"

# Mercado Pago
MERCADO_PAGO_ACCESS_TOKEN=seu_access_token
MERCADO_PAGO_WEBHOOK_SECRET=seu_webhook_secret

# Stripe
STRIPE_SECRET_KEY=sk_test_sua_chave
STRIPE_WEBHOOK_SECRET=whsec_seu_webhook_secret

# Server
PORT=3000
BASE_URL=https://seu-dominio.com
```

### 2. Banco de Dados

```bash
# Aplicar schema ao banco
npm run db:push

# Ou usar migrações
npm run db:migrate
```

### 3. Executar

```bash
# Desenvolvimento
npm run dev

# Produção
npm run build
npm start
```

## 💻 Comandos

### `/product create`
Cria um novo produto.

**Parâmetros:**
- `nome` - Nome do produto
- `descricao` - Descrição (opcional)
- `preco_brl` - Preço em Reais
- `preco_usd` - Preço em Dólares
- `download_url` - URL de download (opcional)
- `repositorio_url` - URL do repositório (opcional)

### `/product list`
Lista todos os produtos ativos.

### `/product show <produto>`
Exibe o produto com botões de pagamento.

### `/product delete <produto>`
Desativa um produto.

## 🔗 Webhooks

Configure as URLs nos painéis do Mercado Pago e Stripe:

- **Mercado Pago:** `https://seu-dominio.com/webhook/mercadopago`
- **Stripe:** `https://seu-dominio.com/webhook/stripe`

## 📊 Modelos de Dados

### User
Armazena informações dos compradores.

### Product
Catálogo de produtos digitais.

### Order
Registro de transações com status de pagamento.

### WebhookLog
Log de eventos para auditoria.

## 🔒 Segurança

- Validação de assinatura em webhooks
- Comandos restritos a administradores
- Tokens e secrets em variáveis de ambiente
