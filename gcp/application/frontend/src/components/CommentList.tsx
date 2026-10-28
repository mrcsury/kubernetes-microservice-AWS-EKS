import { useState, useEffect, useCallback } from 'react';
import { commentsApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { getAvatarColor, getInitial, timeAgo } from '../lib/utils';

interface Comment {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

interface CommentListProps {
  postId: string;
}

function CommentList({ postId }: CommentListProps) {
  const { isAuthenticated, user } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [error, setError] = useState('');

  const fetchComments = useCallback(async () => {
    try {
      const response = await commentsApi.get(`/api/comments?postId=${postId}`);
      setComments(response.data);
    } catch {
      console.error('Failed to fetch comments');
    }
  }, [postId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!newComment.trim()) return;

    try {
      await commentsApi.post('/api/comments', { postId, content: newComment });
      setNewComment('');
      fetchComments();
    } catch {
      setError('Failed to add comment');
    }
  };

  const handleDelete = async (commentId: string) => {
    try {
      await commentsApi.delete(`/api/comments/${commentId}`);
      fetchComments();
    } catch {
      setError('Failed to delete comment');
    }
  };

  return (
    <div className="comments-section">
      <div className="comments-section-header">
        Comments ({comments.length})
      </div>

      {isAuthenticated && (
        <form className="comment-form" onSubmit={handleSubmit}>
          <span
            className="avatar avatar-sm"
            style={{ background: getAvatarColor(user?.name || '') }}
          >
            {getInitial(user?.name || '')}
          </span>
          <div className="comment-input-wrapper">
            {error && <div className="error-message">{error}</div>}
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Write a comment..."
            />
            {newComment.trim() && (
              <button className="btn" type="submit">
                Post
              </button>
            )}
          </div>
        </form>
      )}

      {comments.length === 0 && (
        <div className="no-comments">No comments yet. Be the first to comment!</div>
      )}

      {comments.map((comment) => (
        <div key={comment.id} className="comment">
          <span
            className="avatar avatar-sm"
            style={{ background: getAvatarColor(comment.authorName) }}
          >
            {getInitial(comment.authorName)}
          </span>
          <div className="comment-bubble">
            <div className="comment-bubble-inner">
              <div className="author-name">{comment.authorName}</div>
              <div className="content">{comment.content}</div>
            </div>
            <div className="comment-meta">
              <span>{timeAgo(comment.createdAt)}</span>
              {user && user.id === comment.authorId && (
                <button className="delete-btn" onClick={() => handleDelete(comment.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default CommentList;
