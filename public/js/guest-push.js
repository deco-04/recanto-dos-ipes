// guest-push.js — Guest Web Push registration
// Call initGuestPush() after the guest is confirmed logged-in.
// The function is silent (no throws) and degrades gracefully on unsupported browsers.
/* global fetch, navigator, Notification */
'use strict';

/**
 * Registers the service worker, requests notification permission, and
 * saves the push subscription to the server.
 *
 * @param {{ silent?: boolean }} [opts]
 *   silent: if true, never prompts for permission (only subscribes if already granted)
 * @returns {Promise<'subscribed'|'already'|'denied'|'unsupported'|'error'>}
 */
async function initGuestPush({ silent = false } = {}) {
  // Feature detection
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[guest-push] Push not supported in this browser');
    return 'unsupported';
  }

  try {
    // Register (or get existing) service worker
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    // Check if already subscribed
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      // Silently sync the subscription to the server (in case the server lost it)
      await _saveSubscription(existing);
      return 'already';
    }

    // Decide whether to ask for permission
    const currentPerm = Notification.permission;

    if (currentPerm === 'denied') {
      console.log('[guest-push] Permission denied by user');
      return 'denied';
    }

    if (currentPerm !== 'granted' && silent) {
      // Caller said don't prompt — return without requesting
      return 'unsupported';
    }

    // Fetch VAPID key
    const keyRes = await fetch('/api/push/vapid-key');
    if (!keyRes.ok) {
      console.warn('[guest-push] VAPID key not available:', keyRes.status);
      return 'error';
    }
    const { publicKey } = await keyRes.json();

    // Request permission (only if not already granted)
    if (currentPerm !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.log('[guest-push] User denied notification permission');
        return 'denied';
      }
    }

    // Subscribe
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey),
    });

    await _saveSubscription(subscription);
    console.log('[guest-push] Subscribed successfully');
    return 'subscribed';

  } catch (err) {
    console.warn('[guest-push] Error:', err.message || err);
    return 'error';
  }
}

/**
 * Unsubscribes the current browser from push notifications.
 * @returns {Promise<boolean>}
 */
async function unsubscribeGuestPush() {
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) return true;

    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;

    await subscription.unsubscribe();

    // Notify server to clear the saved subscription
    await fetch('/api/push/unsubscribe', {
      method:      'POST',
      credentials: 'include',
    });

    console.log('[guest-push] Unsubscribed');
    return true;
  } catch (err) {
    console.warn('[guest-push] Unsubscribe error:', err.message || err);
    return false;
  }
}

/**
 * Returns the current push permission state: 'granted' | 'denied' | 'default' | 'unsupported'
 */
function getPushPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _saveSubscription(subscription) {
  const res = await fetch('/api/push/subscribe', {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:        JSON.stringify({ subscription }),
  });
  if (!res.ok) {
    console.warn('[guest-push] Failed to save subscription to server:', res.status);
  }
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}
