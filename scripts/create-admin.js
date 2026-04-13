'use strict';
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  const EMAIL    = 'recantodoipes@gmail.com';
  const PASSWORD = 'Admin@2025!';

  const hash = await bcrypt.hash(PASSWORD, 12);

  // Upsert admin staff member
  let staff = await p.staffMember.findUnique({ where: { email: EMAIL } });
  if (staff) {
    staff = await p.staffMember.update({
      where: { id: staff.id },
      data: { passwordHash: hash, active: true, firstLoginDone: true },
    });
    console.log('Updated staff:', staff.id);
  } else {
    staff = await p.staffMember.create({
      data: {
        name: 'Andre (Admin)',
        email: EMAIL,
        role: 'ADMIN',
        active: true,
        firstLoginDone: true,
        passwordHash: hash,
      },
    });
    console.log('Created staff:', staff.id);
  }

  // Assign to ALL active properties
  const properties = await p.property.findMany({ where: { active: true } });
  for (const prop of properties) {
    await p.staffPropertyAssignment.upsert({
      where: { staffId_propertyId: { staffId: staff.id, propertyId: prop.id } },
      create: { staffId: staff.id, propertyId: prop.id },
      update: {},
    });
    console.log('Assigned to property:', prop.name, prop.id);
  }

  console.log('\n✅ Admin ready');
  console.log('   Email   :', EMAIL);
  console.log('   Password:', PASSWORD);
}

main()
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
