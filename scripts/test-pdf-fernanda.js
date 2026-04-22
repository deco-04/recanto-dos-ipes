'use strict';
/**
 * Mint a fresh staff JWT + curl the PDF endpoint for Fernanda's vistoria.
 * Verifies the enriched PDF (booking header + financial + contact + checklist).
 */
const fs   = require('fs');
const path = require('path');
const jwt  = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const APP_URL = process.env.APP_URL || 'https://sitiorecantodosipes.com';
const SECRET  = process.env.STAFF_JWT_SECRET;
if (!SECRET) {
  console.error('❌ STAFF_JWT_SECRET missing — set it in .env or shell');
  process.exit(1);
}

(async () => {
  const p = new PrismaClient();
  const admin = await p.staffMember.findUnique({
    where: { email: 'recantodoipes@gmail.com' },
    select: { id: true, email: true, role: true },
  });
  if (!admin) { console.error('❌ admin not found'); process.exit(1); }

  // Match the staff token shape used by the backend: sub=staffId, role, exp 7d.
  const token = jwt.sign(
    { sub: admin.id, email: admin.email, role: admin.role },
    SECRET,
    { expiresIn: '7d' },
  );

  // Fernanda's recent vistoria id (from earlier audit) — find the latest CHECKOUT vistoria.
  const v = await p.inspectionReport.findFirst({
    where: { type: 'CHECKOUT', status: 'SUBMITTED', booking: { guestName: { contains: 'Fernanda', mode: 'insensitive' } } },
    orderBy: { submittedAt: 'desc' },
    include: { booking: { select: { id: true, guestName: true, checkOut: true } } },
  });
  if (!v) { console.error('❌ no Fernanda checkout vistoria found'); process.exit(1); }
  console.log(`📋 Vistoria: ${v.id} · "${v.booking.guestName}" · checkout=${v.booking.checkOut.toISOString().slice(0,10)}`);

  // Curl with auth header
  const url = `${APP_URL}/api/staff/vistorias/${v.id}/pdf`;
  console.log(`🌐 GET ${url}`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`   HTTP ${res.status}`);

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ Failed:\n${body.slice(0, 500)}`);
    process.exit(1);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const out = path.join(__dirname, `fernanda-vistoria-${v.id.slice(-8)}.pdf`);
  fs.writeFileSync(out, buffer);
  console.log(`✅ PDF saved: ${out} (${buffer.length} bytes)`);

  // Quick smell test — pdfkit produces "%PDF-" header
  if (!buffer.slice(0, 5).toString().startsWith('%PDF-')) {
    console.warn(`⚠️  Buffer doesn't start with %PDF — may not be a valid PDF`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
