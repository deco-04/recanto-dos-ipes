'use strict';
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const allProps = await p.property.findMany({ orderBy: { slug: 'asc' }, select: { id: true, slug: true, name: true, active: true } });
  console.log('\n== ALL properties in DB ==');
  for (const r of allProps) console.log(`   ${r.active ? '✅' : '❌'} ${r.slug.padEnd(22)} ${r.name.padEnd(30)} ${r.id}`);

  const andre = await p.staffMember.findUnique({
    where: { email: 'recantodoipes@gmail.com' },
    include: { properties: { include: { property: { select: { slug: true, name: true, active: true } } } } }
  });
  console.log(`\n== Andre's StaffPropertyAssignments (${andre.properties.length}) ==`);
  for (const a of andre.properties) console.log(`   assignment ${a.id} → ${a.property.slug} (property.active=${a.property.active})`);

  // Access requests model?
  const models = Object.keys(p).filter(k => !k.startsWith('$') && !k.startsWith('_'));
  console.log('\n== Models containing "request" or "access" ==');
  console.log(models.filter(m => /request|access|pending/i.test(m)).join(', ') || '(none)');

  // Sthefane
  const s = await p.staffMember.findFirst({ where: { OR: [{ name: { contains: 'thefan', mode: 'insensitive' } }, { email: { contains: 'thefan', mode: 'insensitive' } }] } });
  console.log('\n== Sthefane in StaffMember ==');
  console.log(s ? JSON.stringify({ id: s.id, name: s.name, email: s.email, phone: s.phone, role: s.role, active: s.active, firstLoginDone: s.firstLoginDone, createdAt: s.createdAt }, null, 2) : '(not found)');

  await p.$disconnect();
})();
