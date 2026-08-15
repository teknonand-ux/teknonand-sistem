const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return transporter;
}

// Hata durumunda ana işlemi (ör. randevu oluşturma) etkilememesi için çağıran taraf
// bu fonksiyonu "fire-and-forget" (await'siz, .catch ile) kullanmalı.
async function sendNotificationEmail(subject, text) {
  const t = getTransporter();
  if (!t) {
    console.warn('GMAIL_USER / GMAIL_APP_PASSWORD tanımlı değil — e-posta bildirimi atlandı.');
    return;
  }
  const to = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
  await t.sendMail({ from: `Teknonand <${process.env.GMAIL_USER}>`, to, subject, text });
}

module.exports = { sendNotificationEmail };
