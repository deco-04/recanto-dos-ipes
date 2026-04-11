// push-setup.js — Call setupPushNotifications() after staff login
/* global fetch, navigator, Notification, URL */
'use strict';

/**
 * Register service worker and subscribe to Web Push.
 * Call this after a successful staff login.
 *
 * @param {string} apiBase - e.g. 'https://recanto.up.railway.app'
 */
async function setupPushNotifications(apiBase) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[push] Not supported in this browser');
    return;
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  console.log('[push] Service worker registered');

  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    console.log('[push] Already subscribed');
    return;
  }

  const keyRes = await fetch(`${apiBase}/api/staff/push/vapid-key`, { credentials: 'include' });
  if (!keyRes.ok) {
    console.warn('[push] VAPID key not available:', keyRes.status);
    return;
  }
  const { publicKey } = await keyRes.json();

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.log('[push] Permission denied');
    return;
  }

  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey),
    });
  } catch (err) {
    console.warn('[push] Subscribe failed:', err.message || err);
    return;
  }

  const subRes = await fetch(`${apiBase}/api/staff/push/subscribe`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:        JSON.stringify({ subscription }),
  });
  if (!subRes.ok) {
    console.warn('[push] Failed to save subscription:', subRes.status);
    return;
  }

  console.log('[push] Subscribed successfully');
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}
