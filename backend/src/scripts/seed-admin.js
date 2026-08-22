require('dotenv').config();
const { prisma } = require('../lib/prisma');
const { hashPassword } = require('../lib/auth');

// İlk kurulumda tek seferlik çalıştırılır: node src/scripts/seed-admin.js
// sistem-plani.md prototipindeki varsayılan giriş (yonetici / teknonand) ile eşleşir.
async function main() {
  const username = (process.env.SEED_ADMIN_USERNAME || 'yonetici').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.error('SEED_ADMIN_PASSWORD tanımlı değil — tahmin edilebilir bir varsayılan şifreyle admin oluşturmamak için duruyoruz. .env dosyasında (veya Railway değişkenlerinde) SEED_ADMIN_PASSWORD tanımlayıp tekrar çalıştırın.');
    process.exit(1);
  }

  const existing = await prisma.employee.findUnique({ where: { username } });
  if (existing) {
    console.log(`"${username}" kullanıcısı zaten mevcut, atlanıyor.`);
    return;
  }

  await prisma.employee.create({
    data: {
      name: 'İşletme Sahibi',
      role: 'Yönetici',
      username,
      passwordHash: await hashPassword(password),
      permission: 'ADMIN',
      active: true,
    },
  });
  console.log(`Yönetici hesabı oluşturuldu: ${username} / ${password} — ilk girişten sonra şifreyi değiştirin.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
