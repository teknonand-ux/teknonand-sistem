const { prisma } = require('../lib/prisma');
const { fetchUsdTryRate } = require('./exchangeRate');

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // günde 2 kez yeterli, kaynaklar zaten günlük güncelleniyor

async function refreshExchangeRate() {
  try {
    const { rate, source, fetchedAt } = await fetchUsdTryRate();
    await prisma.appSetting.upsert({
      where: { key: 'exchangeRate' },
      update: { value: { rate, source, updatedAt: fetchedAt } },
      create: { key: 'exchangeRate', value: { rate, source, updatedAt: fetchedAt } },
    });
    console.log(`[exchangeRate] güncellendi: ${rate} (${source})`);
  } catch (e) {
    console.warn(`[exchangeRate] otomatik güncelleme başarısız, mevcut değer korunuyor: ${e.message}`);
  }
}

function startExchangeRateScheduler() {
  refreshExchangeRate();
  setInterval(refreshExchangeRate, REFRESH_INTERVAL_MS);
}

module.exports = { startExchangeRateScheduler, refreshExchangeRate };
