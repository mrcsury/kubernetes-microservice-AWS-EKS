import express from 'express';
import cors from 'cors';
import commentsRouter from './routes/comments';

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'comment-service' });
});

// Routes
app.use('/api/comments', commentsRouter);

app.listen(PORT, () => {
  console.log(`comment-service running on port ${PORT}`);
});
