/**
 * Express middleware: permanent redirect while preserving path suffix + query string.
 * Uses 308 so POST/PUT bodies are preserved if clients follow the redirect.
 *
 * @param {string} fromPrefix e.g. `/api/admin/finance`
 * @param {string} toPrefix e.g. `/api/finance`
 */
function redirectPreservePath(fromPrefix, toPrefix) {
  return (req, res) => {
    const tail = req.originalUrl.startsWith(fromPrefix) ? req.originalUrl.slice(fromPrefix.length) : '';
    res.redirect(308, `${toPrefix}${tail}`);
  };
}

module.exports = { redirectPreservePath };
