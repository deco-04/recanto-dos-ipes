// sw.js — Sítio Recanto dos Ipês · Service Worker
// Handles Web Push notifications for guests (and staff accessing from this origin).
'use strict';

const CACHE_NAME = 'sri-v1';
const OFFLINE_URL = '/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Push notification handler ─────────────────────────────────────────────────

const ICON_MAP = {
  // Guest notification types
  BOOKING_CONFIRMED_GUEST: '/icons/icon-192.png',
  CHECKIN_REMINDER:        '/icons/icon-192.png',
  CHECKOUT_REMINDER:       '/icons/icon-192.png',
  SURVEY_REQUEST:          '/icons/icon-192.png',
  BOOKING_CANCELLED_GUEST: '/icons/icon-192.png',
  // Staff notification types (legacy — staff now uses the central-equipe app)
  BOOKING_CONFIRMED:       '/icons/icon-192.png',
  TASK_ASSIGNED:           '/icons/icon-192.png',
  GENERIC:                 '/icons/icon-192.png',
};

// Notifications that should persist until the user interacts with them
const REQUIRE_INTERACTION_TYPES = new Set([
  'BOOKING_CONFIRMED_GUEST',
  'CHECKIN_REMINDER',
  'SURVEY_REQUEST',
]);

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Recanto dos Ipês', body: event.data.text(), type: 'GENERIC' };
  }

  const { title, body, type, data = {} } = payload;

  const options = {
    body,
    icon:   ICON_MAP[type] || '/icons/icon-192.png',
    badge:  '/icons/badge-72.png',
    image:  type === 'BOOKING_CONFIRMED_GUEST' ? '/brand/og-image.jpg' : undefined,
    data:   { type, ...data },
    vibrate: [200, 100, 200],
    requireInteraction: REQUIRE_INTERACTION_TYPES.has(type),
    tag:    type,  // collapses duplicate notifications of the same type
    renotify: false,
    actions: _actionsFor(type),
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

function _actionsFor(type) {
  switch (type) {
    case 'BOOKING_CONFIRMED_GUEST':
      return [{ action: 'view', title: 'Ver reserva' }];
    case 'CHECKIN_REMINDER':
      return [{ action: 'view', title: 'Ver detalhes' }];
    case 'SURVEY_REQUEST':
      return [{ action: 'view', title: 'Avaliar estadia' }, { action: 'dismiss', title: 'Agora não' }];
    default:
      return [];
  }
}

// ── Notification click handler ────────────────────────────────────────────────

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { type, bookingId, url, action } = event.notification.data || {};

  // If user clicked "dismiss" action, just close
  if (action === 'dismiss') return;

  // Determine where to navigate
  let targetUrl = '/dashboard';
  if (url) {
    targetUrl = url;
  } else if (bookingId) {
    targetUrl = '/dashboard';  // guest dashboard shows booking details
  }

  // Legacy staff routes
  if (type === 'TASK_ASSIGNED' && event.notification.data?.taskId) {
    targetUrl = `/tasks/${event.notification.data.taskId}`;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing tab if available
      const existing = clients.find(c =>
        c.url.startsWith(self.location.origin) && 'focus' in c
      );
      if (existing) {
        existing.focus();
        existing.navigate(targetUrl);
        return;
      }
      // Otherwise open a new window
      self.clients.openWindow(targetUrl);
    })
  );
});

// ── Push subscription change ──────────────────────────────────────────────────
// Called when the browser invalidates the subscription (e.g., key rotation).
// Re-subscribes automatically and updates the server.

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
    }).then(subscription =>
      fetch('/api/push/subscribe', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ subscription }),
      })
    ).catch(err => console.warn('[sw] pushsubscriptionchange re-subscribe failed:', err))
  );
});
