import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { postsApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import CommentList from '../components/CommentList';
import { getAvatarColor, getInitial, timeAgo } from '../lib/utils';

interface Post {
  id: string;
  title: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchPost() {
      try {
        const response = await postsApi.get(`/api/posts/${id}`);
        setPost(response.data);
        setEditTitle(response.data.title);
        setEditContent(response.data.content);
      } catch {
        setError('Post not found');
      } finally {
        setLoading(false);
      }
    }

    fetchPost();
  }, [id]);

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this post?')) return;

    try {
      await postsApi.delete(`/api/posts/${id}`);
      navigate('/');
    } catch {
      setError('Failed to delete post');
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const response = await postsApi.put(`/api/posts/${id}`, {
        title: editTitle,
        content: editContent,
      });
      setPost(response.data);
      setEditing(false);
    } catch {
      setError('Failed to update post');
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading-spinner">
          <div className="spinner"></div>
        </div>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="page">
        <div className="empty-state">
          <div className="empty-icon">&#128533;</div>
          <h3>{error || 'Post not found'}</h3>
        </div>
      </div>
    );
  }

  const isAuthor = user && user.id === post.authorId;

  if (editing) {
    return (
      <div className="page">
        <div className="form-card">
          <h1 style={{ fontSize: '1.3rem', marginBottom: '20px' }}>Edit Post</h1>
          {error && <div className="error-message">{error}</div>}
          <form onSubmit={handleUpdate}>
            <div className="form-group">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="content">Content</label>
              <textarea
                id="content"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                required
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn" type="submit">
                Save Changes
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="post-detail">
        <div className="post-detail-header">
          <span
            className="avatar avatar-lg"
            style={{ background: getAvatarColor(post.authorName) }}
          >
            {getInitial(post.authorName)}
          </span>
          <div className="post-detail-header-info">
            <span className="author-name">{post.authorName}</span>
            <span className="post-time">{timeAgo(post.createdAt)}</span>
          </div>
        </div>
        <div className="post-detail-body">
          <h1>{post.title}</h1>
          <div className="content">{post.content}</div>
        </div>
        {isAuthor && (
          <div className="post-detail-actions">
            <button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn btn-sm btn-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
        )}
      </div>

      <CommentList postId={post.id} />
    </div>
  );
}

export default PostDetail;
