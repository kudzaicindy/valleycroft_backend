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

module.exports = { upload, uploadToS3, getUploadKey };
