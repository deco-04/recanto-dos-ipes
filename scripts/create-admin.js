/**
 * Seed script — cria a propriedade Sítio Recanto dos Ipês e o primeiro admin (Andre).
 * Rodar UMA VEZ após a migration do banco:
 *   node scripts/create-admin.js
 *
 * A senha inicial é: trocar-essa-senha-123
 * Altere imediatamente após o primeiro login.
 */

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. Criar a propriedade Sítio Recanto dos Ipês
  const property = await prisma.property.upsert({
    where: { slug: 'recanto-dos-ipes' },
    update: {},
    create: {
      name: 'Sítio Recanto dos Ipês',
      slug: 'recanto-dos-ipes',
      type: 'SITIO',
      city: 'Jaboticatubas',
      state: 'MG',
      hasPool: true,
      active: true,
    },
  });
  console.log(`✅ Propriedade: ${property.name}`);

  // 2. Criar admins
  const admins = [
    { name: 'Andre', email: 'recantodoipes@gmail.com' },
    { name: 'Sthefane', email: null }, // adicione o email quando tiver
    { name: 'Paulo', email: null },    // adicione o email quando tiver
  ];

  const senhaHash = await bcrypt.hash('trocar-essa-senha-123', 12);

  for (const admin of admins) {
    if (!admin.email) {
      console.log(`⚠️  ${admin.name}: sem email definido — pule ou adicione manualmente`);
      continue;
    }

    const staff = await prisma.staffMember.upsert({
      where: { email: admin.email },
      update: {},
      create: {
        name: admin.name,
        email: admin.email,
        passwordHash: senhaHash,
        role: 'ADMIN',
        active: true,
        firstLoginDone: false,
      },
    });

    await prisma.staffPropertyAssignment.upsert({
      where: { staffId_propertyId: { staffId: staff.id, propertyId: property.id } },
      update: {},
      create: { staffId: staff.id, propertyId: property.id },
    });

    console.log(`✅ Admin criado: ${staff.name} (${staff.email})`);
  }

  console.log('\n🔑 Senha inicial de todos os admins: trocar-essa-senha-123');
  console.log('⚠️  Altere a senha imediatamente após o primeiro login!\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
