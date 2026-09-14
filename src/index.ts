import { config } from 'dotenv';
config();

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction, AttachmentBuilder } from 'discord.js';
import express, { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { MercadoPagoConfig, Payment, Preference } from 'mercadopago';
import QRCode from 'qrcode';
import { PrismaClient, PaymentGateway, OrderStatus } from '@prisma/client';

// ==================== PRISMA CLIENT ====================
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// ==================== LOGGER ====================
const logger = {
  info: (message: string, ...args: any[]) => console.log(`[${new Date().toISOString()}] INFO: ${message}`, ...args),
  error: (message: string, error?: any) => console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error || ''),
  warn: (message: string, ...args: any[]) => console.warn(`[${new Date().toISOString()}] WARN: ${message}`, ...args)
};

// ==================== STRIPE CLIENT ====================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });

// ==================== MERCADO PAGO CLIENT ====================
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN! });
const mpPayment = new Payment(mpClient);
const mpPreference = new Preference(mpClient);

// ==================== DISCORD CLIENT ====================
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages]
});

// ==================== EXPRESS SERVER ====================
const app = express();
const PORT = process.env.PORT || 3000;

// Aplicar JSON global (o Stripe usará o raw body na própria rota)
app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ==================== WEBHOOK: STRIPE ====================
// Usar express.raw() APENAS nesta rota para preservar o body bruto (necessário para validar a assinatura)
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    // O body chega como Buffer (raw). Converter para string é o formato que o Stripe espera
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    logger.info(`Stripe Event: ${event.type}`);
  } catch (err) {
    logger.error('Stripe signature validation failed:', err);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    await prisma.webhookLog.create({
      data: { gateway: 'STRIPE', eventType: event.type, orderId: (event.data.object as any)?.id || null, payload: event.data.object as any, processed: false }
    });

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.id;
      const discordUserId = session.metadata?.discordUserId;
      const productId = session.metadata?.productId;

      if (!discordUserId || !productId) {
        logger.error('Missing metadata in checkout session');
        return res.status(200).json({ received: true });
      }

      const user = await prisma.user.upsert({
        where: { discordId: discordUserId },
        update: { lastPurchaseAt: new Date() },
        create: { discordId: discordUserId, email: session.customer_details?.email }
      });

      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) throw new Error('Product not found');

      const order = await prisma.order.create({
        data: { gatewayOrderId: orderId, gateway: 'STRIPE', userId: user.id, productId: product.id, amount: (session.amount_total || 0) / 100, currency: session.currency?.toUpperCase() || 'USD', status: 'PAID', checkoutUrl: session.url },
        include: { product: true, user: true }
      });

      await fulfillOrder(order);
    }

    await prisma.webhookLog.updateMany({ where: { eventType: event.type }, data: { processed: true } });
    return res.status(200).json({ received: true, eventType: event.type });
  } catch (error) {
    logger.error('Stripe webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== WEBHOOK: MERCADO PAGO ====================
// Função para validar a assinatura do webhook do Mercado Pago
function validateMPSignature(req: Request, body: string): boolean {
  const signature = req.headers['x-signature'] as string;
  const requestId = req.headers['x-request-id'] as string;
  
  // Se não houver secret configurado, pular validação (modo dev)
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('MERCADO_PAGO_WEBHOOK_SECRET não configurado, pulando validação');
    return true;
  }
  
  // Mercado Pago usa HMAC-SHA256 com o secret
  const crypto = require('crypto');
  const parts = (signature || '').split(',');
  const tsPart = parts.find(p => p.startsWith('ts='));
  const hashPart = parts.find(p => p.startsWith('v1='));
  
  if (!tsPart || !hashPart) return false;
  
  const ts = tsPart.replace('ts=', '');
  const receivedHash = hashPart.replace('v1=', '');
  const manifest = `id:${(JSON.parse(body).data?.id || '')};request-id:${requestId};ts:${ts};`;
  const expectedHash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  
  return receivedHash === expectedHash;
}

app.post('/webhook/mercadopago', async (req: Request, res: Response) => {
  try {
    // Obter o body como string (para validação e parse)
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') 
      : typeof req.body === 'string' ? req.body 
      : JSON.stringify(req.body);
    
    // Validar assinatura (com warn em vez de block em caso de falha, para não perder webhooks no dev)
    if (!validateMPSignature(req, rawBody)) {
      logger.warn('⚠️ Assinatura inválida no webhook do Mercado Pago');
      // Em produção, descomente a linha abaixo para rejeitar:
      // return res.status(401).json({ error: 'Invalid signature' });
    }

    const body = JSON.parse(rawBody);
    logger.info('MP Webhook:', JSON.stringify(body));

    if (body.type !== 'payment' || !body.data?.id) {
      return res.status(200).json({ received: true });
    }

    const paymentId = body.data.id;
    await prisma.webhookLog.create({
      data: { gateway: 'MERCADO_PAGO', eventType: body.type, orderId: String(paymentId), payload: body, processed: false }
    });

    const payment = await mpPayment.get({ id: paymentId });
    logger.info(`MP Payment Status: ${payment.status}`);

    if (payment.status === 'approved') {
      const order = await prisma.order.findUnique({
        where: { gatewayOrderId: String(paymentId) },
        include: { product: true, user: true }
      });

      if (order && order.status !== 'PAID' && order.status !== 'DELIVERED') {
        await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
        await fulfillOrder(order);
      }
    } else if (payment.status === 'cancelled' || payment.status === 'expired') {
      await prisma.order.updateMany({
        where: { gatewayOrderId: String(paymentId) },
        data: { status: payment.status === 'expired' ? 'EXPIRED' : 'CANCELLED' }
      });
    }

    await prisma.webhookLog.updateMany({ where: { orderId: String(paymentId) }, data: { processed: true } });
    return res.status(200).json({ success: true, paymentId });
  } catch (error) {
    logger.error('MP webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ==================== FULFILLMENT ====================
async function fulfillOrder(order: any) {
  try {
    // IDEMPOTÊNCIA: Verificar se já foi entregue (evita duplicar entrega)
    if (order.status === 'DELIVERED') {
      logger.info(`Order ${order.id} already delivered, skipping...`);
      return;
    }

    logger.info(`Fulfilling order ${order.id} for user ${order.user.discordId}`);

    await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await prisma.user.update({ where: { id: order.userId }, data: { totalPurchases: { increment: 1 }, totalSpent: { increment: order.amount }, lastPurchaseAt: new Date() } });

    // Assign VIP role
    const vipRoleId = process.env.VIP_ROLE_ID;
    if (vipRoleId && order.discordGuildId) {
      try {
        const guild = await discordClient.guilds.fetch(order.discordGuildId);
        const member = await guild.members.fetch(order.user.discordId);
        if (member && !member.roles.cache.has(vipRoleId)) {
          await member.roles.add(vipRoleId, 'Purchase completed');
          logger.info(`VIP role assigned to ${order.user.discordId}`);
        }
      } catch (e) {
        logger.error('Failed to assign VIP role:', e);
      }
    }

    // Send DM
    try {
      const user = await discordClient.users.fetch(order.user.discordId);
      if (user) {
        let message = `🎉 **Thanks for your purchase!**\n\n📦 **Product:** ${order.product.name}\n💰 **Amount:** ${order.currency === 'BRL' ? 'R$' : '$'}${order.amount}\n\n`;
        if (order.product.downloadUrl) message += `📥 **Download:** ${order.product.downloadUrl}\n`;
        if (order.product.repositoryUrl) message += `🔗 **Repository:** ${order.product.repositoryUrl}\n`;
        if (order.product.licenseKeyTemplate) {
          const licenseKey = generateLicenseKey(order.product.licenseKeyTemplate);
          message += `🔑 **License Key:** \`${licenseKey}\`\n`;
        }
        message += `\n✅ You now have the **VIP** role!`;
        await user.send(message);
        logger.info(`DM sent to ${order.user.discordId}`);
      }
    } catch (e) {
      logger.error('Failed to send DM:', e);
    }

    logger.info(`Order ${order.id} fulfilled successfully`);
  } catch (error) {
    logger.error(`Fulfillment error for order ${order.id}:`, error);
    throw error;
  }
}

function generateLicenseKey(template: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return template.replace(/X/g, () => chars.charAt(Math.floor(Math.random() * chars.length)));
}

// ==================== PAYMENT SERVICES ====================
async function createPixPayment(productId: string, discordUserId: string, userEmail: string, discordGuildId?: string) {
  const product = await prisma.product.findUnique({ where: { id: productId, isActive: true } });
  if (!product) throw new Error('Product not found');
  if (product.stock !== null && product.stock <= 0) throw new Error('Product out of stock');

  const user = await prisma.user.upsert({
    where: { discordId: discordUserId },
    update: { email: userEmail },
    create: { discordId: discordUserId, email: userEmail }
  });

  const payment = await mpPayment.create({
    body: {
      transaction_amount: Number(product.priceBRL),
      description: product.name,
      payment_method_id: 'pix',
      payer: { email: userEmail },
      notification_url: `${process.env.BASE_URL}/webhook/mercadopago`,
      metadata: { discord_user_id: discordUserId, product_id: productId, email: userEmail }
    }
  });

  const pixCode = payment.point_of_interaction?.transaction_data?.qr_code || '';
  const qrCodeBase64 = payment.point_of_interaction?.transaction_data?.qr_code_base64 || '';
  const pixQrCode = qrCodeBase64 || (pixCode ? await QRCode.toDataURL(pixCode) : '');

  await prisma.order.create({
    data: {
      gatewayOrderId: String(payment.id), gateway: 'MERCADO_PAGO', userId: user.id, productId: product.id,
      amount: product.priceBRL, currency: 'BRL', status: 'PENDING', pixCode, pixQrCode,
      discordGuildId, expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    }
  });

  return { orderId: String(payment.id), pixCode, pixQrCode, expiresAt: new Date(Date.now() + 30 * 60 * 1000) };
}

async function createStripeCheckout(productId: string, discordUserId: string, discordGuildId?: string) {
  const product = await prisma.product.findUnique({ where: { id: productId, isActive: true } });
  if (!product) throw new Error('Product not found');
  if (product.stock !== null && product.stock <= 0) throw new Error('Product out of stock');

  const user = await prisma.user.upsert({
    where: { discordId: discordUserId },
    update: {},
    create: { discordId: discordUserId }
  });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: product.name, description: product.description || undefined },
        unit_amount: Math.round(Number(product.priceUSD) * 100),
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/cancel`,
    metadata: { discordUserId, productId, discordGuildId: discordGuildId || '' },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });

  await prisma.order.create({
    data: {
      gatewayOrderId: session.id, gateway: 'STRIPE', userId: user.id, productId: product.id,
      amount: product.priceUSD, currency: 'USD', status: 'PENDING', checkoutUrl: session.url,
      discordGuildId, expiresAt: new Date(Date.now() + 30 * 60 * 1000)
    }
  });

  return { checkoutUrl: session.url!, sessionId: session.id };
}

// ==================== DISCORD COMMANDS ====================
const commands = [
  new SlashCommandBuilder()
    .setName('product')
    .setDescription('Product management commands')
    .addSubcommand(sub => sub.setName('list').setDescription('List all products'))
    .addSubcommand(sub => sub.setName('show').setDescription('Show product for sale').addStringOption(opt => opt.setName('name').setDescription('Product name').setRequired(true)))
    .addSubcommand(sub => sub.setName('create').setDescription('Create a new product')
      .addStringOption(opt => opt.setName('name').setDescription('Product name').setRequired(true))
      .addNumberOption(opt => opt.setName('price_brl').setDescription('Price in BRL').setRequired(true))
      .addNumberOption(opt => opt.setName('price_usd').setDescription('Price in USD').setRequired(true))
      .addStringOption(opt => opt.setName('description').setDescription('Product description'))
      .addStringOption(opt => opt.setName('download_url').setDescription('Download URL'))
      .addStringOption(opt => opt.setName('repository_url').setDescription('Repository URL')))
    .addSubcommand(sub => sub.setName('delete').setDescription('Delete a product').addStringOption(opt => opt.setName('name').setDescription('Product name').setRequired(true)))
    .addSubcommand(sub => sub.setName('orders').setDescription('List all orders'))
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });
    logger.info('✅ Slash commands registered');
  } catch (error) {
    logger.error('Failed to register commands:', error);
  }
}

// ==================== INTERACTION HANDLER ====================
discordClient.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ You need administrator permissions.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'product') {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'list') {
          const products = await prisma.product.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
          if (products.length === 0) {
            await interaction.reply({ content: '📭 No products found.', ephemeral: true });
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle('📦 Product List')
            .setColor(0x5865F2)
            .setDescription(products.map((p, i) => `${i + 1}. **${p.name}** - R$ ${Number(p.priceBRL).toFixed(2)} / $ ${Number(p.priceUSD).toFixed(2)}\n   ID: \`${p.id}\``).join('\n\n'));
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (subcommand === 'orders') {
          const orders = await prisma.order.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { product: true, user: true }
          });

          if (orders.length === 0) {
            await interaction.reply({ content: '📭 No orders found.', ephemeral: true });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle('📋 Últimos Pedidos')
            .setColor(0x5865F2)
            .setDescription(orders.map((o, i) => {
              const statusEmoji: Record<string, string> = {
                PENDING: '⏳', PAID: '💰', DELIVERED: '✅', CANCELLED: '❌', EXPIRED: '⏰', REFUNDED: '💸', FAILED: '⚠️'
              };
              return `${i + 1}. ${statusEmoji[o.status] || '❓'} **${o.product?.name}**\n`
                + `   👤 ${o.user.discordId} | ${o.gateway === 'MERCADO_PAGO' ? '🇧🇷 PIX' : '🌎 Card'}\n`
                + `   💰 ${o.currency === 'BRL' ? 'R$' : '$'} ${Number(o.amount).toFixed(2)} | Status: **${o.status}**\n`
                + `   🕐 ${o.createdAt.toISOString().slice(0, 16)}`;
            }).join('\n\n'))
            .setFooter({ text: 'Mostrando os 10 pedidos mais recentes' });

          await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (subcommand === 'show') {
          const name = interaction.options.getString('name')!;
          const product = await prisma.product.findFirst({ where: { name: { contains: name, mode: 'insensitive' }, isActive: true } });
          if (!product) {
            await interaction.reply({ content: '❌ Product not found.', ephemeral: true });
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle(product.name)
            .setDescription(product.description || 'No description')
            .setColor(0x5865F2)
            .addFields(
              { name: '💰 PIX Price', value: `R$ ${Number(product.priceBRL).toFixed(2)}`, inline: true },
              { name: '💳 Card Price', value: `$ ${Number(product.priceUSD).toFixed(2)}`, inline: true }
            );
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`pay_pix_${product.id}`).setLabel('Pay with PIX 🇧🇷').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`pay_card_${product.id}`).setLabel('Pay with Card 🌎').setStyle(ButtonStyle.Primary)
          );
          await interaction.reply({ embeds: [embed], components: [row] });
        }

        if (subcommand === 'create') {
          const name = interaction.options.getString('name')!;
          const priceBRL = interaction.options.getNumber('price_brl')!;
          const priceUSD = interaction.options.getNumber('price_usd')!;
          const description = interaction.options.getString('description');
          const downloadUrl = interaction.options.getString('download_url');
          const repositoryUrl = interaction.options.getString('repository_url');

          const existing = await prisma.product.findFirst({ where: { name } });
          if (existing) {
            await interaction.reply({ content: '❌ A product with this name already exists.', ephemeral: true });
            return;
          }

          const product = await prisma.product.create({
            data: { name, description, priceBRL, priceUSD, downloadUrl, repositoryUrl }
          });
          await interaction.reply({ content: `✅ Product **${product.name}** created!\nID: \`${product.id}\``, ephemeral: true });
        }

        if (subcommand === 'delete') {
          const name = interaction.options.getString('name')!;
          const product = await prisma.product.findFirst({ where: { name: { contains: name, mode: 'insensitive' } } });
          if (!product) {
            await interaction.reply({ content: '❌ Product not found.', ephemeral: true });
            return;
          }
          await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });
          await interaction.reply({ content: `✅ Product **${product.name}** deactivated.`, ephemeral: true });
        }
      }
    }

    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (customId.startsWith('pay_pix_')) {
        const productId = customId.replace('pay_pix_', '');

        // Buscar email salvo do usuário (se houver)
        const existingUser = await prisma.user.findUnique({
          where: { discordId: interaction.user.id }
        });

        // Abrir modal para coletar email
        const modal = new ModalBuilder()
          .setCustomId(`pix_email_${productId}`)
          .setTitle('💳 Pagamento PIX - Seu Email');

        const emailInput = new TextInputBuilder()
          .setCustomId('email')
          .setLabel('Digite seu email para o PIX')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('exemplo@email.com')
          .setRequired(true)
          .setValue(existingUser?.email || '');

        const emailRow = new ActionRowBuilder<TextInputBuilder>().addComponents(emailInput);

        modal.addComponents(emailRow);

        await interaction.showModal(modal);
      }

      if (customId.startsWith('pay_card_')) {
        await interaction.deferReply({ ephemeral: true });
        const productId = customId.replace('pay_card_', '');
        try {
          const result = await createStripeCheckout(productId, interaction.user.id, interaction.guildId || undefined);
          const product = await prisma.product.findUnique({ where: { id: productId } });
          const embed = new EmbedBuilder()
            .setTitle('💳 Stripe Checkout Generated')
            .setDescription(`**Product:** ${product?.name}\n**Price:** $ ${Number(product?.priceUSD).toFixed(2)}\n\nClick the button below to complete your purchase:`)
            .setColor(0x635BFF)
            .setFooter({ text: `Session expires in 30 minutes • ID: ${result.sessionId}` });
          const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setLabel('Pay with Stripe 🌎').setStyle(ButtonStyle.Link).setURL(result.checkoutUrl)
          );
          await interaction.editReply({ embeds: [embed], components: [button] });
        } catch (error: any) {
          await interaction.editReply({ content: `❌ Error: ${error.message}` });
        }
      }
    }

    // ====== MODAL: Coletar Email para PIX ======
    if (interaction.isModalSubmit() && interaction.customId.startsWith('pix_email_')) {
      const productId = interaction.customId.replace('pix_email_', '');
      const email = interaction.fields.getTextInputValue('email').trim();

      // Validar formato do email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        await interaction.reply({
          content: '❌ Email inválido. Tente novamente clicando no botão PIX.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await createPixPayment(productId, interaction.user.id, email, interaction.guildId || undefined);
        const product = await prisma.product.findUnique({ where: { id: productId } });

        // Processar o base64 do QR Code: o Mercado Pago retorna sem o prefixo "data:image/png;base64,"
        let qrBuffer: Buffer;
        if (result.pixQrCode.startsWith('data:image')) {
          // Se tiver o prefixo data:image, extrair só o base64
          qrBuffer = Buffer.from(result.pixQrCode.split(',')[1], 'base64');
        } else {
          // Se for base64 "cru", converter direto
          qrBuffer = Buffer.from(result.pixQrCode, 'base64');
        }

        // Criar attachment (arquivo PNG) a partir do buffer
        const qrAttachment = new AttachmentBuilder(qrBuffer, { name: 'pix-qrcode.png' });

        // Embed com a imagem referenciando o attachment
        const embed = new EmbedBuilder()
          .setTitle('💳 Pagamento PIX Gerado')
          .setDescription(`**Produto:** ${product?.name}\n**Valor:** R$ ${Number(product?.priceBRL).toFixed(2)}\n\nEscaneie o QR Code abaixo ou copie o código Copia e Cola:`)
          .setColor(0x00D26A)
          .setImage('attachment://pix-qrcode.png')
          .addFields({ name: '📋 Código Copia e Cola', value: `\`\`\`\n${result.pixCode}\n\`\`\`` })
          .setFooter({ text: `Expira em 30 minutos • Pedido: ${result.orderId}` });

        await interaction.editReply({ embeds: [embed], files: [qrAttachment] });
      } catch (error: any) {
        logger.error('PIX payment error:', error);
        await interaction.editReply({ content: `❌ Erro ao gerar PIX: ${error.message}` });
      }
    }
  } catch (error) {
    logger.error('Interaction error:', error);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
    }
  }
});

// ==================== START ====================
async function start() {
  try {
    // Start Express server
    app.listen(PORT, () => {
      logger.info(`🚀 Express server running on port ${PORT}`);
      logger.info(`📡 Webhooks available at:`);
      logger.info(`   - POST /webhook/mercadopago`);
      logger.info(`   - POST /webhook/stripe`);
    });

    // Login Discord bot
    await discordClient.login(process.env.DISCORD_TOKEN!);
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

discordClient.once('ready', async () => {
  logger.info(`🤖 Bot logged in as ${discordClient.user?.tag}`);
  await registerCommands();
});

// Error handlers
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

start();
