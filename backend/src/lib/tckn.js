// TC Kimlik No format + resmi checksum doğrulaması (Nüfus ve Vatandaşlık İşleri'nin
// yayınladığı standart algoritma). Fatura kesiminde (bkz. routes/customers.js,
// routes/devices.js invoice-draft/approve-invoice, services/odeal.js) müşteriye
// ait TC Kimlik No yanlış girilmişse bunu kaydetmeden önce yakalamak için —
// e-faturaya yanlış TCKN ile geçmesi iptal/düzeltme derdi yaratır.
function isValidTcKimlikNo(value) {
  if (!/^\d{11}$/.test(value)) return false;
  if (value[0] === '0') return false;

  const d = value.split('').map(Number);
  const sumOdd = d[0] + d[2] + d[4] + d[6] + d[8]; // 1., 3., 5., 7., 9. haneler
  const sumEven = d[1] + d[3] + d[5] + d[7]; // 2., 4., 6., 8. haneler
  const digit10 = (sumOdd * 7 - sumEven) % 10;
  if (digit10 !== d[9]) return false;

  const sumFirst10 = d.slice(0, 10).reduce((a, b) => a + b, 0);
  const digit11 = sumFirst10 % 10;
  return digit11 === d[10];
}

module.exports = { isValidTcKimlikNo };
