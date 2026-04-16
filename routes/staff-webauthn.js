'use strict';

/**
 * WebAuthn (biometric) authentication routes for Staff PWA.
 * Mounted at /api/staff/auth/webauthn by server.js
 *
 * Flow:
 *   Registration  (logged-in staff enrolls a device):
 *     GET  /registration-options  → challenge
 *     POST /register              → save credential
 *
 *   Authentication (staff logs in with biometrics):
 *     POST /authentication-options → challenge (public, hint with credentialId)
 *     POST /authenticate           → verify + return staffToken
 */

const express   = require('express');
const jwt       = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const prisma    = require('../lib/db');
const router    = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRpConfig() {
  const staffAppUrl = process.env.STAFF_APP_URL || 'http://localhost:3001';
  const url = new URL(staffAppUrl);
  return {
    rpName:   'Recantos da Serra',
    rpID:     url.hostname,                // e.g. "app.recantosdaserra.com" or "localhost"
    origin:   staffAppUrl.replace(/\/$/, ''),
  };
}

// In-memory challenge store: staffId|email → { challenge, expiresAt }
// A Map works fine — challenges are short-lived (2 min) and single-server.
const _challenges = new Map();

function storeChallenge(key, challenge) {
  _challenges.set(key, { challenge, expiresAt: Date.now() + 2 * 60 * 1000 });
}

function consumeChallenge(key) {
  const entry = _challenges.get(key);
  _challenges.delete(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.challenge;
}

const { requireStaff } = require('../lib/staff-auth-middleware');

// ── Registration ──────────────────────────────────────────────────────────────

// GET /registration-options  (requires staff JWT)
router.get('/registration-options', requireStaff, async (req, res) => {
  try {
    const { rpName, rpID } = getRpConfig();

    // Get existing credentials to exclude them (avoid duplicate enrollments)
    const existingCreds = await prisma.webAuthnCredential.findMany({
      where:  { staffId: req.staff.id },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID:           Buffer.from(req.staff.id),
      userName:         req.staff.email || req.staff.name,
      userDisplayName:  req.staff.name,
      attestationType: 'none',
      excludeCredentials: existingCreds.map(c => ({
        id:         c.credentialId,
        transports: c.transports,
      })),
      authenticatorSelection: {
        residentKey:      'preferred',
        userVerification: 'preferred',
      },
    });

    storeChallenge(req.staff.id, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('[webauthn] registration-options error:', err);
    res.status(500).json({ error: 'Erro ao gerar opções de registro' });
  }
});

// POST /register  (requires staff JWT)
// Body: the PublicKeyCredential JSON returned by startRegistration()
router.post('/register', requireStaff, async (req, res) => {
  try {
    const { rpID, origin } = getRpConfig();
    const expectedChallenge = consumeChallenge(req.staff.id);
    if (!expectedChallenge) return res.status(400).json({ error: 'Desafio expirado. Tente novamente.' });

    const verification = await verifyRegistrationResponse({
      response:           req.body,
      expectedChallenge,
      expectedOrigin:     origin,
      expectedRPID:       rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verificação falhou' });
    }

    const { credential } = verification.registrationInfo;

    await prisma.webAuthnCredential.create({
      data: {
        staffId:      req.staff.id,
        credentialId: credential.id,
        publicKey:    Buffer.from(credential.publicKey),
        counter:      BigInt(credential.counter),
        transports:   req.body.response?.transports ?? [],
      },
    });

    res.json({ verified: true, credentialId: credential.id });
  } catch (err) {
    console.error('[webauthn] register error:', err);
    res.status(500).json({ error: 'Erro ao registrar credencial' });
  }
});

// DELETE /credential  (requires staff JWT)
router.delete('/credential', requireStaff, async (req, res) => {
  try {
    const { credentialId } = req.body;
    if (!credentialId) return res.status(400).json({ error: 'credentialId obrigatório' });

    await prisma.webAuthnCredential.deleteMany({
      where: { staffId: req.staff.id, credentialId },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[webauthn] delete credential error:', err);
    res.status(500).json({ error: 'Erro ao remover credencial' });
  }
});

// ── Authentication ────────────────────────────────────────────────────────────

// POST /authentication-options  (public — no staff JWT needed)
// Body: { credentialId? }  — hint to pre-select the credential
router.post('/authentication-options', async (req, res) => {
  try {
    const { rpID } = getRpConfig();
    const { credentialId } = req.body ?? {};

    let allowCredentials = [];
    let challengeKey = 'anon';

    if (credentialId) {
      const cred = await prisma.webAuthnCredential.findUnique({
        where:  { credentialId },
        select: { credentialId: true, transports: true, staffId: true },
      });
      if (cred) {
        allowCredentials = [{ id: cred.credentialId, transports: cred.transports }];
        challengeKey = cred.staffId;
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
    });

    storeChallenge(challengeKey, options.challenge);
    // Return challengeKey so authenticate knows where to look
    res.json({ ...options, _challengeKey: challengeKey });
  } catch (err) {
    console.error('[webauthn] authentication-options error:', err);
    res.status(500).json({ error: 'Erro ao gerar opções de autenticação' });
  }
});

// POST /authenticate  (public)
// Body: { assertion: <PublicKeyCredential JSON>, _challengeKey }
router.post('/authenticate', async (req, res) => {
  try {
    const { rpID, origin } = getRpConfig();
    const { _challengeKey } = req.body;

    const expectedChallenge = consumeChallenge(_challengeKey || 'anon');
    if (!expectedChallenge) return res.status(400).json({ error: 'Desafio expirado. Tente novamente.' });

    // Find the stored credential
    const storedCred = await prisma.webAuthnCredential.findUnique({
      where:  { credentialId: req.body.id },
      include: {
        staff: {
          select: { id: true, name: true, email: true, phone: true, role: true,
                    active: true, firstLoginDone: true, fontSizePreference: true },
        },
      },
    });

    if (!storedCred || !storedCred.staff.active) {
      return res.status(401).json({ error: 'Credencial não encontrada ou conta inativa' });
    }

    const verification = await verifyAuthenticationResponse({
      response:           req.body,
      expectedChallenge,
      expectedOrigin:     origin,
      expectedRPID:       rpID,
      credential: {
        id:         storedCred.credentialId,
        publicKey:  storedCred.publicKey,
        counter:    Number(storedCred.counter),
        transports: storedCred.transports,
      },
      requireUserVerification: false,
    });

    if (!verification.verified) return res.status(401).json({ error: 'Autenticação falhou' });

    // Update counter and lastUsedAt
    await prisma.webAuthnCredential.update({
      where: { credentialId: storedCred.credentialId },
      data:  {
        counter:    BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    // Issue staffToken (same shape as password login)
    const staffToken = jwt.sign({ sub: storedCred.staff.id }, process.env.STAFF_JWT_SECRET, { expiresIn: '30d' });

    res.json({
      staffToken,
      id:                 storedCred.staff.id,
      name:               storedCred.staff.name,
      email:              storedCred.staff.email,
      phone:              storedCred.staff.phone,
      role:               storedCred.staff.role,
      firstLoginDone:     storedCred.staff.firstLoginDone,
      fontSizePreference: storedCred.staff.fontSizePreference,
    });
  } catch (err) {
    console.error('[webauthn] authenticate error:', err);
    res.status(500).json({ error: 'Erro ao autenticar' });
  }
});

module.exports = router;
