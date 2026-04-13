# Recantos da Serra — Central da Equipe: Plano 1 — Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar o repositório Next.js 14 PWA `recantos-central-equipe`, configurar autenticação completa (email+senha, SMS Twilio, Google OAuth), aplicar as migrations do banco de dados com todos os novos modelos, e ter o app em produção no Railway com roteamento protegido por papel.

**Architecture:** App Next.js 14 (App Router) separado, rodando em `app.recantosdaserra.com`, que consome o backend Express existente em `sitiorecantodosipes.com` via API REST. A autenticação do staff usa NextAuth.js conectado a um novo endpoint Express `/api/staff/auth`. O banco PostgreSQL é o mesmo já existente no Railway — apenas adicionamos novas tabelas via Prisma migration.

**Tech Stack:** Next.js 14 (App Router), NextAuth.js v5, Tailwind CSS, Prisma 5 (shared schema), Twilio Verify API, bcryptjs, TypeScript, Railway, Web Push (fase seguinte — service worker criado aqui mas notificações no Plano 3)

---

## Pré-requisitos

- Acesso ao repositório do site atual (`sitiorecantodosipes.com`) para rodar migrations
- `DATABASE_URL` do Railway (mesmo banco)
- Conta Twilio com Verify Service criado (veja Task 2)
- Cloudinary configurado (já feito — credenciais no plano master)
- Google OAuth Client ID/Secret (mesmo do Express — reutilizar ou criar novo para o app de gestão)

---

## Estrutura de Arquivos

### Novo repositório: `recantos-central-equipe`

```
recantos-central-equipe/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── primeiro-acesso/page.tsx
│   ├── (admin)/
│   │   ├── layout.tsx                  ← guard: só ADMIN
│   │   ├── page.tsx                    ← dashboard global
│   │   ├── reservas/page.tsx
│   │   ├── calendario/page.tsx
│   │   ├── financeiro/page.tsx
│   │   ├── vistorias/page.tsx
│   │   ├── tarefas/page.tsx
│   │   ├── equipe/page.tsx
│   │   ├── manutencao/page.tsx
│   │   ├── feedbacks/page.tsx
│   │   ├── hospedes/page.tsx
│   │   ├── precos/page.tsx
│   │   └── ia/page.tsx
│   ├── (casa)/
│   │   ├── layout.tsx                  ← guard: ADMIN | GUARDIA
│   │   ├── page.tsx
│   │   ├── calendario/page.tsx
│   │   ├── vistoria/[id]/page.tsx
│   │   └── tarefas/page.tsx
│   ├── (piscina)/
│   │   ├── layout.tsx                  ← guard: ADMIN | PISCINEIRO
│   │   ├── page.tsx
│   │   ├── calendario/page.tsx
│   │   ├── manutencao/page.tsx
│   │   ├── chamado/page.tsx
│   │   └── programacao/page.tsx
│   ├── (hospede)/
│   │   ├── layout.tsx                  ← guard: HOSPEDE
│   │   ├── page.tsx
│   │   └── [id]/page.tsx
│   ├── perfil/page.tsx
│   ├── notificacoes/page.tsx
│   ├── api/
│   │   └── auth/[...nextauth]/route.ts
│   ├── layout.tsx                      ← root layout, PWA meta tags
│   └── page.tsx                        ← redirect para /login
├── components/
│   ├── shared/
│   │   ├── FontSizeProvider.tsx        ← context para tamanho de fonte
│   │   ├── BottomNav.tsx               ← navegação mobile por papel
│   │   ├── PageHeader.tsx
│   │   └── LoadingSpinner.tsx
│   ├── auth/
│   │   ├── LoginForm.tsx
│   │   ├── SmsVerifyForm.tsx
│   │   └── FontSizePicker.tsx
│   └── admin/
│       └── (vazio — preenchido no Plano 2)
├── lib/
│   ├── auth.ts                         ← NextAuth config
│   ├── api.ts                          ← fetch wrapper para o Express
│   └── fonts.ts                        ← mapeamento SM/MD/LG/XL → classes Tailwind
├── middleware.ts                       ← protege rotas por papel
├── public/
│   ├── manifest.json                   ← PWA manifest
│   ├── icon-192.png                    ← ícone PWA (gerar do logo)
│   ├── icon-512.png
│   └── sw.js                           ← service worker (push — ativo no Plano 3)
├── next.config.js
├── tailwind.config.ts
├── tsconfig.json
├── .env.local.example
└── package.json
```

### Modificações no repositório Express existente

```
prisma/schema.prisma          ← 14 novos models adicionados
routes/staff-auth.js          ← POST /api/staff/auth/login + /verify-sms + /me
server.js                     ← registrar router staff-auth
.env.example                  ← adicionar TWILIO_* + CLOUDINARY_* vars
```

---

## Task 1: Setup Twilio Verify (pré-requisito, 5 min)

**Objetivo:** Criar um Verify Service no Twilio para envio de SMS de verificação.

**Files:** nenhum (configuração externa)

