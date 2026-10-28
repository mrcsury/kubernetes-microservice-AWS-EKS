import express from 'express';
import cors from 'cors';
import authRouter from './routes/auth';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// Routes
app.use('/api/auth', authRouter);

app.listen(PORT, () => {
  console.log(`auth-service running on port ${PORT}`);
});
