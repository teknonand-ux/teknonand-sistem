require('dotenv').config();
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const execFileAsync = promisify(execFile);

// Railway cron servisi olarak günlük çalışır: node src/scripts/backup-db.js
// pg_dump çıktısını gzip'leyip Storage Bucket'a yükler, eski yedekleri siler.
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const BACKUP_PREFIX = 'postgres-backups/';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL tanımlı değil');
  }

  const bucket = process.env.BUCKET;
  const endpoint = process.env.ENDPOINT;
  const region = process.env.REGION || 'auto';
  const accessKeyId = process.env.ACCESS_KEY_ID;
  const secretAccessKey = process.env.SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Bucket kimlik bilgileri eksik (BUCKET / ENDPOINT / ACCESS_KEY_ID / SECRET_ACCESS_KEY). Bu servise Storage Bucket değişken referanslarını ekleyin.'
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `teknonand-${timestamp}.sql.gz`;
  const tmpPath = path.join(os.tmpdir(), fileName);

  console.log(`[backup] pg_dump baslatiliyor -> ${tmpPath}`);
  await execFileAsync('sh', [
    '-c',
    `pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "${tmpPath}"`,
  ]);

  const stats = fs.statSync(tmpPath);
  if (!stats.size) {
    throw new Error('pg_dump çıktısı boş, yedek alınamadı');
  }
  console.log(`[backup] dump tamam (${(stats.size / 1024 / 1024).toFixed(2)} MB), bucket'a yükleniyor`);

  const s3 = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${BACKUP_PREFIX}${fileName}`,
      Body: fs.readFileSync(tmpPath),
      ContentType: 'application/gzip',
    })
  );
  fs.unlinkSync(tmpPath);
  console.log(`[backup] yüklendi: ${BACKUP_PREFIX}${fileName}`);

  await pruneOldBackups(s3, bucket);
  console.log('[backup] tamamlandı');
}

async function pruneOldBackups(s3, bucket) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: BACKUP_PREFIX })
  );
  const stale = (list.Contents || []).filter(
    (obj) => obj.LastModified && obj.LastModified.getTime() < cutoff
  );
  for (const obj of stale) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
    console.log(`[backup] eski yedek silindi: ${obj.Key}`);
  }
}

main().catch((err) => {
  console.error('[backup] HATA:', err);
  process.exitCode = 1;
});
