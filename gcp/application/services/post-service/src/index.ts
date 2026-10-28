import express from 'express';
import cors from 'cors';
import postsRouter from './routes/posts';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'post-service' });
});

// Routes
app.use('/api/posts', postsRouter);

app.listen(PORT, () => {
  console.log(`post-service running on port ${PORT}`);
});
