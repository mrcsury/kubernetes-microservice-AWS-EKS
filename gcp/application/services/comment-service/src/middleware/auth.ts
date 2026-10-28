import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    name: string;
    email: string;
  };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
    return;
  }

  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/api/auth/me`, {
      headers: { Authorization: authHeader },
    });

    req.user = response.data;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
}
