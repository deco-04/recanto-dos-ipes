const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('Admin@2025!', 12);
  const existing = await p.staffMember.findUnique({ where: { email: 'admin@recantosdaserra.com' } });
  if (existing) {
    await p.staffMember.update({ where: { id: existing.id }, data: { passwordHash: hash, active: true, firstLoginDone: true } });
    console.log('Updated:', existing.id);
    return;
  }
  const staff = await p.staffMember.create({
    data: {
      name: 'Andre (Admin)',
      email: 'admin@recantosdaserra.com',
      role: 'ADMIN',
      active: true,
      firstLoginDone: true,
      passwordHash: hash,
    }
  });
  console.log('Created:', staff.id, staff.email);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); }).finally(() => p.$disconnect());
