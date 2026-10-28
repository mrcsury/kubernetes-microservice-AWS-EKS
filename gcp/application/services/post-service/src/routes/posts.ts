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

// GET /api/posts
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.post.count(),
    ]);

    const postsWithAuthors = await Promise.all(
      posts.map(async (post) => ({
        ...post,
        authorName: await getAuthorName(post.authorId),
      }))
    );

    res.json({
      posts: postsWithAuthors,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('List posts error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch posts' });
  }
});

// GET /api/posts/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const post = await prisma.post.findUnique({ where: { id: req.params.id } });

    if (!post) {
      res.status(404).json({ error: 'Not Found', message: 'Post not found' });
      return;
    }

    const authorName = await getAuthorName(post.authorId);
    res.json({ ...post, authorName });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch post' });
  }
});

// POST /api/posts
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      res.status(400).json({ error: 'Bad Request', message: 'Title and content are required' });
      return;
    }

    const post = await prisma.post.create({
      data: {
        title,
        content,
        authorId: req.user!.id,
      },
    });

    res.status(201).json({ ...post, authorName: req.user!.name });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create post' });
  }
});

// PUT /api/posts/:id
router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const post = await prisma.post.findUnique({ where: { id: req.params.id } });

    if (!post) {
      res.status(404).json({ error: 'Not Found', message: 'Post not found' });
      return;
    }

    if (post.authorId !== req.user!.id) {
      res.status(403).json({ error: 'Forbidden', message: 'You can only update your own posts' });
      return;
    }

    const { title, content } = req.body;
    const updated = await prisma.post.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title }),
        ...(content && { content }),
      },
    });

    res.json({ ...updated, authorName: req.user!.name });
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update post' });
  }
});

// DELETE /api/posts/:id
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const post = await prisma.post.findUnique({ where: { id: req.params.id } });

    if (!post) {
      res.status(404).json({ error: 'Not Found', message: 'Post not found' });
      return;
    }

    if (post.authorId !== req.user!.id) {
      res.status(403).json({ error: 'Forbidden', message: 'You can only delete your own posts' });
      return;
    }

    await prisma.post.delete({ where: { id: req.params.id } });
    res.json({ message: 'Post deleted' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to delete post' });
  }
});

export default router;