- [ ] **1.1** Acesse [console.twilio.com](https://console.twilio.com) → login com conta Twilio (ou criar conta gratuita)

- [ ] **1.2** No menu lateral: **Verify → Services → Create new Service**
  - Service Name: `Recantos da Serra`
  - Deixar Code Length: 6
  - Clicar **Create**

- [ ] **1.3** Anote o **Service SID** (começa com `VA...`)

- [ ] **1.4** No painel principal do Twilio, anote:
  - **Account SID** (começa com `AC...`)
  - **Auth Token**

- [ ] **1.5** Guarde as 3 variáveis — usadas na Task 4:
  ```
  TWILIO_ACCOUNT_SID=ACxxxx
  TWILIO_AUTH_TOKEN=xxxx
  TWILIO_VERIFY_SID=VAxxxx
  ```

---

## Task 2: Prisma Schema — Novos Modelos

**Objetivo:** Adicionar os 14 novos modelos ao schema Prisma do Express existente e rodar a migration.

**Files:**
- Modify: `prisma/schema.prisma` (repositório Express)

- [ ] **2.1** No repositório do Express, abrir `prisma/schema.prisma` e adicionar ao final:

```prisma
// ─── MULTI-PROPERTY ────────────────────────────────────────────────────────

model Property {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  type        PropertyType @default(SITIO)
  address     String?
  city        String?
  state       String?
  hasPool     Boolean  @default(false)
  icalAirbnb  String?
  icalBookingCom String?
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())

  cabins      Cabin[]
  bookings    Booking[]          @relation("PropertyBookings")
  staff       StaffPropertyAssignment[]
  inspections InspectionReport[]
  maintenance MaintenanceLog[]
  tickets     ServiceTicket[]
  schedules   MaintenanceSchedule[]
  pricing     SeasonalPricing[]  @relation("PropertyPricing")
  suggestions PricingSuggestion[]
}

enum PropertyType {
  SITIO
  CABANA_COMPLEX
  CABANA
}

model Cabin {
  id          String   @id @default(cuid())
  propertyId  String
  property    Property @relation(fields: [propertyId], references: [id])
  name        String
  slug        String
  capacity    Int      @default(2)
  description String?
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())

  bookings    Booking[] @relation("CabinBookings")
}

// ─── STAFF ──────────────────────────────────────────────────────────────────

model StaffMember {
  id                  String     @id @default(cuid())
  name                String
  email               String?    @unique
  phone               String?    @unique
  passwordHash        String?
  googleId            String?    @unique
  role                StaffRole
  fontSizePreference  FontSize   @default(MD)
  firstLoginDone      Boolean    @default(false)
  pushSubscription    Json?
  active              Boolean    @default(true)
  createdAt           DateTime   @default(now())
  updatedAt           DateTime   @updatedAt

  properties          StaffPropertyAssignment[]
  inspections         InspectionReport[]
  maintenanceLogs     MaintenanceLog[]
  tickets             ServiceTicket[]
  tasksAssigned       StaffTask[]  @relation("TaskAssignee")
  tasksCreated        StaffTask[]  @relation("TaskCreator")
  notifications       PushNotification[]
  pricingApprovals    PricingSuggestion[]
}

enum StaffRole {
  ADMIN
  GUARDIA
  PISCINEIRO
}

enum FontSize {
  SM
  MD
  LG
  XL
}

model StaffPropertyAssignment {
  id         String      @id @default(cuid())
  staffId    String
  staff      StaffMember @relation(fields: [staffId], references: [id])
  propertyId String
  property   Property    @relation(fields: [propertyId], references: [id])
  createdAt  DateTime    @default(now())

  @@unique([staffId, propertyId])
}

// ─── INSPECTION REPORTS ─────────────────────────────────────────────────────

model InspectionReport {
  id              String         @id @default(cuid())
  bookingId       String
  booking         Booking        @relation(fields: [bookingId], references: [id])
  propertyId      String
  property        Property       @relation(fields: [propertyId], references: [id])
  staffId         String
  staff           StaffMember    @relation(fields: [staffId], references: [id])
  type            InspectionType
  status          InspectionStatus @default(DRAFT)
  signatureDataUrl String?        @db.Text
  submittedAt     DateTime?
  notes           String?        @db.Text
  createdAt       DateTime       @default(now())

  items           InspectionItem[]
  photos          InspectionPhoto[]
}

enum InspectionType {
  PRE_CHECKIN
  CHECKOUT
}

enum InspectionStatus {
  DRAFT
  SUBMITTED
}

model InspectionItem {
  id                  String          @id @default(cuid())
  reportId            String
  report              InspectionReport @relation(fields: [reportId], references: [id])
  category            String
  description         String
  status              ItemStatus      @default(NAO_VERIFICADO)
  problemDescription  String?
  createdAt           DateTime        @default(now())

  photos              InspectionPhoto[]
}

enum ItemStatus {
  OK
  PROBLEMA
  NAO_VERIFICADO
}

model InspectionPhoto {
  id               String           @id @default(cuid())
  reportId         String
  report           InspectionReport @relation(fields: [reportId], references: [id])
  itemId           String?
  item             InspectionItem?  @relation(fields: [itemId], references: [id])
  cloudinaryPublicId String
  cloudinaryUrl    String
  caption          String?
  takenAt          DateTime         @default(now())
}

// ─── MAINTENANCE ────────────────────────────────────────────────────────────

model MaintenanceLog {
  id             String      @id @default(cuid())
  propertyId     String
  property       Property    @relation(fields: [propertyId], references: [id])
  staffId        String
  staff          StaffMember @relation(fields: [staffId], references: [id])
  visitDate      DateTime
  borderCleaned  Boolean     @default(false)
  coverCleaned   Boolean     @default(false)
  vacuumed       Boolean     @default(false)
  waterTreated   Boolean     @default(false)
  filterCleaned  Boolean     @default(false)
  notes          String?
  photoUrls      Json        @default("[]")
  createdAt      DateTime    @default(now())
}

model ServiceTicket {
  id          String        @id @default(cuid())
  propertyId  String
  property    Property      @relation(fields: [propertyId], references: [id])
  openedById  String
  openedBy    StaffMember   @relation(fields: [openedById], references: [id])
  title       String
  description String        @db.Text
  photoUrls   Json          @default("[]")
  priority    TicketPriority @default(NORMAL)
  status      TicketStatus  @default(ABERTO)
  adminNotes  String?
  resolvedAt  DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
}

enum TicketPriority {
  NORMAL
  URGENTE
}

enum TicketStatus {
  ABERTO
  EM_ANDAMENTO
  RESOLVIDO
}

model MaintenanceSchedule {
  id              String      @id @default(cuid())
  propertyId      String
  property        Property    @relation(fields: [propertyId], references: [id])
  item            String
  frequencyDays   Int
  lastDoneAt      DateTime?
  nextDueAt       DateTime
  alertDaysBefore Int         @default(7)
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
}

// ─── TASKS ──────────────────────────────────────────────────────────────────

model StaffTask {
  id           String      @id @default(cuid())
  assignedToId String
  assignedTo   StaffMember @relation("TaskAssignee", fields: [assignedToId], references: [id])
  assignedById String
  assignedBy   StaffMember @relation("TaskCreator", fields: [assignedById], references: [id])
  bookingId    String?
  title        String
  description  String?
  dueDate      DateTime?
  status       TaskStatus  @default(PENDENTE)
  completedAt  DateTime?
  createdAt    DateTime    @default(now())
}

enum TaskStatus {
  PENDENTE
  FEITO
}

// ─── SURVEY ─────────────────────────────────────────────────────────────────

model Survey {
  id                  String   @id @default(cuid())
  bookingId           String   @unique
  booking             Booking  @relation(fields: [bookingId], references: [id])
  guestEmail          String
  sentAt              DateTime?
  respondedAt         DateTime?
  score               Int?
  comment             String?  @db.Text
  googleReviewLinkSent Boolean @default(false)
  adminAlerted        Boolean  @default(false)
  createdAt           DateTime @default(now())
}

// ─── GUEST REPUTATION ───────────────────────────────────────────────────────

model GuestReputation {
  id            String          @id @default(cuid())
  userId        String          @unique
  user          User            @relation(fields: [userId], references: [id])
  totalStays    Int             @default(0)
  averageScore  Decimal         @default(0) @db.Decimal(3,2)
  totalSpent    Decimal         @default(0) @db.Decimal(10,2)
  reviewsGiven  Int             @default(0)
  incidentCount Int             @default(0)
  score         Int             @default(0)
  tier          ReputationTier  @default(VISITANTE)
  lastUpdatedAt DateTime        @default(now())
}

enum ReputationTier {
  VISITANTE
  AMIGO
  AMIGO_DA_CASA
  VIP
  FAMILIA
}

// ─── PRICING SUGGESTIONS ────────────────────────────────────────────────────

model PricingSuggestion {
  id             String            @id @default(cuid())
  propertyId     String
  property       Property          @relation(fields: [propertyId], references: [id])
  periodStart    DateTime
  periodEnd      DateTime
  currentPrice   Decimal           @db.Decimal(10,2)
  suggestedPrice Decimal           @db.Decimal(10,2)
  reason         String            @db.Text
  status         SuggestionStatus  @default(PENDENTE)
  acceptedById   String?
  acceptedBy     StaffMember?      @relation(fields: [acceptedById], references: [id])
  acceptedAt     DateTime?
  createdAt      DateTime          @default(now())
}

enum SuggestionStatus {
  PENDENTE
  ACEITA
  REJEITADA
}

// ─── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────

model PushNotification {
  id       String      @id @default(cuid())
  staffId  String
  staff    StaffMember @relation(fields: [staffId], references: [id])
  title    String
  body     String
  type     String
  data     Json?
  read     Boolean     @default(false)
  sentAt   DateTime    @default(now())
}
```

- [ ] **2.2** Ainda em `prisma/schema.prisma`, adicionar campos nas tabelas existentes:

```prisma
// No model Booking — adicionar após o campo "source":
  propertyId     String?
  property       Property?  @relation("PropertyBookings", fields: [propertyId], references: [id])
  cabinId        String?
  cabin          Cabin?     @relation("CabinBookings", fields: [cabinId], references: [id])
  surveyStatus   SurveyStatus @default(NAO_ENVIADO)
  survey         Survey?
  inspections    InspectionReport[]

// No model User — adicionar após o campo "updatedAt":
  reputation     GuestReputation?

// No model SeasonalPricing — adicionar após o campo "createdAt":
  propertyId     String?
  property       Property?  @relation("PropertyPricing", fields: [propertyId], references: [id])
```

- [ ] **2.3** Adicionar o enum `SurveyStatus` ao schema:

```prisma
enum SurveyStatus {
  NAO_ENVIADO
  ENVIADO
  RESPONDIDO
}
```

- [ ] **2.4** Rodar a migration no repositório Express:

```bash
cd "Sítio Recanto dos Ipês"
npx prisma migrate dev --name add-management-layer
```
Resultado esperado: `✔  Your database is now in sync with your schema.`

- [ ] **2.5** Verificar que o Prisma Client foi regenerado:

```bash
npx prisma generate
```
Resultado esperado: `✔ Generated Prisma Client`

- [ ] **2.6** Commit no repositório Express:

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add management layer models (staff, inspections, maintenance, surveys, reputation)"
```

---

## Task 3: Express — Endpoint de Auth do Staff

**Objetivo:** Adicionar o endpoint que o NextAuth do app de gestão vai chamar para autenticar membros do staff.

**Files:**
- Create: `routes/staff-auth.js`
- Modify: `server.js`
- Modify: `.env.example`

- [ ] **3.1** Instalar dependências no repositório Express:

```bash
npm install bcryptjs twilio
```

- [ ] **3.2** Criar `routes/staff-auth.js`:

```javascript
const express = require('express');
const bcrypt = require('bcryptjs');
const twilio = require('twilio');
const { z } = require('zod');
const { prisma } = require('../lib/db');

const router = express.Router();

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// POST /api/staff/auth/login — email + senha
router.post('/login', async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos' });
  }

  const { email, password } = parsed.data;

  const staff = await prisma.staffMember.findUnique({
    where: { email },
    include: {
      properties: { include: { property: { select: { id: true, name: true, slug: true } } } },
    },
  });

  if (!staff || !staff.active) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  if (!staff.passwordHash) {
    return res.status(401).json({ error: 'Use outro método de login' });
  }

  const valid = await bcrypt.compare(password, staff.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  return res.json({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    phone: staff.phone,
    role: staff.role,
    fontSizePreference: staff.fontSizePreference,
    firstLoginDone: staff.firstLoginDone,
    properties: staff.properties.map((p) => p.property),
  });
});

