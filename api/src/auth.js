function requireApiKey(req, res, next) {
  const configured = process.env.API_KEY;
  if (!configured) {
    return res.status(500).json({ error: 'API_KEY não configurada no servidor.' });
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token !== configured) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

module.exports = { requireApiKey };
