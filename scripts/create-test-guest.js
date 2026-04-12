const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Create or find test guest user
  const email = 'guest-test@recantosdaserra.com';
  let user = await p.user.findUnique({ where: { email } });
  if (!user) {
    user = await p.user.create({ data: { email, name: 'Hóspede Teste' } });
    console.log('Created user:', user.id);
  } else {
    console.log('User exists:', user.id);
  }

  // Delete old test codes
  await p.verificationCode.deleteMany({ where: { email, purpose: 'LOGIN' } });

  // Create a code that's valid for 10 min
  const code = await p.verificationCode.create({
    data: {
      email,
      code: '123456',
      purpose: 'LOGIN',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }
  });
  console.log('Code created:', code.code, '→ expires:', code.expiresAt.toISOString());
  console.log('\nLogin with:', email, 'Code:', code.code);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); }).finally(() => p.$disconnect());
