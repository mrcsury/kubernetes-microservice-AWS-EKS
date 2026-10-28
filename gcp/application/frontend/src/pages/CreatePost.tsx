import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { postsApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { getAvatarColor, getInitial } from '../lib/utils';

function CreatePost() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { user } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const response = await postsApi.post('/api/posts', { title, content });
      navigate(`/posts/${response.data.id}`);
    } catch {
      setError('Failed to create post');
    }
  };

  return (
    <div className="page">
      <div className="form-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <span
            className="avatar avatar-lg"
            style={{ background: getAvatarColor(user?.name || '') }}
          >
            {getInitial(user?.name || '')}
          </span>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Create Post</h1>
            <span style={{ color: '#65676b', fontSize: '0.85rem' }}>{user?.name}</span>
          </div>
        </div>
        {error && <div className="error-message">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <input
              id="title"
              type="text"
              placeholder="Post title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <textarea
              id="content"
              placeholder="What's on your mind?"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          </div>
          <button className="btn" type="submit" style={{ width: '100%' }}>
            Publish Post
          </button>
        </form>
      </div>
    </div>
  );
}

export default CreatePost;
