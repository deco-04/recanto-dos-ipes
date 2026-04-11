'use strict';

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Autenticação necessária', redirect: '/login' });
}

module.exports = { requireAuth };
