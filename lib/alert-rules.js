'use strict';

/**
 * Operational alert rules for the AI Operações module.
 *
 * runAlertRules(prisma, propertyId) — evaluates all rules against live DB data
 * and returns an array of alert objects. Each call hits the DB fresh; the
 * caching layer lives in the API endpoint.
 *
 * Alert shape:
 *   { id, type, severity, title, description, linkPath }
 *
 * Severities: URGENTE > ALTA > INFO
 */

const ALERT_TYPES = {
  INSPECAO_PROBLEMA:   'INSPECAO_PROBLEMA',
  MANUTENCAO_ATRASADA: 'MANUTENCAO_ATRASADA',
  CHECKIN_SEM_VISTORIA:'CHECKIN_SEM_VISTORIA',
  CHAMADO_CRITICO:     'CHAMADO_CRITICO',
};

async function runAlertRules(prisma, propertyId) {
  const alerts = [];
  const now    = new Date();

  // ── Rule 1: Inspection PROBLEMA items unresolved for > 24 h ─────────────────
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const problemReports = await prisma.inspectionReport.findMany({
    where: {
      propertyId,
      status:      'SUBMITTED',
      submittedAt: { lt: yesterday },
      items:       { some: { status: 'PROBLEMA' } },
    },
    select: {
      id:      true,
      type:    true,
      booking: { select: { guestName: true } },
      items:   { where: { status: 'PROBLEMA' }, select: { description: true } },
    },
    orderBy: { submittedAt: 'desc' },
    take: 20,
  });

  for (const report of problemReports) {
    const tipoLabel = report.type === 'CHECKOUT' ? 'Checkout' : 'Pré Check-in';
    const guestName = report.booking?.guestName || 'hóspede';
    const items     = report.items.map(i => i.description).join(', ');
    alerts.push({
      id:          `inspecao-${report.id}`,
      type:        ALERT_TYPES.INSPECAO_PROBLEMA,
      severity:    'ALTA',
      title:       `Problema em vistoria de ${tipoLabel} — ${guestName}`,
      description: `${report.items.length} item(s) com problema há mais de 24h: ${items}`,
      linkPath:    `/casa/vistoria/${report.id}`,
    });
  }

  // ── Rule 2: Overdue maintenance schedules ────────────────────────────────────
  const overdueSchedules = await prisma.maintenanceSchedule.findMany({
    where:   { propertyId, nextDueAt: { lt: now } },
    orderBy: { nextDueAt: 'asc' },
  });

  for (const schedule of overdueSchedules) {
    const daysOverdue = Math.floor((now - schedule.nextDueAt) / (1000 * 60 * 60 * 24));
    alerts.push({
      id:          `manutencao-${schedule.id}`,
      type:        ALERT_TYPES.MANUTENCAO_ATRASADA,
      severity:    daysOverdue > 7 ? 'URGENTE' : 'ALTA',
      title:       `Manutenção atrasada: ${schedule.item}`,
      description: `Prevista para ${schedule.nextDueAt.toLocaleDateString('pt-BR')} · ${daysOverdue} dia${daysOverdue !== 1 ? 's' : ''} de atraso`,
      linkPath:    '/piscina/programacao',
    });
  }

  // ── Rule 3: Check-in within 3 days with no PRE_CHECKIN inspection ─────────────
  const threeDaysAhead = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const upcomingBookings = await prisma.booking.findMany({
    where: {
      propertyId,
      status:  'CONFIRMED',
      checkIn: { gte: now, lte: threeDaysAhead },
    },
    select: {
      id:          true,
      guestName:   true,
      checkIn:     true,
      inspections: { where: { type: 'PRE_CHECKIN' }, select: { id: true } },
    },
  });

  for (const booking of upcomingBookings) {
    if (booking.inspections.length === 0) {
      const msUntil   = booking.checkIn - now;
      const daysUntil = Math.floor(msUntil / (1000 * 60 * 60 * 24));
      const when      = daysUntil === 0 ? 'hoje' : daysUntil === 1 ? 'amanhã' : `em ${daysUntil} dias`;
      alerts.push({
        id:          `checkin-${booking.id}`,
        type:        ALERT_TYPES.CHECKIN_SEM_VISTORIA,
        severity:    daysUntil <= 1 ? 'URGENTE' : 'ALTA',
        title:       `Check-in sem vistoria — ${booking.guestName}`,
        description: `Chegada ${when}. Vistoria pré check-in ainda não realizada.`,
        linkPath:    `/casa/vistoria/nova?bookingId=${booking.id}&tipo=PRE_CHECKIN`,
      });
    }
  }

  // ── Rule 4: Open tickets with ALTA or URGENTE priority ───────────────────────
  const criticalTickets = await prisma.serviceTicket.findMany({
    where: {
      propertyId,
      status:   { in: ['ABERTO', 'EM_ANDAMENTO'] },
      priority: { in: ['ALTA', 'URGENTE'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  for (const ticket of criticalTickets) {
    const statusLabel = ticket.status === 'EM_ANDAMENTO' ? 'em andamento' : 'aberto';
    alerts.push({
      id:          `chamado-${ticket.id}`,
      type:        ALERT_TYPES.CHAMADO_CRITICO,
      severity:    ticket.priority === 'URGENTE' ? 'URGENTE' : 'ALTA',
      title:       ticket.title,
      description: `Chamado ${ticket.priority.toLowerCase()} ${statusLabel}`,
      linkPath:    '/admin/manutencao',
    });
  }

  // ── Rule 5: Low-stock inventory items ────────────────────────────────────────
  // Prisma doesn't support column-to-column comparisons in `where`, so we
  // fetch all items and filter in JS. The table is small (< 200 rows typically).
  const allInventory = await prisma.amenitiesItem.findMany({
    where:  { propertyId },
    select: { id: true, name: true, category: true, quantity: true, minQuantity: true, unit: true },
  }).catch(() => []);

  for (const item of allInventory) {
    if (item.quantity <= item.minQuantity) {
      alerts.push({
        id:          `estoque-${item.id}`,
        type:        'ESTOQUE_BAIXO',
        severity:    item.quantity === 0 ? 'URGENTE' : 'ALTA',
        title:       `Estoque baixo: ${item.name}`,
        description: `${item.quantity} ${item.unit} em estoque (mínimo: ${item.minQuantity} ${item.unit}) · ${item.category}`,
        linkPath:    '/casa/inventario',
      });
    }
  }

  // Sort: URGENTE first, then ALTA, then the rest
  const SEVERITY_ORDER = { URGENTE: 0, ALTA: 1, INFO: 2 };
  alerts.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2));

  return alerts;
}

module.exports = { runAlertRules, ALERT_TYPES };
