import { Link } from 'react-router-dom';
import { getAvatarColor, getInitial, timeAgo } from '../lib/utils';

interface PostCardProps {
  id: string;
  title: string;
  content: string;
  authorName: string;
  createdAt: string;
}

const CARD_IMAGES = [
  'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=680&h=200&fit=crop',
  'https://images.unsplash.com/photo-1543269664-647b2d120e28?w=680&h=200&fit=crop',
  'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=680&h=200&fit=crop',
  'https://images.unsplash.com/photo-1516062423079-7ca13cdc7f5a?w=680&h=200&fit=crop',
  'https://images.unsplash.com/photo-1574610758902-e6c94657e0d2?w=680&h=200&fit=crop',
  'https://images.unsplash.com/photo-1491438590914-bc09fcaaf77a?w=680&h=200&fit=crop',
];

function getCardImage(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % CARD_IMAGES.length;
  return CARD_IMAGES[hash];
}

function PostCard({ id, title, content, authorName, createdAt }: PostCardProps) {
  const excerpt = content.length > 180 ? content.substring(0, 180) + '...' : content;

  return (
    <div className="post-card">
      <Link to={`/posts/${id}`} className="post-card-image-link">
        <img src={getCardImage(id)} alt="post cover" className="post-card-image" />
      </Link>
      <div className="post-card-header">
        <span
          className="avatar avatar-md"
          style={{ background: getAvatarColor(authorName) }}
        >
          {getInitial(authorName)}
        </span>
        <div className="post-card-header-info">
          <span className="author-name">{authorName}</span>
          <span className="post-time">{timeAgo(createdAt)}</span>
        </div>
      </div>
      <div className="post-card-body">
        <h2>
          <Link to={`/posts/${id}`}>{title}</Link>
        </h2>
        <div className="excerpt">{excerpt}</div>
      </div>
      <div className="post-card-footer">
        <div className="post-card-reactions">
          <span className="reaction-emoji">😊</span>
          <span className="reaction-emoji">❤️</span>
          <span className="reaction-emoji">👏</span>
        </div>
        <Link to={`/posts/${id}`} className="read-more">
          Read more →
        </Link>
      </div>
    </div>
  );
}

export default PostCard;
