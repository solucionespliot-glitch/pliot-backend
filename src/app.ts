import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import ingestRouter from './routes/ingest';
import adminRouter from './routes/admin';
import commandsRouter from './routes/commands';
import dashboardControllersRouter from './routes/dashboard/controllers';
import dashboardIrrigationRouter from './routes/dashboard/irrigation';
import dashboardDevicesRouter from './routes/dashboard/devices';
import dashboardFoggersRouter from './routes/dashboard/foggers';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — only allow trusted origins from env
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. device sensors, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

// Security headers
app.use(helmet());

// General rate limit: 100 req / 15 min per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Ingestion rate limit: 300 req / 1 min per IP (devices send frequently)
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Ingestion rate limit exceeded.' },
});

app.use(generalLimiter);
app.use('/api/v5', ingestLimiter);

// Body parser with 50kb limit
app.use(express.json({ limit: '50kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v5', ingestRouter);
app.use('/api/v1.5/controllers', commandsRouter);
app.use('/dashboard/admin', adminRouter);
app.use('/dashboard/controllers', dashboardControllersRouter);
app.use('/dashboard/irrigation', dashboardIrrigationRouter);
app.use('/dashboard', dashboardDevicesRouter);
app.use('/dashboard/foggers', dashboardFoggersRouter);

// Bind to localhost only — nginx proxies from outside
app.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`Server running on 127.0.0.1:${PORT}`);
});

export default app;
