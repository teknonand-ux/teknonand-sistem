// Toptancı ödemesi kaydı — hem Kasa > "Gider Ekle" (routes/reports.js) hem de
// Toptancı Detay sayfasındaki "Ödeme" hareketi (routes/suppliers.js) bu ortak
// mantığı kullanır: bakiye düşer, SupplierTransaction (ODEME) oluşur, TRY
// ödemede Kasa'ya yansısın diye buna bağlı bir Expense de açılır. USD ödemeler
// Kasa'da TRY cinsinden temsil edilemediğinden Expense oluşturulmaz.
async function recordSupplierPayment(tx, { supplierId, amount, currency = 'TRY', method, description }) {
  const balanceField = currency === 'USD' ? 'currentBalanceUsd' : 'currentBalance';
  await tx.supplier.update({ where: { id: supplierId }, data: { [balanceField]: { decrement: amount } } });
  const supplierTransaction = await tx.supplierTransaction.create({
    data: { supplierId, type: 'ODEME', currency, amount, method, description },
  });
  let expense = null;
  if (currency === 'TRY') {
    expense = await tx.expense.create({
      data: {
        category: 'Toptancı Ödemesi',
        supplierId,
        amount,
        method,
        description,
        supplierTransactionId: supplierTransaction.id,
      },
    });
  }
  return { supplierTransaction, expense };
}

// Bir toptancı hareketini (ALIM veya ODEME) geri alır: bakiyeyi eski haline
// getirir, bağlı bir Expense varsa (bkz. recordSupplierPayment) onu da siler.
async function reverseSupplierTransaction(tx, supplierTx) {
  const delta = supplierTx.type === 'ALIM' ? -Number(supplierTx.amount) : Number(supplierTx.amount);
  const balanceField = supplierTx.currency === 'USD' ? 'currentBalanceUsd' : 'currentBalance';
  await tx.supplier.update({ where: { id: supplierTx.supplierId }, data: { [balanceField]: { increment: delta } } });
  await tx.expense.deleteMany({ where: { supplierTransactionId: supplierTx.id } });
  await tx.supplierTransaction.delete({ where: { id: supplierTx.id } });
}

module.exports = { recordSupplierPayment, reverseSupplierTransaction };
