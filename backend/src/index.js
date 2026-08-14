require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const deviceRoutes = require('./routes/devices');
const stockRoutes = require('./routes/stock');
const supplierRoutes = require('./routes/suppliers');
const dealerRoutes = require('./routes/dealers');
const employeeRoutes = require('./routes/employees');
const appointmentRoutes = require('./routes/appointments');
const trackRoutes = require('./routes/track');
const settingsRoutes = require('./routes/settings');
const reportRoutes = require('./routes/reports');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: '2mb' }));

// Genel oran sınırlama — herkese açık uçlar (randevu, takip) kötüye kullanıma karşı ayrıca sınırlanır
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/dealers', dealerRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/track', trackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/reports', reportRoutes);

app.use((req, res) => res.status(404).json({ error: 'Uç nokta bulunamadı' }));
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Teknonand API ${port} portunda çalışıyor`));