// POST /api/staff/auth/send-sms — envia código SMS via Twilio Verify
router.post('/send-sms', async (req, res) => {
  const schema = z.object({ phone: z.string().min(10) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Telefone inválido' });

  const { phone } = parsed.data;

  const staff = await prisma.staffMember.findUnique({ where: { phone } });
  if (!staff || !staff.active) {
    // Retornar 200 mesmo se não encontrado — não revelar existência
    return res.json({ sent: true });
  }

  if (!twilioClient) return res.status(503).json({ error: 'SMS não configurado' });

  await twilioClient.verify.v2
    .services(process.env.TWILIO_VERIFY_SID)
    .verifications.create({ to: phone, channel: 'sms' });

  return res.json({ sent: true });
});

// POST /api/staff/auth/verify-sms — valida código SMS
router.post('/verify-sms', async (req, res) => {
  const schema = z.object({
    phone: z.string().min(10),
    code: z.string().length(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { phone, code } = parsed.data;

  if (!twilioClient) return res.status(503).json({ error: 'SMS não configurado' });

  const check = await twilioClient.verify.v2
    .services(process.env.TWILIO_VERIFY_SID)
    .verificationChecks.create({ to: phone, code });

  if (check.status !== 'approved') {
    return res.status(401).json({ error: 'Código inválido ou expirado' });
  }

  const staff = await prisma.staffMember.findUnique({
    where: { phone },
    include: {
      properties: { include: { property: { select: { id: true, name: true, slug: true } } } },
    },
  });

  if (!staff || !staff.active) {
    return res.status(401).json({ error: 'Acesso não autorizado' });
  }

  return res.json({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    phone: staff.phone,
    role: staff.role,
    fontSizePreference: staff.fontSizePreference,
    firstLoginDone: staff.firstLoginDone,
    properties: staff.properties.map((p) => p.property),
  });
});

// GET /api/staff/auth/me — retorna dados do staff autenticado (pelo ID no header)
router.get('/me', async (req, res) => {
  const staffId = req.headers['x-staff-id'];
  if (!staffId) return res.status(401).json({ error: 'Não autenticado' });

  const staff = await prisma.staffMember.findUnique({
    where: { id: staffId },
    include: {
      properties: { include: { property: { select: { id: true, name: true, slug: true } } } },
    },
  });

  if (!staff || !staff.active) return res.status(401).json({ error: 'Não autenticado' });

  return res.json({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    phone: staff.phone,
    role: staff.role,
    fontSizePreference: staff.fontSizePreference,
    firstLoginDone: staff.firstLoginDone,
    properties: staff.properties.map((p) => p.property),
  });
});

// PATCH /api/staff/auth/font-size — salva preferência de fonte no primeiro acesso
router.patch('/font-size', async (req, res) => {
  const staffId = req.headers['x-staff-id'];
  if (!staffId) return res.status(401).json({ error: 'Não autenticado' });

  const schema = z.object({ fontSize: z.enum(['SM', 'MD', 'LG', 'XL']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Tamanho inválido' });

  await prisma.staffMember.update({
    where: { id: staffId },
    data: { fontSizePreference: parsed.data.fontSize, firstLoginDone: true },
  });

  return res.json({ ok: true });
});

module.exports = router;
```

- [ ] **3.3** Registrar o router em `server.js` — adicionar antes do `app.listen`:

```javascript
const staffAuthRouter = require('./routes/staff-auth');
app.use('/api/staff/auth', staffAuthRouter);
```

- [ ] **3.4** Adicionar ao `.env.example`:

```
# Twilio (SMS verification — staff app)
TWILIO_ACCOUNT_SID="ACxxxx"
TWILIO_AUTH_TOKEN="xxxx"
TWILIO_VERIFY_SID="VAxxxx"

# Cloudinary
CLOUDINARY_CLOUD_NAME="dic99kw8a"
CLOUDINARY_API_KEY="xxxx"
CLOUDINARY_API_SECRET="xxxx"
CLOUDINARY_UPLOAD_PRESET="recanto_reports"

# CORS — staff app origin
STAFF_APP_ORIGIN="https://app.recantosdaserra.com"
```

- [ ] **3.5** Adicionar CORS para o staff app em `server.js` — localizar a configuração do `cors()` e atualizar:

```javascript
const cors = require('cors');
app.use(cors({
  origin: [
    process.env.STAFF_APP_ORIGIN || 'http://localhost:3001',
    // manter origens existentes se houver
  ],
  credentials: true,
}));
```

- [ ] **3.6** Criar o primeiro usuário admin via script (rodar uma vez):

```bash
# No diretório do Express, criar scripts/create-admin.js:
cat > scripts/create-admin.js << 'EOF'
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Criar a propriedade Recanto dos Ipês
  const property = await prisma.property.upsert({
    where: { slug: 'recanto-dos-ipes' },
    update: {},
    create: {
      name: 'Sítio Recanto dos Ipês',
      slug: 'recanto-dos-ipes',
      type: 'SITIO',
      hasPool: true,
      active: true,
    },
  });
  console.log('Propriedade criada:', property.name);

  // Criar admin Andre
  const hash = await bcrypt.hash('trocar-essa-senha-123', 12);
  const admin = await prisma.staffMember.upsert({
    where: { email: 'recantodoipes@gmail.com' },
    update: {},
    create: {
      name: 'Andre',
      email: 'recantodoipes@gmail.com',
      passwordHash: hash,
      role: 'ADMIN',
      active: true,
      firstLoginDone: false,
    },
  });

  await prisma.staffPropertyAssignment.upsert({
    where: { staffId_propertyId: { staffId: admin.id, propertyId: property.id } },
    update: {},
    create: { staffId: admin.id, propertyId: property.id },
  });

  console.log('Admin criado:', admin.name, '— senha inicial: trocar-essa-senha-123');
}

main().catch(console.error).finally(() => prisma.$disconnect());
EOF
node scripts/create-admin.js
```

- [ ] **3.7** Commit no repositório Express:

```bash
git add routes/staff-auth.js server.js .env.example scripts/create-admin.js
git commit -m "feat: add staff auth endpoints (email+password, SMS, font-size preference)"
```

---

## Task 4: Criar Repositório Next.js PWA

**Objetivo:** Scaffold do app Next.js 14 com TypeScript, Tailwind, NextAuth, PWA manifest e estrutura de pastas.

**Files:** todos os arquivos do novo repositório

- [ ] **4.1** Criar o projeto Next.js (fora do repositório Express, em uma pasta irmã):

```bash
cd "Claude Projects"
npx create-next-app@14 recantos-central-equipe \
  --typescript \
  --tailwind \
  --app \
  --no-src-dir \
  --import-alias "@/*"
cd recantos-central-equipe
```

- [ ] **4.2** Instalar dependências:

```bash
npm install next-auth@beta bcryptjs twilio
npm install @types/bcryptjs --save-dev
```

- [ ] **4.3** Criar `.env.local.example`:

```bash
cat > .env.local.example << 'EOF'
# URL do backend Express
NEXT_PUBLIC_API_URL=https://sitiorecantodosipes.com
# (em dev: http://localhost:3000)

# NextAuth
NEXTAUTH_URL=https://app.recantosdaserra.com
NEXTAUTH_SECRET=gerar-com-openssl-rand-base64-32

# Google OAuth (mesmo do Express)
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
EOF
cp .env.local.example .env.local
```

- [ ] **4.4** Criar `next.config.js`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['res.cloudinary.com'],
  },
  // Headers de segurança
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
```

- [ ] **4.5** Criar `public/manifest.json`:

```json
{
  "name": "Recantos da Serra — Central da Equipe",
  "short_name": "Central Recantos",
  "description": "Painel de gestão da equipe Recantos da Serra",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#faf7f2",
  "theme_color": "#5c4033",
  "orientation": "portrait",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

- [ ] **4.6** Criar `public/sw.js` (service worker base — notificações push ativadas no Plano 3):

```javascript
// Service Worker — Recantos da Serra Central da Equipe
// Push notifications são ativadas no Plano 3

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Placeholder para push events (implementado no Plano 3)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: data.data || {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
```

- [ ] **4.7** Criar `lib/fonts.ts`:

```typescript
export type FontSize = 'SM' | 'MD' | 'LG' | 'XL';

export const fontSizeClasses: Record<FontSize, string> = {
  SM: 'text-sm',
  MD: 'text-base',
  LG: 'text-lg',
  XL: 'text-xl',
};

export const fontSizeLabels: Record<FontSize, string> = {
  SM: 'Pequena',
  MD: 'Normal',
  LG: 'Grande',
  XL: 'Extra Grande',
};

export const fontSizeDescriptions: Record<FontSize, string> = {
  SM: 'Para quem prefere ver mais informações na tela',
  MD: 'Tamanho padrão — confortável para a maioria',
  LG: 'Letras maiores, mais fácil de ler',
  XL: 'Letras bem grandes, ideal para quem tem dificuldade visual',
};
```

- [ ] **4.8** Criar `lib/api.ts`:

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface FetchOptions extends RequestInit {
  staffId?: string;
}

export async function apiFetch<T>(
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const { staffId, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (staffId) {
    headers['x-staff-id'] = staffId;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...fetchOptions,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}
```

- [ ] **4.9** Criar estrutura de pastas vazia para as rotas (Next.js App Router):

```bash
mkdir -p app/\(auth\)/login
mkdir -p app/\(auth\)/primeiro-acesso
mkdir -p app/\(admin\)/reservas
mkdir -p app/\(admin\)/calendario
mkdir -p app/\(admin\)/financeiro
mkdir -p app/\(admin\)/vistorias
mkdir -p app/\(admin\)/tarefas
mkdir -p app/\(admin\)/equipe
mkdir -p app/\(admin\)/manutencao
mkdir -p app/\(admin\)/feedbacks
mkdir -p app/\(admin\)/hospedes
mkdir -p app/\(admin\)/precos
mkdir -p app/\(admin\)/ia
mkdir -p app/\(casa\)/calendario
mkdir -p "app/(casa)/vistoria/[id]"
mkdir -p app/\(casa\)/tarefas
mkdir -p app/\(piscina\)/calendario
mkdir -p app/\(piscina\)/manutencao
mkdir -p app/\(piscina\)/chamado
mkdir -p app/\(piscina\)/programacao
mkdir -p "app/(hospede)/[id]"
mkdir -p app/perfil
mkdir -p app/notificacoes
mkdir -p components/shared
mkdir -p components/auth
mkdir -p components/admin
mkdir -p components/casa
mkdir -p components/piscina
```

- [ ] **4.10** Commit:

```bash
git add .
git commit -m "feat: scaffold Next.js PWA with folder structure, manifest, service worker"
```

---

## Task 5: NextAuth — Autenticação Completa

**Objetivo:** Configurar NextAuth.js com três providers: Credentials (email+senha), Credentials (telefone+SMS), e Google OAuth. A sessão contém o papel (role) do usuário.

**Files:**
- Create: `app/api/auth/[...nextauth]/route.ts`
- Create: `lib/auth.ts`

- [ ] **5.1** Criar `lib/auth.ts`:

```typescript
import NextAuth, { type DefaultSession, type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { apiFetch } from './api';

export type StaffRole = 'ADMIN' | 'GUARDIA' | 'PISCINEIRO';
export type FontSize = 'SM' | 'MD' | 'LG' | 'XL';

export interface StaffSession {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  role: StaffRole;
  fontSizePreference: FontSize;
  firstLoginDone: boolean;
  properties: { id: string; name: string; slug: string }[];
}

declare module 'next-auth' {
  interface Session {
    staff: StaffSession;
    defaultSession: DefaultSession;
  }
}

const config: NextAuthConfig = {
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: '/login',
    error: '/login',
  },
  session: { strategy: 'jwt' },
  providers: [
    // Provider 1: Email + senha
    Credentials({
      id: 'credentials-email',
      name: 'Email e Senha',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Senha', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        try {
          const staff = await apiFetch<StaffSession>('/api/staff/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
            }),
          });
          return staff as any;
        } catch {
          return null;
        }
      },
    }),

    // Provider 2: Telefone + código SMS (código já verificado via Twilio antes de chamar signIn)
    Credentials({
      id: 'credentials-phone',
      name: 'Telefone (SMS já verificado)',
      credentials: {
        phone: { label: 'Telefone', type: 'text' },
        code: { label: 'Código', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.phone || !credentials?.code) return null;
        try {
          const staff = await apiFetch<StaffSession>('/api/staff/auth/verify-sms', {
            method: 'POST',
            body: JSON.stringify({
              phone: credentials.phone,
              code: credentials.code,
            }),
          });
          return staff as any;
        } catch {
          return null;
        }
      },
    }),

    // Provider 3: Google OAuth
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Dados do staff retornados pelo authorize()
        token.staff = user as unknown as StaffSession;
      }
      return token;
    },
    async session({ session, token }) {
      session.staff = token.staff as StaffSession;
      return session;
    },
    async signIn({ account, profile }) {
      // Google OAuth: verificar se o email existe como StaffMember
      if (account?.provider === 'google') {
        // TODO no Plano 2: buscar StaffMember pelo googleId/email e adicionar à sessão
        // Por agora, bloquear login Google para staff (habilitar depois de mapear os emails)
        return false;
      }
      return true;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
```

- [ ] **5.2** Criar `app/api/auth/[...nextauth]/route.ts`:

```typescript
import { handlers } from '@/lib/auth';
export const { GET, POST } = handlers;
```

- [ ] **5.3** Commit:

```bash
git add lib/auth.ts app/api/auth/
git commit -m "feat: configure NextAuth with email+password and SMS providers"
```

---

## Task 6: Middleware de Proteção de Rotas

**Objetivo:** Redirecionar usuários não autenticados para `/login` e usuários autenticados para o dashboard correto do seu papel.

**Files:**
- Create: `middleware.ts`

- [ ] **6.1** Criar `middleware.ts`:

```typescript
import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ROLE_HOME: Record<string, string> = {
  ADMIN: '/admin',
  GUARDIA: '/casa',
  PISCINEIRO: '/piscina',
  HOSPEDE: '/hospede',
};

const ROUTE_ROLES: Record<string, string[]> = {
  '/admin': ['ADMIN'],
  '/casa': ['ADMIN', 'GUARDIA'],
  '/piscina': ['ADMIN', 'PISCINEIRO'],
  '/hospede': ['ADMIN', 'HOSPEDE'],
};

export default auth((req: NextRequest & { auth: any }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Rotas públicas
  if (pathname.startsWith('/login') || pathname.startsWith('/api/auth')) {
    if (session?.staff) {
      const role = session.staff.role as string;
      return NextResponse.redirect(new URL(ROLE_HOME[role] || '/login', req.url));
    }
    return NextResponse.next();
  }

  // Tela de primeiro acesso — só para autenticados que não completaram
  if (pathname === '/primeiro-acesso') {
    if (!session?.staff) {
      return NextResponse.redirect(new URL('/login', req.url));
    }
    return NextResponse.next();
  }

  // Todas as outras rotas: exigir autenticação
  if (!session?.staff) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // Após autenticação: redirecionar da raiz para o dashboard do papel
  if (pathname === '/') {
    const role = session.staff.role as string;
    return NextResponse.redirect(new URL(ROLE_HOME[role] || '/login', req.url));
  }

  // Primeiro login não completado → redirecionar para seleção de fonte
  if (!session.staff.firstLoginDone && pathname !== '/primeiro-acesso') {
    return NextResponse.redirect(new URL('/primeiro-acesso', req.url));
  }

  // Verificar permissão por papel para rotas restritas
  for (const [route, roles] of Object.entries(ROUTE_ROLES)) {
    if (pathname.startsWith(route)) {
      const role = session.staff.role as string;
      if (!roles.includes(role)) {
        const home = ROLE_HOME[role] || '/login';
        return NextResponse.redirect(new URL(home, req.url));
      }
      break;
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon-|manifest.json|sw.js).*)'],
};
```

- [ ] **6.2** Commit:

```bash
git add middleware.ts
git commit -m "feat: add role-based route protection middleware"
```

---

## Task 7: Root Layout + Telas de Auth

**Objetivo:** Criar o root layout com PWA meta tags e FontSizeProvider, e as telas de login e primeiro acesso.

**Files:**
- Modify: `app/layout.tsx`
- Create: `components/shared/FontSizeProvider.tsx`
- Create: `app/(auth)/login/page.tsx`
- Create: `components/auth/LoginForm.tsx`
- Create: `components/auth/SmsVerifyForm.tsx`
- Create: `app/(auth)/primeiro-acesso/page.tsx`
- Create: `components/auth/FontSizePicker.tsx`

- [ ] **7.1** Criar `components/shared/FontSizeProvider.tsx`:

```typescript
'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { type FontSize, fontSizeClasses } from '@/lib/fonts';

const FontSizeContext = createContext<{
  fontSize: FontSize;
  setFontSize: (s: FontSize) => void;
}>({ fontSize: 'MD', setFontSize: () => {} });

export function FontSizeProvider({
  children,
  initialSize = 'MD',
}: {
  children: React.ReactNode;
  initialSize?: FontSize;
}) {
  const [fontSize, setFontSize] = useState<FontSize>(initialSize);

  useEffect(() => {
    const root = document.documentElement;
    root.className = root.className
      .replace(/text-(sm|base|lg|xl)\b/g, '')
      .trim();
    root.classList.add(fontSizeClasses[fontSize]);
  }, [fontSize]);

  return (
    <FontSizeContext.Provider value={{ fontSize, setFontSize }}>
      {children}
    </FontSizeContext.Provider>
  );
}

export const useFontSize = () => useContext(FontSizeContext);
```

- [ ] **7.2** Atualizar `app/layout.tsx`:

```typescript
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { FontSizeProvider } from '@/components/shared/FontSizeProvider';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Recantos da Serra — Central da Equipe',
  description: 'Painel de gestão da equipe',
  manifest: '/manifest.json',
  themeColor: '#5c4033',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Central Recantos',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js'); }`,
          }}
        />
      </head>
      <body className={inter.className}>
        <FontSizeProvider>{children}</FontSizeProvider>
      </body>
    </html>
  );
}
```

- [ ] **7.3** Criar `components/auth/LoginForm.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { SmsVerifyForm } from './SmsVerifyForm';

type LoginMethod = 'email' | 'phone';

export function LoginForm() {
  const router = useRouter();
  const [method, setMethod] = useState<LoginMethod>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [smsSent, setSmsSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await signIn('credentials-email', {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (result?.error) {
      setError('Email ou senha incorretos');
    } else {
      router.push('/');
    }
  }

  async function handleSendSms(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/staff/auth/send-sms`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      }
    );
    setLoading(false);
    if (res.ok) {
      setSmsSent(true);
    } else {
      setError('Não foi possível enviar o SMS. Tente novamente.');
    }
  }

  if (method === 'phone' && smsSent) {
    return <SmsVerifyForm phone={phone} onBack={() => setSmsSent(false)} />;
  }

  return (
    <div className="w-full max-w-sm mx-auto">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-stone-800">Central da Equipe</h1>
        <p className="text-stone-500 mt-1">Recantos da Serra</p>
      </div>

      {/* Toggle método */}
      <div className="flex rounded-xl overflow-hidden border border-stone-200 mb-6">
        {(['email', 'phone'] as LoginMethod[]).map((m) => (
          <button
            key={m}
            onClick={() => { setMethod(m); setError(''); }}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              method === m
                ? 'bg-stone-800 text-white'
                : 'bg-white text-stone-600 hover:bg-stone-50'
            }`}
          >
            {m === 'email' ? 'Email e Senha' : 'Celular (SMS)'}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-red-600 text-sm mb-4 text-center">{error}</p>
      )}

      {method === 'email' ? (
        <form onSubmit={handleEmailLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2.5 text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-500"
              placeholder="seu@email.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2.5 text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-500"
              placeholder="••••••••"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-stone-800 text-white py-3 rounded-xl font-medium hover:bg-stone-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleSendSms} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">
              Número de celular
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2.5 text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-500"
              placeholder="+55 11 99999-9999"
              required
            />
            <p className="text-xs text-stone-400 mt-1">
              Vamos enviar um código por SMS
            </p>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-stone-800 text-white py-3 rounded-xl font-medium hover:bg-stone-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Enviando...' : 'Enviar código'}
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **7.4** Criar `components/auth/SmsVerifyForm.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export function SmsVerifyForm({
  phone,
  onBack,
}: {
  phone: string;
  onBack: () => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await signIn('credentials-phone', {
      phone,
      code,
      redirect: false,
    });
    setLoading(false);
    if (result?.error) {
      setError('Código inválido ou expirado. Tente novamente.');
    } else {
      router.push('/');
    }
  }

  return (
    <div className="w-full max-w-sm mx-auto">
      <button
        onClick={onBack}
        className="text-stone-500 text-sm mb-6 flex items-center gap-1 hover:text-stone-700"
      >
        ← Voltar
      </button>
      <p className="text-stone-600 mb-1">
        Enviamos um código para
      </p>
      <p className="font-medium text-stone-800 mb-6">{phone}</p>

      {error && (
        <p className="text-red-600 text-sm mb-4 text-center">{error}</p>
      )}

      <form onSubmit={handleVerify} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Código de 6 dígitos
          </label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="w-full border border-stone-300 rounded-lg px-3 py-3 text-stone-800 text-center text-2xl tracking-widest focus:outline-none focus:ring-2 focus:ring-stone-500"
            placeholder="000000"
            required
          />
        </div>
        <button
          type="submit"
          disabled={loading || code.length !== 6}
          className="w-full bg-stone-800 text-white py-3 rounded-xl font-medium hover:bg-stone-700 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Verificando...' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **7.5** Criar `app/(auth)/login/page.tsx`:

```typescript
import { LoginForm } from '@/components/auth/LoginForm';

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
```

- [ ] **7.6** Criar `components/auth/FontSizePicker.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { useFontSize } from '@/components/shared/FontSizeProvider';
import { type FontSize, fontSizeLabels, fontSizeDescriptions } from '@/lib/fonts';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';

const SIZES: FontSize[] = ['SM', 'MD', 'LG', 'XL'];

export function FontSizePicker() {
  const { fontSize, setFontSize } = useFontSize();
  const [selected, setSelected] = useState<FontSize>(fontSize);
  const [saving, setSaving] = useState(false);
  const { data: session } = useSession();
  const router = useRouter();

  function handleSelect(size: FontSize) {
    setSelected(size);
    setFontSize(size);
  }

  async function handleConfirm() {
    setSaving(true);
    await apiFetch('/api/staff/auth/font-size', {
      method: 'PATCH',
      body: JSON.stringify({ fontSize: selected }),
      staffId: session?.staff?.id,
    });
    setSaving(false);
    router.push('/');
  }

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-stone-800">
          Bem-vindo, {session?.staff?.name?.split(' ')[0]}!
        </h1>
        <p className="text-stone-500 mt-2">
          Escolha o tamanho de letra mais confortável para você
        </p>
      </div>

      <div className="space-y-3 mb-8">
        {SIZES.map((size) => (
          <button
            key={size}
            onClick={() => handleSelect(size)}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
              selected === size
                ? 'border-stone-800 bg-stone-50'
                : 'border-stone-200 hover:border-stone-300'
            }`}
          >
            <span
              className={`font-medium text-stone-800 ${
                size === 'SM' ? 'text-sm' :
                size === 'MD' ? 'text-base' :
                size === 'LG' ? 'text-lg' : 'text-xl'
              }`}
            >
              {fontSizeLabels[size]}
            </span>
            <p className="text-stone-500 text-sm mt-0.5">
              {fontSizeDescriptions[size]}
            </p>
          </button>
        ))}
      </div>

      <p className="text-center text-stone-400 text-sm mb-4">
        Você pode mudar isso depois nas configurações do perfil
      </p>

      <button
        onClick={handleConfirm}
        disabled={saving}
        className="w-full bg-stone-800 text-white py-3 rounded-xl font-medium hover:bg-stone-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Salvando...' : 'Continuar'}
      </button>
    </div>
  );
}
```

- [ ] **7.7** Criar `app/(auth)/primeiro-acesso/page.tsx`:

```typescript
import { FontSizePicker } from '@/components/auth/FontSizePicker';

export default function PrimeiroAcessoPage() {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <FontSizePicker />
    </main>
  );
}
```

- [ ] **7.8** Criar placeholders para as rotas protegidas (para Next.js não reclamar de páginas faltando).

Para cada rota de `(admin)`, `(casa)`, `(piscina)`, `(hospede)`, criar um `page.tsx` placeholder:

```bash
# Script para criar placeholders
for route in \
  "app/(admin)/page.tsx" \
  "app/(admin)/reservas/page.tsx" \
  "app/(admin)/calendario/page.tsx" \
  "app/(admin)/financeiro/page.tsx" \
  "app/(admin)/vistorias/page.tsx" \
  "app/(admin)/tarefas/page.tsx" \
  "app/(admin)/equipe/page.tsx" \
  "app/(admin)/manutencao/page.tsx" \
  "app/(admin)/feedbacks/page.tsx" \
  "app/(admin)/hospedes/page.tsx" \
  "app/(admin)/precos/page.tsx" \
  "app/(admin)/ia/page.tsx" \
  "app/(casa)/page.tsx" \
  "app/(casa)/calendario/page.tsx" \
  "app/(casa)/tarefas/page.tsx" \
  "app/(piscina)/page.tsx" \
  "app/(piscina)/calendario/page.tsx" \
  "app/(piscina)/manutencao/page.tsx" \
  "app/(piscina)/chamado/page.tsx" \
  "app/(piscina)/programacao/page.tsx" \
  "app/(hospede)/page.tsx" \
  "app/perfil/page.tsx" \
  "app/notificacoes/page.tsx"; do
  dir=$(dirname "$route")
  mkdir -p "$dir"
  filename=$(basename "$route" .tsx)
  echo "export default function Page() { return <div className='p-4'><h1>Em desenvolvimento</h1></div>; }" > "$route"
done
```

- [ ] **7.9** Criar layouts para grupos de rotas.

`app/(admin)/layout.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.staff || session.staff.role !== 'ADMIN') redirect('/login');
  return <>{children}</>;
}
```

`app/(casa)/layout.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function CasaLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.staff) redirect('/login');
  if (!['ADMIN', 'GUARDIA'].includes(session.staff.role)) redirect('/login');
  return <>{children}</>;
}
```

`app/(piscina)/layout.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function PiscinaLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.staff) redirect('/login');
  if (!['ADMIN', 'PISCINEIRO'].includes(session.staff.role)) redirect('/login');
  return <>{children}</>;
}
```

`app/(hospede)/layout.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function HospedeLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.staff) redirect('/login');
  return <>{children}</>;
}
```

- [ ] **7.10** Criar `app/page.tsx` (raiz — redireciona):

```typescript
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

const ROLE_HOME: Record<string, string> = {
  ADMIN: '/admin',
  GUARDIA: '/casa',
  PISCINEIRO: '/piscina',
};

export default async function RootPage() {
  const session = await auth();
  if (!session?.staff) redirect('/login');
  const home = ROLE_HOME[session.staff.role] || '/login';
  redirect(home);
}
```

- [ ] **7.11** Commit:

```bash
git add .
git commit -m "feat: login flow, SMS verification, font size picker, route guards"
```

---

## Task 8: Deploy no Railway

**Objetivo:** Colocar o app em produção em `app.recantosdaserra.com`.

**Files:**
- Create: `railway.toml` (no repositório Next.js)

- [ ] **8.1** Criar `railway.toml` no repositório Next.js:

```toml
[build]
builder = "nixpacks"
buildCommand = "npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "on_failure"
```

- [ ] **8.2** Criar repositório no GitHub:

```bash
git remote add origin https://github.com/SEU_USUARIO/recantos-central-equipe.git
git push -u origin main
```

- [ ] **8.3** No Railway (`railway.app`):
  - Abrir o projeto existente do Recanto dos Ipês
  - Clicar **New Service → GitHub Repo**
  - Selecionar `recantos-central-equipe`
  - Railway detecta o `railway.toml` automaticamente

- [ ] **8.4** Adicionar variáveis de ambiente no Railway (Settings → Variables):

```
NEXT_PUBLIC_API_URL=https://sitiorecantodosipes.com
NEXTAUTH_URL=https://app.recantosdaserra.com
NEXTAUTH_SECRET=[gerar: openssl rand -base64 32]
GOOGLE_CLIENT_ID=[do Google Console]
GOOGLE_CLIENT_SECRET=[do Google Console]
```

- [ ] **8.5** Em **Settings → Networking** do serviço Next.js:
  - Adicionar domínio customizado: `app.recantosdaserra.com`
  - Railway gera os registros DNS — adicionar no painel do registrador de domínio (onde `recantosdaserra.com` foi registrado)
  - Aguardar propagação (5–30 min)

- [ ] **8.6** Deploy automático ativa ao fazer push para `main`. Verificar logs no Railway.

- [ ] **8.7** Teste de verificação final:

```
1. Acessar https://app.recantosdaserra.com → deve redirecionar para /login
2. Login com recantodoipes@gmail.com + senha inicial
3. Deve redirecionar para /primeiro-acesso (seleção de fonte)
4. Escolher tamanho → confirmar → redirecionar para /admin
5. No celular: Chrome → menu → "Adicionar à tela inicial" → instalar
6. Abrir o ícone instalado → app abre em modo standalone (sem barra do Chrome)
```

- [ ] **8.8** Commit final:

```bash
git add railway.toml
git commit -m "feat: Railway deployment config"
git push origin main
```

---

## Self-Review

**Cobertura do spec:**
- ✅ App separado `app.recantosdaserra.com`
- ✅ Next.js 14 PWA instalável (manifest + service worker)
- ✅ Auth: email+senha, SMS Twilio, estrutura para Google OAuth
- ✅ Font size selection no primeiro login com persistência
- ✅ Roteamento protegido por papel (ADMIN/GUARDIA/PISCINEIRO/HOSPEDE)
- ✅ 14 novos modelos no Prisma + migration
- ✅ Propriedade Recanto dos Ipês criada via seed
- ✅ Primeiro admin (Andre) criado
- ✅ Deploy Railway configurado
- ✅ Estrutura de pastas pronta para Plano 2 (páginas placeholder)

**Pendências para Planos seguintes:**
- Google OAuth para staff (bloqueado intencionalmente — habilitar no Plano 2 após mapear emails dos membros)
- Conteúdo real das páginas (admin, casa, piscina) → Plano 2
- Push notifications reais → Plano 3
- Ícones PWA (icon-192.png, icon-512.png) → criar a partir do logo do Recanto

**Placeholder scan:** nenhum TBD crítico nas tarefas — todo código presente.

**Consistência de tipos:**
- `StaffRole`, `FontSize` exportados de `lib/auth.ts` e `lib/fonts.ts` — usados consistentemente
- `apiFetch` aceita `staffId` como header `x-staff-id` — Express lê o mesmo header em `staff-auth.js`

---

## Próximos Planos

- **Plano 2:** Conteúdo real das páginas — Dashboard admin, calendário, financeiro, portais Guardiã e Piscineiro, vistorias com Cloudinary + assinatura digital
- **Plano 3:** Push notifications (Web Push API), survey pós-hospedagem, cron jobs de automação
- **Plano 4 (Fase 2):** IA "Visão Recantos" (Claude API), precificação dinâmica, reputação do hóspede

---

*Plano 1 — Foundation · Recantos da Serra Central da Equipe · 2026-04-11*
