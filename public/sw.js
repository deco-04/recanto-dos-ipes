// sw.js — Staff PWA Service Worker
// Handles Web Push notifications sent from the backend.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Recanto dos Ipês', body: event.data.text(), type: 'GENERIC' };
  }

  const { title, body, type, data = {} } = payload;

  const iconMap = {
    BOOKING_CONFIRMED: '/icons/booking.png',
    TASK_ASSIGNED:     '/icons/task.png',
    GENERIC:           '/icons/logo.png',
  };

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:   iconMap[type] || '/icons/logo.png',
      badge:  '/icons/badge.png',
      data:   { type, ...data },
      vibrate: [200, 100, 200],
      requireInteraction: type === 'BOOKING_CONFIRMED',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { type, bookingId, taskId } = event.notification.data || {};

  let url = '/';
  if (type === 'BOOKING_CONFIRMED' && bookingId) {
    url = `/bookings/${bookingId}`;
  } else if (type === 'TASK_ASSIGNED' && taskId) {
    url = `/tasks/${taskId}`;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(url);
      } else {
        self.clients.openWindow(url);
      }
    })
  );
});
