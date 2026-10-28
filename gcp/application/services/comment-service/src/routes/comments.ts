import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function getAuthorName(authorId: string): Promise<string> {
  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/api/auth/users/${authorId}`);
    return response.data.name;
  } catch {
    return 'Unknown';
  }
}

// GET /api/comments?postId=xxx
router.get('/', async (req: Request, res: Response) => {
  try {
    const { postId } = req.query;

    if (!postId) {
      res.status(400).json({ error: 'Bad Request', message: 'postId query parameter is required' });
      return;
    }

    const comments = await prisma.comment.findMany({
      where: { postId: postId as string },
      orderBy: { createdAt: 'desc' },
    });

    const commentsWithAuthors = await Promise.all(
      comments.map(async (comment) => ({
        ...comment,
        authorName: await getAuthorName(comment.authorId),
      }))
    );

    res.json(commentsWithAuthors);
  } catch (error) {
    console.error('List comments error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch comments' });
  }
});

// POST /api/comments
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { postId, content } = req.body;

    if (!postId || !content) {
      res.status(400).json({ error: 'Bad Request', message: 'postId and content are required' });
      return;
    }

    const comment = await prisma.comment.create({
      data: {
        postId,
        content,
        authorId: req.user!.id,
      },
    });

    res.status(201).json({ ...comment, authorName: req.user!.name });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create comment' });
  }
});

// DELETE /api/comments/:id
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });

    if (!comment) {
      res.status(404).json({ error: 'Not Found', message: 'Comment not found' });
      return;
    }

    if (comment.authorId !== req.user!.id) {
      res.status(403).json({ error: 'Forbidden', message: 'You can only delete your own comments' });
      return;
    }

    await prisma.comment.delete({ where: { id: req.params.id } });
    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to delete comment' });
  }
});

export default router;
