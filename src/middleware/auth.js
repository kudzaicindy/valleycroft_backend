const jwt = require('jsonwebtoken');

function readCookieToken(req) {
  const raw = String(req.headers.cookie || '');
  if (!raw) return null;
  const pairs = raw.split(';').map((x) => x.trim());
  for (const p of pairs) {
    const [k, ...rest] = p.split('=');
    const v = rest.join('=');
    if (!k || !v) continue;
    if (['token', 'jwt', 'accessToken', 'access_token'].includes(k)) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

const protect = (req, res, next) => {
  const authHeader = String(req.headers.authorization || req.headers.Authorization || '').trim();
  let token = null;
  if (authHeader) {
    if (/^bearer\s+/i.test(authHeader)) token = authHeader.replace(/^bearer\s+/i, '').trim();
    else token = authHeader;
  }
  if (!token && req.headers['x-access-token']) token = String(req.headers['x-access-token']).trim();
  if (!token) token = readCookieToken(req);
  if (!token) return res.status(401).json({ message: 'Not authorised' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};

module.exports = { protect, authorize };
