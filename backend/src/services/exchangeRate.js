// USD/TRY piyasa kurunu ücretsiz, anahtarsız kaynaklardan çeker.
// Not: Harem Altın'ın kendi canlı veri ucu (canlipiyasalar.haremaltin.com/tmp/doviz.json)
// artık herkese kapalı — site AJAX yayınını devre dışı bırakıp veriyi yalnızca özel bir
// Socket.IO kanalından ve ücretli API üzerinden sunuyor. Bu yüzden burada genel piyasa
// kuru sağlayan açık API'ler kullanılıyor; değer Harem Altın'ın satış kuruna yakın çıkar
// ama birebir aynı olmayabilir.

const PROVIDERS = [
  {
    name: 'exchangerate-api.com (open.er-api.com)',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (json) => json?.rates?.TRY,
  },
  {
    name: 'Frankfurter (ECB)',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY',
    parse: (json) => json?.rates?.TRY,
  },
];

async function fetchUsdTryRate() {
  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(provider.url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rate = provider.parse(json);
      if (!rate || Number.isNaN(Number(rate))) throw new Error('Kur alanı bulunamadı');
      return { rate: Number(rate), source: provider.name, fetchedAt: new Date().toISOString() };
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`);
    }
  }
  throw new Error(`Kur hiçbir kaynaktan alınamadı — ${errors.join(' | ')}`);
}

module.exports = { fetchUsdTryRate };
