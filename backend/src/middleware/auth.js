const { verifyToken } = require('../lib/auth');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Oturum gerekli' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Oturum geçersiz veya süresi dolmuş' });
  }
}

function requireEmployee(req, res, next) {
  if (req.user?.type !== 'employee') return res.status(403).json({ error: 'Personel girişi gerekli' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.type !== 'employee' || req.user?.permission !== 'ADMIN') {
    return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  }
  next();
}

function requireDealer(req, res, next) {
  if (req.user?.type !== 'dealer') return res.status(403).json({ error: 'Bayi girişi gerekli' });
  next();
}

module.exports = { requireAuth, requireEmployee, requireAdmin, requireDealer };
