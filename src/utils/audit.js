const AuditLog = require('../models/AuditLog');

const logAudit = async ({
  userId,
  role,
  action,
  entity,
  entityId,
  before,
  after,
  req,
}) => {
  await AuditLog.create({
    userId,
    role,
    action,
    entity,
    entityId,
    before,
    after,
    ip: req?.ip,
    userAgent: req?.headers['user-agent'],
  });
};

module.exports = logAudit;
