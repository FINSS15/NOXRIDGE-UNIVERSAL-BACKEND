import multer from 'multer';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const storage = multer.memoryStorage();

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 10,
    fieldSize: 64 * 1024,
    parts: 11
  }
});

// Accept one file using the "file" field
export const uploadSingleFile = upload.single('file');

export default upload;
