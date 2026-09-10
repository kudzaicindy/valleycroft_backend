const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const AWS_REGION = process.env.AWS_REGION;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME;

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp|pdf|doc|docx/;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  if (allowedTypes.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter,
});

/** Common FormData keys used by admin UIs for room gallery uploads. */
const ROOM_IMAGE_FIELD_NAMES = ['images', 'image', 'file', 'files', 'photo', 'photos'];

/**
 * Accept several multipart field names and normalize to `req.files` (array).
 * Avoids Multer "Unexpected field" when the client uses `image` / `file` / etc.
 */
const uploadRoomImagesMiddleware = (req, res, next) => {
  const handler = upload.fields(ROOM_IMAGE_FIELD_NAMES.map((name) => ({ name, maxCount: 15 })));
  handler(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
          success: false,
          message: `Unexpected field "${err.field}". Use one of: ${ROOM_IMAGE_FIELD_NAMES.join(', ')}`,
          allowedFields: ROOM_IMAGE_FIELD_NAMES,
        });
      }
      if (err instanceof multer.MulterError || err.message === 'Unexpected field') {
        return res.status(400).json({
          success: false,
          message: err.message || 'Upload failed',
          allowedFields: ROOM_IMAGE_FIELD_NAMES,
        });
      }
      return next(err);
    }
    const grouped = req.files && !Array.isArray(req.files) ? req.files : {};
    const flat = [];
    for (const name of ROOM_IMAGE_FIELD_NAMES) {
      if (Array.isArray(grouped[name])) flat.push(...grouped[name]);
    }
    if (Array.isArray(req.files)) flat.push(...req.files);
    req.files = flat.slice(0, 15);
    return next();
  });
};

const uploadToS3 = async (buffer, key, mimetype) => {
  const command = new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
  });
  await s3Client.send(command);
  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
};

const getUploadKey = (originalName, prefix = 'uploads') => {
  const ext = path.extname(originalName);
  return `${prefix}/${uuidv4()}${ext}`;
};

module.exports = {
  upload,
  uploadRoomImagesMiddleware,
  uploadToS3,
  getUploadKey,
  ROOM_IMAGE_FIELD_NAMES,
};
