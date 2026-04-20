'use strict';

/**
 * seed-rdi-access-info.js
 *
 * Sets the accessInfo JSON on the RDI (Sítio Recanto dos Ipês) Property record.
 * Run once after the 20260420000003 migration is deployed.
 *
 * Usage:
 *   DATABASE_URL=<public_proxy_url> node scripts/seed-rdi-access-info.js
 *
 * Safe to re-run (idempotent — just overwrites accessInfo).
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ACCESS_INFO = {
  wifi: {
    ssid:     'RecantoDosIpes',
    password: 'recanto2024',   // ← update to real password before production
  },
  checkin: {
    instructions: [
      'Check-in a partir das 14h. Check-out até 12h.',
      'Ao chegar, acione o interfone no portão principal.',
      'O porteiro irá orientar sobre o estacionamento e a entrada.',
      'O responsável pela propriedade estará disponível para recebê-lo(a).',
    ],
    emergency: '+55 31 2391-6688',   // RDI main phone (recantodoipes@gmail.com)
    emergencyLabel: 'Recanto dos Ipês (WhatsApp)',
  },
  maps: {
    url: 'https://maps.google.com/?q=S%C3%ADtio+Recanto+dos+Ip%C3%AAs,+Jaboticatubas,+MG',
    label: 'Ver no Google Maps',
  },
  houseRules: [
    'Silêncio após as 22h.',
    'Não é permitida a entrada de pessoas não cadastradas na reserva sem aviso prévio.',
    'Animais de estimação são bem-vindos mediante pagamento da taxa pet.',
    'É proibido fumar dentro das instalações.',
    'Lixo deve ser depositado nos contêineres indicados.',
  ],
};

async function main() {
  const property = await prisma.property.findFirst({ where: { type: 'SITIO' } });
  if (!property) {
    console.error('❌  No SITIO property found. Is the DB connected correctly?');
    process.exit(1);
  }

  await prisma.property.update({
    where: { id: property.id },
    data:  { accessInfo: ACCESS_INFO },
  });

  console.log(`✅  accessInfo set on property "${property.name}" (${property.id})`);
  console.log('    WiFi SSID:', ACCESS_INFO.wifi.ssid);
  console.log('    Emergency:', ACCESS_INFO.checkin.emergency);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
