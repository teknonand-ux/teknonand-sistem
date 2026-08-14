require('dotenv').config();
const { prisma } = require('../lib/prisma');
const { hashPassword } = require('../lib/auth');

// İlk kurulumda tek seferlik çalıştırılır: node src/scripts/seed-admin.js
// sistem-plani.md prototipindeki varsayılan giriş (yonetici / teknonand) ile eşleşir.
async function main() {
  const username = (process.env.SEED_ADMIN_USERNAME || 'yonetici').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'teknonand';

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
