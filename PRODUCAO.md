# 🚀 Guia de Produção — Bot Gateway

Guia completo para colocar seu bot de vendas em produção com segurança.

---

## 1. 🔑 Troca de Credenciais (Tokens de Produção)

### Discord
| Variável | Valor |
|----------|-------|
| `DISCORD_TOKEN` | Token do bot de **produção** (Developer Portal → Bot → Reset Token) |
| `DISCORD_CLIENT_ID` | ID do aplicativo de produção |
| `VIP_ROLE_ID` | ID do cargo "Cliente VIP" no seu servidor real |

### Banco de Dados (Supabase)
| Variável | Valor |
|----------|-------|
| `DATABASE_URL` | URL de conexão do banco **de produção** |

> ⚠️ **Importante:** Crie um banco separado para produção. Nunca use o mesmo banco de testes.

### Mercado Pago
| Variável | Valor |
|----------|-------|
| `MERCADO_PAGO_ACCESS_TOKEN` | Access Token **de produção** (Painel MP → Desenvolvedores → Credenciais, modo Produção) |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Secret do webhook (e ativar modo produção) |

### Stripe
| Variável | Valor |
|----------|-------|
| `STRIPE_SECRET_KEY` | Chave **de produção** (começa com `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Secret do webhook de produção |

> ⚠️ **Nunca** use chaves de teste (`sk_test_`, `APP_USR` de teste) em produção.

---

## 2. 🌐 Deploy do Servidor (Onde rodar)

O bot NÃO deve rodar no seu computador. Use um serviço de hospedagem:

### Opção 1: **Railway** (recomendado - fácil)
1. Crie conta em [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Configure as variáveis de ambiente (painel → Variables)
4. Adicione um domínio público (Settings → Networking → Generate Domain)
5. O Railway mantém o bot rodando 24/7

### Opção 2: **Render**
1. Crie conta em [render.com](https://render.com)
2. New Web Service → conecte seu repositório GitHub
3. Build Command: `npm install && npx prisma generate`
4. Start Command: `npm start`
5. Configure as variáveis de ambiente
6. O Render dá um domínio `https://seu-bot.onrender.com`

### Opção 3: **VPS (Digital Ocean, AWS, etc.)**
1. Crie um servidor Ubuntu
2. Instale Node.js 20+ e PostgreSQL
3. Clone o repositório
4. Rode `npm install && npm run build && npm start`
5. Use **PM2** para manter o processo vivo: `pm2 start dist/index.js --name bot`
6. Use **Nginx** como reverse proxy

---

## 3. 🌐 Trocar o ngrok por domínio real

Em produção, **não use ngrok**. Seu servidor já terá domínio público (ex: `https://seu-bot.onrender.com`).

Atualize o `BASE_URL` no `.env`:
```env
BASE_URL=https://seu-bot.onrender.com
```

### No Mercado Pago (painel):
- **URL de Webhook:** `https://seu-bot.onrender.com/webhook/mercadopago`
- Lembre de configurar com o modo **Produção** ativo

### No Stripe (painel):
- **URL de Webhook:** `https://seu-bot.onrender.com/webhook/stripe`
- Adicione os eventos: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`

---

## 4. 🗄️ Banco de Dados (Supabase)

1. Crie um **novo projeto** no Supabase para produção
2. Obtenha a `DATABASE_URL` em Settings → Database → Connection string
3. Rode as migrações:
```bash
npx prisma db push
```

---

## 5. 🚀 Build e Deploy

```bash
# Build do TypeScript
npm run build

# O pacote "start" já roda dist/index.js
npm start
```

---

## 6. 🔒 Checklist de Segurança

- [ ] `MERCADO_PAGO_WEBHOOK_SECRET` configurado (validação de assinatura ativa)
- [ ] Comandos restritos a Administradores (já implementado)
- [ ] **HTTPS** ativo no domínio (Railway/Render dão automaticamente)
- [ ] Nenhum segredo commitado no GitHub (`.env` no `.gitignore`)
- [ ] Cargo VIP criado e `VIP_ROLE_ID` correto
- [ ] Bot tem permissão de `Manage Roles` e `Send Messages` em DM

---

## 7. 🧪 Teste Final em Produção

1. Use `/product create` para criar um produto real
2. Use `/product show` para exibir o produto
3. Faça um pagamento PIX de **R$ 0,50** para testar
4. Verifique se:
   - ✅ O QR Code aparece
   - ✅ O webhook chega no servidor (logs)
   - ✅ O cargo VIP é atribuído
   - ✅ O cliente recebe a DM com o produto

---

## 8. 📊 Monitoramento

Melhorias recomendadas (posso implementar):
- Sistema de logs persistidos (arquivo)
- Dashboard simples de vendas
- Alertas no Discord quando uma venda ocorrer
- Backup automático do banco