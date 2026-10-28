import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { postsApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import PostCard from '../components/PostCard';
import { getAvatarColor, getInitial } from '../lib/utils';

interface Post {
  id: string;
  title: string;
  content: string;
  authorName: string;
  createdAt: string;
}

const COMMUNITY_MEMBERS = [
  'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=80&h=80&fit=crop&crop=face',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=80&h=80&fit=crop&crop=face',
  'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=80&h=80&fit=crop&crop=face',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&h=80&fit=crop&crop=face',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=80&h=80&fit=crop&crop=face',
];

function Home() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    async function fetchPosts() {
      try {
        const response = await postsApi.get('/api/posts');
        setPosts(response.data.posts);
      } catch {
        console.error('Failed to fetch posts');
      } finally {
        setLoading(false);
      }
    }
    fetchPosts();
  }, []);

  if (loading) {
    return (
      <div className="page">
        <div className="loading-spinner">
          <div className="spinner"></div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Hero Banner */}
      {!isAuthenticated && (
        <div className="hero-banner">
          <div className="hero-overlay" />
          <div className="hero-content">
            <h1 className="hero-title">Where People Connect,<br />Share & Smile Together</h1>
            <p className="hero-subtitle">
              Join thousands of people sharing stories, ideas and smiles every day.
            </p>
            <div className="hero-members">
              <div className="hero-member-avatars">
                {COMMUNITY_MEMBERS.map((src, i) => (
                  <img key={i} src={src} alt="member" className="hero-member-img" style={{ zIndex: 5 - i }} />
                ))}
              </div>
              <span className="hero-member-text">20,000+ happy members</span>
            </div>
            <div className="hero-actions">
              <Link to="/register" className="btn hero-btn-primary">Join the Community</Link>
              <Link to="/login" className="btn hero-btn-secondary">Sign In</Link>
            </div>
          </div>
        </div>
      )}

      {/* Community Vibes Strip (always visible) */}
      <div className="community-strip">
        <div className="community-strip-inner">
          <div className="community-vibe">
            <img src="https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=220&h=140&fit=crop" alt="friends" className="vibe-img" />
            <div className="vibe-label">😄 Friends Hanging Out</div>
          </div>
          <div className="community-vibe">
            <img src="https://images.unsplash.com/photo-1543269664-647b2d120e28?w=220&h=140&fit=crop" alt="smiles" className="vibe-img" />
            <div className="vibe-label">🌟 Sharing Smiles</div>
          </div>
          <div className="community-vibe">
            <img src="https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=220&h=140&fit=crop" alt="community" className="vibe-img" />
            <div className="vibe-label">💬 Real Conversations</div>
          </div>
          <div className="community-vibe">
            <img src="https://images.unsplash.com/photo-1516062423079-7ca13cdc7f5a?w=220&h=140&fit=crop" alt="together" className="vibe-img" />
            <div className="vibe-label">🤝 Growing Together</div>
          </div>
        </div>
      </div>

      <div className="page">
        {isAuthenticated && (
          <div className="create-post-prompt" onClick={() => navigate('/posts/new')}>
            <span
              className="avatar avatar-md"
              style={{ background: getAvatarColor(user?.name || '') }}
            >
              {getInitial(user?.name || '')}
            </span>
            <div className="prompt-input">What's on your mind, {user?.name}? 😊</div>
          </div>
        )}

        {posts.length === 0 ? (
          <div className="empty-state">
            <img
              src="https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=400&h=220&fit=crop"
              alt="community"
              className="empty-state-img"
            />
            <h3>No posts yet — be the first! 🎉</h3>
            <p>Share something with the community and spread some smiles.</p>
            {isAuthenticated && (
              <button className="btn" style={{ marginTop: '16px' }} onClick={() => navigate('/posts/new')}>
                Write First Post
              </button>
            )}
          </div>
        ) : (
          posts.map((post) => (
            <PostCard
              key={post.id}
              id={post.id}
              title={post.title}
              content={post.content}
              authorName={post.authorName}
              createdAt={post.createdAt}
            />
          ))
        )}
      </div>
    </>
  );
}

export default Home;
