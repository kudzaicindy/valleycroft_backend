/**
 * Adds flat roomName / roomType for list cards and previews when roomId is populated.
 */
function withRoomPreview(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const out = { ...booking };
  const rid = out.roomId;
  if (rid && typeof rid === 'object' && rid.name) {
    out.roomName = rid.name;
    if (rid.type != null) out.roomType = rid.type;
  }
  return out;
}

function withRoomPreviewMany(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => withRoomPreview(row));
}

module.exports = { withRoomPreview, withRoomPreviewMany };
